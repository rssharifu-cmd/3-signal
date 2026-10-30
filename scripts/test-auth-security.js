const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mockDb, loader, call, user, token } = require("./test-helpers/securityHarness");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

for (const fixture of [{ passwordHash: "", googleSub: "verified-google" }, { passwordHash: "" }, { passwordHash: "existing-hash" }]) {
  test("S1 existing account signup cannot set password: " + JSON.stringify(fixture), async () => {
    const existing = user(fixture), db = mockDb({ users: [existing] });
    const res = await call(loader({ db })("api/auth.js"), { body: { action: "signup", email: " OWNER@EXAMPLE.COM ", password: "attacker-password", name: "Attacker" } });
    assert.equal(res.statusCode, 409); assert.equal(res.body.token, undefined);
    assert.deepEqual(db.data.users, [existing]);
    assert.equal(db.calls.filter((c) => c.op !== "findOne").length, 0);
  });
}
test("S1 new signup, correct password login, wrong password denial and session verification", async () => {
  const db = mockDb(); const auth = loader({ db })("api/auth.js");
  const signup = await call(auth, { body: { action: "signup", email: "new@example.com", password: "safe-test-password", name: "New" } });
  assert.equal(signup.statusCode, 201); assert.equal(signup.body.user.passwordHash, undefined);
  assert.equal(jwt.verify(signup.body.token, process.env.JWT_SECRET).purpose, "session");
  assert.ok(await bcrypt.compare("safe-test-password", db.data.users[0].passwordHash));
  const login = await call(auth, { body: { action: "login", email: "new@example.com", password: "safe-test-password" } });
  assert.equal(login.statusCode, 200);
  const wrong = await call(auth, { body: { action: "login", email: "new@example.com", password: "wrong-password" } });
  assert.equal(wrong.statusCode, 401);
  const verify = await call(auth, { method: "GET", bearer: login.body.token }); assert.equal(verify.statusCode, 200);
});
test("S1 Google-only login directs to Google, legacy passwordless directs to support", async () => {
  for (const extra of [{ passwordHash: "", googleSub: "google" }, { passwordHash: "" }]) {
    const res = await call(loader({ db: mockDb({ users: [user(extra)] }) })("api/auth.js"), { body: { action: "login", email: "owner@example.com", password: "unused-password" } });
    assert.equal(res.statusCode, 401); assert.doesNotMatch(res.body.error, /Create account/);
    assert.match(res.body.error, extra.googleSub ? /sign in with Google/ : /recovery assistance/);
  }
});
test("S1 verified Google sign-in preserves existing profile and password", async () => {
  const existing = user({ passwordHash: "preserved-hash" }), db = mockDb({ users: [existing] });
  class OAuth2Client { async verifyIdToken() { return { getPayload: () => ({ email: existing.email, email_verified: true, sub: "google-sub", name: "Google name" }) }; } }
  const res = await call(loader({ db, overrides: { "google-auth-library": { OAuth2Client } } })("api/auth.js"), { body: { action: "google", credential: "mock-google-credential" } });
  assert.equal(res.statusCode, 200); assert.ok(res.body.token);
  assert.deepEqual(db.data.users[0].profile, existing.profile);
  assert.equal(db.data.users[0].passwordHash, "preserved-hash"); assert.equal(db.data.users[0].authProvider, "both");
});
test("S1 unverified Google identity is denied", async () => {
  const db = mockDb();
  class OAuth2Client { async verifyIdToken() { return { getPayload: () => ({ email: "owner@example.com", email_verified: false }) }; } }
  const res = await call(loader({ db, overrides: { "google-auth-library": { OAuth2Client } } })("api/auth.js"), { body: { action: "google", credential: "mock" } });
  assert.equal(res.statusCode, 401); assert.equal(db.calls.length, 0);
});
test("Session purpose checks reject OAuth/checkout tokens and retain legacy login sessions", async () => {
  const db = mockDb({ users: [user()] }); const load = loader({ db });
  for (const purpose of ["oauth_state", "paddle_checkout_link"]) {
    for (const file of ["api/auth.js", "api/user.js"]) {
      const res = await call(load(file), { method: "GET", bearer: token("owner@example.com", { purpose }) });
      assert.equal(res.statusCode, 401, file + " " + purpose);
    }
  }
  for (const file of ["api/auth.js", "api/user.js"]) assert.equal((await call(load(file), { method: "GET" })).statusCode, 200);
});
test("Legacy OAuth state without purpose cannot be reused as a login session", async () => {
  const load = loader({ db: mockDb({ users: [user()] }) });
  const state = token(undefined, { provider: "bing_webmaster", nonce: "old-state", redirectUri: "https://sharflow.online/api/oauth-callback" });
  for (const file of ["api/user.js", "api/send.js", "api/watchdog.js"]) {
    assert.equal((await call(load(file), { method: "POST", bearer: state, body: { action: "welcome" } })).statusCode, 401);
  }
  assert.equal((await call(load("api/auth.js"), { method: "GET", bearer: state })).statusCode, 401);
});
