const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { mockDb, loader, call, user, response } = require("./test-helpers/securityHarness");
function setup({ db: supplied, rejectProvider = false, owner = user() } = {}) {
  const db = supplied || mockDb({ users: owner ? [owner] : [] }); const exchanges = [];
  const handler = loader({ db, fetchFn: async (url, options) => {
    if (url.endsWith("/token")) {
      exchanges.push({ url, options });
      return response(rejectProvider ? { error: "invalid_grant" } : { access_token: "mock-access", refresh_token: "mock-refresh", scope: "openid email profile https://www.googleapis.com/auth/analytics.readonly" }, !rejectProvider);
    }
    if (url.endsWith("/userinfo")) return response({ email: "provider@example.com" });
    throw new Error("Unexpected isolated provider URL");
  } })("api/oauth.js");
  return { handler, db, exchanges };
}
async function begin(x, provider = "bing_webmaster", host = "sharflow.online") {
  const res = await call(x.handler, { method: "GET", url: "/api/oauth?action=url&provider=" + provider, headers: { host } });
  assert.equal(res.statusCode, 200);
  const state = new URL(res.body.url).searchParams.get("state");
  const cookie = "sharflow_oauth_attempt=" + encodeURIComponent(state);
  return { state, cookie, res };
}
function callback(state, cookie, extra = {}) {
  return { method: "GET", email: null, url: "/api/oauth-callback?code=mock-code" + (state ? "&state=" + encodeURIComponent(state) : ""), headers: cookie ? { cookie } : {}, ...extra };
}
test("S4 Bing matched state and cookie succeeds and stores encrypted refresh token", async () => {
  const x = setup(), flow = await begin(x); const res = await call(x.handler, callback(flow.state, flow.cookie));
  assert.equal(res.statusCode, 200); assert.equal(x.exchanges.length, 1); assert.match(res.body, /OAUTH_AUTH_SUCCESS/);
  const connection = x.db.data.datasources.find((d) => d.provider === "bing_webmaster");
  assert.equal(connection.userEmail, user().email); assert.notEqual(connection.encryptedRefreshToken, "mock-refresh");
  assert.equal(x.db.data.oauth_pending.length, 0);
});
test("S4 Bing cookie-only callback succeeds; Google requires returned state", async () => {
  const x = setup(), flow = await begin(x); assert.equal((await call(x.handler, callback(null, flow.cookie))).statusCode, 200);
  const g = setup(), google = await begin(g, "google_analytics"); assert.equal((await call(g.handler, callback(null, google.cookie))).statusCode, 400); assert.equal(g.exchanges.length, 0);
});
test("S4 Google valid callback and already-authorized direct connection remain supported", async () => {
  const x = setup(), flow = await begin(x, "google_analytics");
  assert.equal((await call(x.handler, callback(flow.state, flow.cookie))).statusCode, 200);
  const connected = await call(x.handler, { method: "GET", url: "/api/oauth?action=url&provider=google_analytics" });
  assert.equal(connected.statusCode, 200); assert.equal(connected.body.connectedDirectly, true); assert.equal(x.exchanges.length, 1);
});
test("S4 no browser cookie cannot claim the sole global pending attempt", async () => {
  const x = setup(), flow = await begin(x);
  for (const state of [null, flow.state]) assert.equal((await call(x.handler, callback(state, null))).statusCode, 400);
  assert.equal(x.exchanges.length, 0); assert.equal(x.db.data.oauth_pending.length, 1);
});
test("S4 mismatched browser state cannot claim another browser attempt", async () => {
  const x = setup(), a = await begin(x), b = await begin(x);
  assert.notEqual(a.state, b.state);
  assert.equal((await call(x.handler, callback(a.state, b.cookie))).statusCode, 400); assert.equal(x.exchanges.length, 0);
  assert.equal((await call(x.handler, callback(b.state, b.cookie))).statusCode, 200);
});
test("S4 rejects invalid signature, expiry, purpose, provider, nonce and required fields", async () => {
  for (const patch of [{ purpose: "session" }, { purpose: "paddle_checkout_link" }, { provider: "unknown" }, { nonce: "weak" }, { email: {} }, { redirectUri: "https://attacker.example/callback" }, { clientOrigin: "https://attacker.example" }, { returnUrl: null }, { exp: 1 }, { exp: undefined }, { iat: Math.floor(Date.now()/1000) + 3600 }, { exp: Math.floor(Date.now()/1000) + 9999 }]) {
    const x = setup(), flow = await begin(x), payload = { ...jwt.decode(flow.state), ...patch };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const forged = jwt.sign(payload, process.env.JWT_SECRET);
    assert.equal((await call(x.handler, callback(forged, "sharflow_oauth_attempt=" + forged))).statusCode, 400, JSON.stringify(patch)); assert.equal(x.exchanges.length, 0);
  }
  const x = setup(), f = await begin(x); const bad = f.state.slice(0, -5) + "wrong";
  assert.equal((await call(x.handler, callback(bad, "sharflow_oauth_attempt=" + bad))).statusCode, 400); assert.equal(x.exchanges.length, 0);
});
test("S4 missing/exhausted pending state and parallel replay never exchange twice", async () => {
  const x = setup(), f = await begin(x);
  const results = await Promise.all([call(x.handler, callback(f.state, f.cookie)), call(x.handler, callback(f.state, f.cookie))]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 400]); assert.equal(x.exchanges.length, 1);
  assert.equal((await call(x.handler, callback(f.state, f.cookie))).statusCode, 400);
});
test("S4 expired pending record denied even with valid signed state", async () => {
  const x = setup(), f = await begin(x); x.db.data.oauth_pending[0].expiresAt = new Date(0);
  assert.equal((await call(x.handler, callback(f.state, f.cookie))).statusCode, 400); assert.equal(x.exchanges.length, 0);
});
test("S4 pending persistence/claim failure fails closed", async () => {
  const broken = setup({ db: { collection() { throw new Error("isolated DB failure"); } } });
  const start = await call(broken.handler, { method: "GET", url: "/api/oauth?action=url&provider=bing_webmaster" });
  assert.equal(start.statusCode, 503); assert.equal(start.body.url, undefined);
  const x = setup(), f = await begin(x); x.db.collection = () => { throw new Error("isolated DB failure"); };
  assert.equal((await call(x.handler, callback(f.state, f.cookie))).statusCode, 503); assert.equal(x.exchanges.length, 0);
});
test("S4 cancellation consumes pending attempt without token exchange", async () => {
  const x = setup(), f = await begin(x);
  const res = await call(x.handler, callback(f.state, f.cookie, { url: "/api/oauth-callback?error=access_denied&state=" + f.state }));
  assert.equal(res.statusCode, 400); assert.equal(x.exchanges.length, 0); assert.equal(x.db.data.oauth_pending.length, 0);
});
test("S4 provider failure consumes attempt and requires restart", async () => {
  const x = setup({ rejectProvider: true }), f = await begin(x);
  assert.equal((await call(x.handler, callback(f.state, f.cookie))).statusCode, 500);
  assert.equal((await call(x.handler, callback(f.state, f.cookie))).statusCode, 400); assert.equal(x.exchanges.length, 1);
});
test("S4 production apex/www cookie has matching domain on creation and clearing", async () => {
  const x = setup(), f = await begin(x, "bing_webmaster", "www.sharflow.online");
  assert.match(f.res.headers["Set-Cookie"], /Domain=sharflow.online/); assert.match(f.res.headers["Set-Cookie"], /Secure/);
  const res = await call(x.handler, callback(f.state, f.cookie));
  assert.match(res.headers["Set-Cookie"], /Domain=sharflow.online/); assert.match(res.headers["Set-Cookie"], /Max-Age=0/);
});
test("S4 malformed/repeated callback parameters and unsupported provider are rejected", async () => {
  const x = setup(), f = await begin(x);
  assert.equal((await call(x.handler, callback(f.state, f.cookie, { query: { state: [f.state, "other"] } }))).statusCode, 400);
  assert.equal((await call(x.handler, { method: "GET", url: "/api/oauth?action=url&provider=unknown" })).statusCode, 400);
  assert.equal(x.exchanges.length, 0);
});
test("S4 legacy cookies cannot replace the new browser-bound attempt", async () => {
  const x = setup(), f = await begin(x);
  const legacy = "sharflow_oauth_state=" + f.state;
  assert.equal((await call(x.handler, callback(f.state, legacy))).statusCode, 400);
  assert.equal((await call(x.handler, callback(f.state, legacy + "; " + f.cookie))).statusCode, 200);
});
