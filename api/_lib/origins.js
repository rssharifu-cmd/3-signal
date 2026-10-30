const PRODUCTION_ORIGIN = "https://sharflow.online";
const STAGING_ORIGIN = "https://staging.sharflow.online";
function appOrigin() {
  const env = process.env.APP_ENV || "production";
  const allowed = env === "production" ? [PRODUCTION_ORIGIN] : env === "staging" ? [STAGING_ORIGIN] :
    env === "development" ? ["http://localhost:3000", "http://127.0.0.1:3000"] : [];
  const origin = process.env.APP_ORIGIN || allowed[0];
  if (!origin || !allowed.includes(origin)) throw new Error("Invalid application origin configuration");
  return origin;
}
function isTrustedOrigin(value) {
  try { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash &&
    u.pathname === "/" && u.origin === appOrigin(); } catch { return false; }
}
function getValidatedOrigin(value) {
  if (value && !isTrustedOrigin(value)) throw new Error("Untrusted origin");
  return appOrigin();
}
function getSafeReturnUrl(value) {
  try {
    if (typeof value !== "string" || /[\\<>"'\r\n]/.test(value)) return "/#sources";
    const u = new URL(value, appOrigin());
    if (u.origin === appOrigin() && !u.username && !u.password) return u.pathname + u.search + u.hash;
  } catch {}
  return "/#sources";
}
module.exports = { appOrigin, PRODUCTION_ORIGIN, isTrustedOrigin, getValidatedOrigin, getSafeReturnUrl };
