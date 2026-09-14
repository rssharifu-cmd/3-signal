const jwt = require("jsonwebtoken");

const PRODUCTION_ORIGIN = "https://sharflow.online";

/**
 * Validates whether a candidate origin string is an authorized origin.
 * Strictly permits:
 * - Production domain: https://sharflow.online, https://www.sharflow.online
 * - Associated brand domain: https://sharflow.com, https://www.sharflow.com
 * - Configured APP_URL environment variable (if explicitly set)
 * - Local development: http://localhost:[port], http://127.0.0.1:[port]
 * - Preview / staging containers: https://*.run.app, https://*.vercel.app
 * Rejects all arbitrary external origins.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isTrustedOrigin(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  try {
    const parsed = new URL(candidate.trim());
    const protocol = parsed.protocol;
    const hostname = parsed.hostname.toLowerCase();

    // Local development allows http or https
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return protocol === "http:" || protocol === "https:";
    }

    // External origins must use https
    if (protocol !== "https:") {
      return false;
    }

    // Production domain
    if (hostname === "sharflow.online" || hostname === "www.sharflow.online") {
      return true;
    }

    // Brand domain
    if (hostname === "sharflow.com" || hostname === "www.sharflow.com") {
      return true;
    }

    // Configured APP_URL if valid
    if (process.env.APP_URL) {
      try {
        const appUrlParsed = new URL(process.env.APP_URL);
        if (hostname === appUrlParsed.hostname.toLowerCase()) return true;
      } catch {}
    }

    // Google Cloud Run development/preview containers
    if (hostname === "run.app" || hostname.endsWith(".run.app")) {
      return true;
    }

    // Vercel preview deployments
    if (hostname === "vercel.app" || hostname.endsWith(".vercel.app")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Returns a strictly validated origin string.
 * Never returns an untrusted or arbitrary external origin.
 *
 * @param {string} candidate
 * @param {object} [req]
 * @returns {string}
 */
function getValidatedOrigin(candidate, req) {
  if (candidate && isTrustedOrigin(candidate)) {
    try {
      return new URL(candidate.trim()).origin;
    } catch {}
  }

  // Fallback to request host if request is from a trusted host
  if (req) {
    const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "";
    const proto = req.headers?.["x-forwarded-proto"] || "https";
    if (host) {
      const candidateHostOrigin = `${proto}://${host}`;
      if (isTrustedOrigin(candidateHostOrigin)) {
        try {
          return new URL(candidateHostOrigin).origin;
        } catch {}
      }
    }
  }

  return PRODUCTION_ORIGIN || "https://sharflow.online";
}

/**
 * Prevents open redirect attacks by sanitizing return URLs.
 * Ensures the destination is either a safe relative path or belongs to the validated origin.
 *
 * @param {string} rawUrl
 * @param {string} validatedOrigin
 * @returns {string}
 */
function getSafeReturnUrl(rawUrl, validatedOrigin) {
  if (!rawUrl || typeof rawUrl !== "string") return "/";
  const trimmed = rawUrl.trim();

  // Safe relative paths starting with single '/' and not '//'
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.includes("\\") && !trimmed.includes(":")) {
    return trimmed;
  }

  // Absolute URL matching validated origin
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin === validatedOrigin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {}

  return "/";
}

function cors(req, res) {
  const origin = req.headers?.origin || "";

  if (origin && isTrustedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    res.setHeader("Access-Control-Allow-Origin", PRODUCTION_ORIGIN || "https://sharflow.online");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function extractEmail(req) {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) return null;
  const header = req.headers?.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  try {
    const decoded = jwt.verify(token, secret);
    return decoded.email || null;
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

