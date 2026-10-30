const { randomBytes, createHash } = require("crypto");
const bcrypt = require("bcryptjs");
const { OAuth2Client } = require("google-auth-library");
const { getDb } = require("./_lib/db");
const { cors } = require("./_lib/authMiddleware");
const { appOrigin } = require("./_lib/origins");
const { requireAccount, verified, signSession, publicUser } = require("./_lib/accountSecurity");
const { authLimits, WRITE } = require("./_lib/rateLimits");
const { requestVerification, completeVerification, versionFilter } = require("./_lib/emailVerification");
const GENERIC = { ok: true, verificationRequired: true, message: "If this address is eligible, check your email to verify ownership and choose a password. Existing verified users should sign in." };
function clientId() {
  const id = (process.env.GOOGLE_CLIENT_ID || "").trim();
  return id && !id.endsWith(".apps.googleusercontent.com") ? id + ".apps.googleusercontent.com" : id;
}
module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  const url = new URL(req.url || "/api/auth", "https://sharflow.online");
  if (req.method === "GET" && (req.query?.action || url.searchParams.get("action")) === "config") {
    return res.status(200).json({ ok: true, googleClientId: clientId() || null, appOrigin: appOrigin(),
      paddle: { env: process.env.PADDLE_ENV || "live", clientToken: process.env.PADDLE_CLIENT_TOKEN || null,
        defaultPriceId: process.env.PADDLE_PRICE_ID_PRO || "pri_01m4tf8w6602rpfrhv9mbrcm7b" } });
  }
  if (req.method === "GET") {
    const user = await requireAccount(req, res, { allowReview: true });
    return user ? res.status(200).json({ ok: true, user: publicUser(user) }) : undefined;
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "Invalid request" });
    const action = body.action;
    if (!["signup", "request_verification", "complete_verification", "google", "login"].includes(action)) return res.status(400).json({ error: "Unknown action" });
    const db = await getDb(), users = db.collection("users");
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (["signup", "request_verification", "login"].includes(action) && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) return res.status(400).json({ error: "A valid email is required" });
    await authLimits(db, req, action, email);
    if (action === "signup" || action === "request_verification") {
      if (process.env.EMAIL_DELIVERY_MODE !== "resend" || !process.env.RESEND_API_KEY) return res.status(503).json({ error: "Verification delivery is not enabled." });
      await requestVerification(db, email);
      return res.status(202).json(GENERIC);
    }
    if (action === "complete_verification") {
      const user = await completeVerification(db, body.token, body.password);
      if (!user) return res.status(400).json({ error: "Invalid/expired link, or password must be 12+ characters and at most 72 UTF-8 bytes." });
      return res.status(200).json({ ok: true, token: signSession(user), user: publicUser(user) });
    }
    if (action === "login") {
      if (typeof body.password !== "string" || Buffer.byteLength(body.password) > 72) return res.status(401).json({ error: "Invalid email or password" });
      const user = await users.findOne({ email });
      // Unknown/unverified accounts still execute a password comparison; no auto-send on login.
      const match = await bcrypt.compare(body.password, user?.passwordHash || "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy");
      if (!match) return res.status(401).json({ error: "Invalid email or password" });
      if (!verified(user)) return res.status(401).json({ error: "verification_required", message: "Sign in with Google or request an ownership verification link." });
      return res.status(200).json({ ok: true, token: signSession(user), user: publicUser(user) });
    }
    if (typeof body.credential !== "string" || body.credential.length > 16384 || !clientId()) return res.status(401).json({ error: "Invalid Google credential" });
    let identity;
    try {
      const ticket = await new OAuth2Client(clientId()).verifyIdToken({ idToken: body.credential, audience: clientId() });
      identity = ticket.getPayload();
    } catch { return res.status(401).json({ error: "Invalid Google credential" }); }
    if (!identity?.email_verified || identity.email_verified !== true || typeof identity.email !== "string" || typeof identity.sub !== "string" || !identity.sub) return res.status(401).json({ error: "Google email must be verified" });
    const googleEmail = identity.email.trim().toLowerCase();
    let user = await users.findOne({ email: googleEmail });
    // An established provider identity must never be replaced by an email match, even during migration.
    if (user?.googleSub && user.googleSub !== identity.sub) return res.status(403).json({ error: "Account requires support review" });
    if (user?.active === false) return res.status(403).json({ error: "Account requires support review" });
    // Google is authoritative for Gmail and verified Workspace addresses, not unmanaged third-party mail.
    const authoritativeEmail = googleEmail.endsWith("@gmail.com") ||
      (typeof identity.hd === "string" && Boolean(identity.hd.trim()));
    const establishedLogin = verified(user) && user.googleSub === identity.sub;
    if (!authoritativeEmail && !establishedLogin) {
      const inboxAge = Date.now() - new Date(user?.inboxVerifiedAt || 0).getTime();
      if (!verified(user) || !Number.isFinite(inboxAge) || inboxAge < 0 || inboxAge > 30 * 60000 || !req.headers?.authorization) {
        return res.status(401).json({ error: "verification_required", message: "Verify your inbox using the email signup flow, then retry Google while signed in. Existing users can sign in with their password." });
      }
      const account = await requireAccount(req, res, { allowReview: true });
      if (!account) return;
      if (String(account._id) !== String(user._id)) return res.status(403).json({ error: "Account ownership mismatch" });
    }
    if (!user) {
      const _id = "enrollment:" + createHash("sha256").update(googleEmail).digest("hex");
      try { await users.updateOne({ _id }, { $setOnInsert: { email: googleEmail, active: true, plan: "starter", createdAt: new Date(), profile: null } }, { upsert: true, writeConcern: WRITE }); }
      catch (err) { if (err.code !== 11000 || !err.keyPattern?._id) throw err; }
      user = await users.findOne({ _id });
    }
    if (!user || user.active === false || (user.googleSub && user.googleSub !== identity.sub)) return res.status(403).json({ error: "Account requires support review" });
    const claiming = !verified(user), now = new Date();
    const fields = { googleSub: identity.sub, name: identity.name || user.name || "", lastLoginAt: now, updatedAt: now };
    if (claiming) Object.assign(fields, { passwordHash: "", authProvider: "google", emailVerifiedAt: now,
      authVersion: randomBytes(24).toString("hex"), configurationReviewRequired: Boolean(user.profile), integrationResetAt: now,
      trialStartedAt: user.trialStartedAt || now, trialEndsAt: user.trialEndsAt || new Date(now.getTime() + 14 * 86400000) });
    else fields.authProvider = user.passwordHash ? "both" : "google";
    const updated = await users.findOneAndUpdate({ _id: user._id, authVersion: versionFilter(user),
      // Two concurrent first links must not both replace an absent binding.
      googleSub: user.googleSub === undefined ? { $exists: false } : user.googleSub,
    }, {
      $set: fields, ...(claiming ? { $unset: { verification: "", pendingPaddleCheckoutToken: "" } } : {}),
    }, { returnDocument: "after", includeResultMetadata: false, writeConcern: WRITE });
    if (!updated) return res.status(409).json({ error: "Account changed. Please sign in again." });
    return res.status(200).json({ ok: true, token: signSession(updated), user: publicUser(updated) });
  } catch (err) {
    if (err.status === 429) { res.setHeader("Retry-After", String(err.retryAfter)); return res.status(429).json({ error: err.message }); }
    return res.status(503).json({ error: "Authentication temporarily unavailable. Please try again." });
  }
};
