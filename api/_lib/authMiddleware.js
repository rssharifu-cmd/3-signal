const jwt = require("jsonwebtoken");

const { PRODUCTION_ORIGIN, isTrustedOrigin, getValidatedOrigin, getSafeReturnUrl } = require("./origins");
function cors(req, res) {
  res.setHeader("Vary", "Origin");
  const origin = req.headers?.origin;
  if (origin && !isTrustedOrigin(origin)) { res.status(403).json({ error: "Untrusted origin" }); return true; }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return false;
}

function extractEmail(req) {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) return null;
  const header = req.headers?.authorization || "";
  if (typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    // Sessions require an explicit purpose and account-version claim.
    if (!decoded || typeof decoded.email !== "string" || !decoded.email.trim() ||
        (decoded.purpose !== "session" || typeof decoded.av !== "string") ||
        decoded.provider !== undefined || decoded.nonce !== undefined || decoded.redirectUri !== undefined) return null;
    return decoded.email.trim().toLowerCase();
  } catch {
    return null;
  }
}

module.exports = {
  cors,
  extractEmail,
  isTrustedOrigin,
  getValidatedOrigin,
  getSafeReturnUrl,
  PRODUCTION_ORIGIN,
};

