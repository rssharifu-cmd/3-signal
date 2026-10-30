const jwt = require("jsonwebtoken");
const { getDb } = require("./db");
const { getEntitlements } = require("./plans");
function verified(user) { return Boolean(user?.emailVerifiedAt && user?.authVersion && user.active !== false); }
function claims(req) {
  const header = req.headers?.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  try {
    const c = jwt.verify(header.slice(7).trim(), process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (c.purpose !== "session" || typeof c.email !== "string" || typeof c.av !== "string" ||
        c.provider !== undefined || c.nonce !== undefined) return null;
    return c;
  } catch { return null; }
}
async function requireAccount(req, res, { allowReview = false } = {}) {
  const c = claims(req);
  if (!c) { res.status(401).json({ error: "reauthentication_required", message: "Please sign in again." }); return null; }
  try {
    const db = await getDb();
    const user = await db.collection("users").findOne({ email: c.email });
    if (!verified(user) || c.av !== user.authVersion) {
      res.status(401).json({ error: "verification_required", message: "Verify your email or sign in with Google." }); return null;
    }
    if (!allowReview && user.configurationReviewRequired) {
      res.status(403).json({ error: "profile_review_required", message: "Review your website profile before resuming monitoring." }); return null;
    }
    return user;
  } catch {
    res.status(503).json({ error: "Account verification temporarily unavailable." }); return null;
  }
}
function signSession(user) {
  return jwt.sign({ email: user.email, name: user.name, purpose: "session", av: user.authVersion },
    process.env.JWT_SECRET, { expiresIn: "7d", algorithm: "HS256" });
}
function publicUser(user) {
  const keys = ["_id", "email", "name", "plan", "profile", "settings", "memory", "watchdog", "trialStartedAt", "trialEndsAt",
    "subscriptionStatus", "paddleSubscriptionStatus", "paddleCurrentPeriodEnd", "configurationReviewRequired", "emailVerifiedAt"];
  return { ...Object.fromEntries(keys.filter(k => user[k] !== undefined).map(k => [k, user[k]])), entitlements: getEntitlements(user) };
}
module.exports = { verified, requireAccount, signSession, publicUser };
