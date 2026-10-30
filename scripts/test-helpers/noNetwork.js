// Preload for isolated suites. Never load .env or inherit live service credentials.
for (const key of Object.keys(process.env)) {
  if (/MONGODB|RESEND|GEMINI|TAVILY|GOOGLE_CLIENT|BING_CLIENT|PADDLE|JWT_SECRET|OAUTH_TOKEN|EMAIL_FROM|FROM_EMAIL|ADMIN_EMAILS|PLANS_ENFORCED|ALLOW_PROD_TEST/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: "phase1-isolated-test-signing-key-not-a-live-secret",
  OAUTH_TOKEN_ENCRYPTION_KEY: "phase1-isolated-encryption-test-key",
  GOOGLE_CLIENT_ID: "isolated-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "isolated-google-secret",
  BING_CLIENT_ID: "isolated-bing-client",
  BING_CLIENT_SECRET: "isolated-bing-secret",
  RESEND_API_KEY: "isolated-no-network-key",
  PLANS_ENFORCED: "true",
});
function blocked() { throw new Error("Network access blocked in isolated tests"); }
global.fetch = blocked;
require("net").Socket.prototype.connect = blocked;
require("tls").connect = blocked;
for (const protocol of ["http", "https"]) {
  require(protocol).request = blocked;
  require(protocol).get = blocked;
}
require("module").syncBuiltinESMExports();
