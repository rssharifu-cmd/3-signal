const { randomBytes, createHash } = require("crypto");
const bcrypt = require("bcryptjs");
const { WRITE } = require("./rateLimits");
const { appOrigin } = require("./origins");
const { claimEmailSend } = require("./emailSendGuard");
const { verified } = require("./accountSecurity");
const hash = value => createHash("sha256").update(value).digest("hex");
function passwordValid(value) { return typeof value === "string" && value.length >= 12 && Buffer.byteLength(value, "utf8") <= 72; }
function versionFilter(user) { return user.authVersion ? user.authVersion : { $exists: false }; }
async function requestVerification(db, email) {
  // A stable new-account ID also serializes concurrent enrollment without creating indexes.
  const users = db.collection("users");
  let user = await users.findOne({ email });
  if (!user) {
    const _id = "enrollment:" + hash(email);
    await users.updateOne({ _id }, { $setOnInsert: { email, name: "", passwordHash: "", active: true,
      plan: "starter", profile: null, createdAt: new Date() } }, { upsert: true, writeConcern: WRITE });
    user = await users.findOne({ _id });
  }
  if (!user || verified(user) || user.emailVerifiedAt || user.active === false) return;
  if (process.env.EMAIL_DELIVERY_MODE !== "resend") throw new Error("Delivery disabled");
  const guard = await claimEmailSend(db, "verification:" + hash(email));
  if (!guard.allowed) return;
  const raw = randomBytes(32).toString("hex");
  const updated = await users.updateOne({ _id: user._id, authVersion: versionFilter(user), emailVerifiedAt: { $exists: false } },
    { $set: { verification: { hash: hash(raw), expiresAt: new Date(Date.now() + 30 * 60000) } } }, { writeConcern: WRITE });
  if (updated.matchedCount !== 1) return;
  const url = appOrigin() + "/#verify=" + raw;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.RESEND_API_KEY,
      "Idempotency-Key": "verification-" + hash(raw) },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || "Sharflow <hello@sharflow.online>", to: [email],
      subject: "Verify your Sharflow email address", text: "To verify your address and choose your password, open " + url +
      "\nThis link expires in 30 minutes. If you did not request it, ignore this message." }),
  });
  if (!response.ok) throw new Error("Verification delivery unavailable");
}
async function completeVerification(db, raw, password) {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw) || !passwordValid(password)) return null;
  const users = db.collection("users"), now = new Date();
  const query = { "verification.hash": hash(raw), "verification.expiresAt": { $gt: now }, emailVerifiedAt: { $exists: false }, active: { $ne: false } };
  const pending = await users.findOne(query);
  if (!pending) return null;
  const passwordHash = await bcrypt.hash(password, 10);
  return users.findOneAndUpdate({ ...query, _id: pending._id, authVersion: versionFilter(pending) }, {
    $set: { passwordHash, emailVerifiedAt: now, authVersion: randomBytes(24).toString("hex"), authProvider: "password",
      configurationReviewRequired: Boolean(pending.profile), integrationResetAt: now,
      trialStartedAt: pending.trialStartedAt || now, trialEndsAt: pending.trialEndsAt || new Date(now.getTime() + 14 * 86400000), updatedAt: now },
    $unset: { verification: "", pendingPaddleCheckoutToken: "" },
  }, { returnDocument: "after", includeResultMetadata: false, writeConcern: WRITE });
}
module.exports = { requestVerification, completeVerification, passwordValid, versionFilter };
