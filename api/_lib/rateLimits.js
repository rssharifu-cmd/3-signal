const { createHmac } = require("crypto");
const { isIP } = require("net");
const WRITE = { w: "majority", wtimeoutMS: 5000 };
class RateLimitError extends Error { constructor(seconds) { super("Too many attempts. Please try again later."); this.status = 429; this.retryAfter = seconds; } }
function digest(value) {
  if (!process.env.JWT_SECRET) throw new Error("Rate limit key unavailable");
  return createHmac("sha256", process.env.JWT_SECRET).update("ratelimit:" + value).digest("hex");
}
function clientIp(req) {
  // Opt-in only after the hosting proxy's overwrite behavior is verified. Never use arbitrary XFF.
  const value = process.env.TRUST_VERCEL_IP === "true" && process.env.VERCEL === "1"
    ? req.headers?.["x-vercel-forwarded-for"] : req.socket?.remoteAddress;
  return typeof value === "string" && isIP(value) ? value : "unknown";
}
async function limit(db, label, identity, maximum, seconds, now = new Date()) {
  const bucket = Math.floor(now.getTime() / (seconds * 1000));
  const _id = label + ":" + digest(identity) + ":" + bucket;
  let doc;
  try {
    doc = await db.collection("auth_rate_limits").findOneAndUpdate({ _id }, {
      $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * seconds * 1000) },
    }, { upsert: true, returnDocument: "after", includeResultMetadata: false, writeConcern: WRITE });
  } catch (err) {
    if (err.code !== 11000 || !err.keyPattern?._id) throw err;
    doc = await db.collection("auth_rate_limits").findOneAndUpdate({ _id }, { $inc: { count: 1 } },
      { returnDocument: "after", includeResultMetadata: false, writeConcern: WRITE });
  }
  if (!doc || !Number.isFinite(doc.count)) throw new Error("Rate limit store unavailable");
  if (doc.count > maximum) throw new RateLimitError(Math.max(1, Math.ceil(((bucket + 1) * seconds * 1000 - now.getTime()) / 1000)));
}
async function authLimits(db, req, action, email = "") {
  const ip = clientIp(req);
  if (["signup", "request_verification"].includes(action)) {
    await limit(db, "enroll-ip-hour", ip, 5, 3600); await limit(db, "enroll-ip-day", ip, 20, 86400);
    await limit(db, "verify-address-minute", email, 1, 60);
    await limit(db, "verify-address-hour", email, 3, 3600); await limit(db, "verify-address-day", email, 5, 86400);
    await limit(db, "verify-budget", "deployment", 100, 3600);
  } else if (action === "login") {
    await limit(db, "login-ip", ip, 50, 900);
    await limit(db, "login-pair", ip + ":" + email, 5, 900);
    await limit(db, "login-account", email, 20, 900);
  } else await limit(db, "auth-" + action, ip, 20, 900);
}
module.exports = { limit, authLimits, clientIp, WRITE };
