const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { mockDb, loader, call, user, token } = require("./test-helpers/securityHarness");
const owner = user(), victim = user({ _id: new ObjectId("222222222222222222222222"), email: "victim@example.com" });
function setup(extra = {}) {
  const db = mockDb({ users: [owner, victim, ...(extra.users || [])], intelligence_reports: [
    { userEmail: owner.email, intelligence: { headline: "Owner report" } },
    { userEmail: victim.email, intelligence: { headline: "Victim report" } },
  ] });
  const runs = [];
  const handler = loader({ db, overrides: { "./_lib/generateDailyIntelligence": { generateDailyIntelligence: async (target, options) => { runs.push({ target, options }); return { userEmail: target }; } } } })("api/watchdog.js");
  return { handler, runs, db };
}
test("S3 rejects missing/invalid/expired/non-session credentials", async () => {
  for (const options of [{ email: null }, { bearer: "bad" }, { bearer: token(undefined, {}, { expiresIn: -1 }) }, { bearer: token(undefined, { purpose: "oauth_state" }) }]) {
    const x = setup(); assert.equal((await call(x.handler, options)).statusCode, 401); assert.equal(x.runs.length, 0); assert.equal(x.db.calls.length, 0);
  }
});
test("S3 preserves self run including consistent email, ID, query and body", async () => {
  process.env.ADMIN_EMAILS = "";
  const x = setup(); const res = await call(x.handler, { url: "/api/watchdog?email=OWNER%40example.com", query: { email: owner.email }, body: { email: owner.email, userId: owner._id, action: "run", skipFetch: true, dryRun: true, targetDate: "2026-10-28" } });
  assert.equal(res.statusCode, 200); assert.equal(x.runs.length, 1); assert.equal(x.runs[0].target, owner.email);
  assert.equal(x.runs[0].options.skipFetch, true); assert.equal(x.runs[0].options.targetDate, "2026-10-28");
});
test("S3 self latest report is restricted to canonical email", async () => {
  const x = setup(); const res = await call(x.handler, { method: "GET", url: "/api/watchdog?viewLatest=true" });
  assert.equal(res.statusCode, 200); assert.equal(res.body.report.intelligence.headline, "Owner report"); assert.equal(x.runs.length, 0);
  assert.equal(x.db.calls.find((c) => c.name === "intelligence_reports").query.userEmail, owner.email);
});
test("S3 foreign and conflicting identities never invoke pipeline or read reports", async () => {
  process.env.ADMIN_EMAILS = "";
  for (const options of [
    { body: { email: victim.email } }, { body: { userId: String(victim._id) } },
    { body: { email: owner.email, userId: String(victim._id) } },
    { url: "/api/watchdog?email=owner%40example.com", body: { userId: String(victim._id) } },
    { url: "/api/watchdog?email=owner%40example.com", body: { email: victim.email } },
    { url: "/api/watchdog?email=owner%40example.com&email=victim%40example.com" },
    { query: { userId: [owner._id, String(victim._id)] } },
    { body: { email: { $ne: null } } }, { body: { userId: "" } }, { body: { email: "invalid" } },
  ]) {
    const x = setup(); const res = await call(x.handler, options);
    assert.ok([400, 403].includes(res.statusCode), JSON.stringify(options)); assert.equal(x.runs.length, 0);
    assert.equal(x.db.calls.filter((c) => c.name === "intelligence_reports").length, 0);
  }
});
test("S3 allowlisted administrator accesses canonical target by email or ObjectId", async () => {
  process.env.ADMIN_EMAILS = owner.email;
  for (const body of [{ email: victim.email }, { userId: String(victim._id) }, { email: victim.email, userId: String(victim._id) }]) {
    const x = setup(); assert.equal((await call(x.handler, { body })).statusCode, 200); assert.equal(x.runs[0].target, victim.email);
  }
  const x = setup(); assert.equal((await call(x.handler, { body: { email: victim.email, userId: owner._id } })).statusCode, 400); assert.equal(x.runs.length, 0);
  process.env.ADMIN_EMAILS = "";
});
test("S3 administrator cannot bypass target plan restrictions", async () => {
  process.env.ADMIN_EMAILS = owner.email;
  const expired = user({ _id: "expired", email: "expired@example.com", trialEndsAt: new Date(0) });
  const x = setup({ users: [expired] }); const res = await call(x.handler, { body: { email: expired.email } });
  assert.equal(res.statusCode, 403); assert.equal(res.body.error, "plan_required"); assert.equal(x.runs.length, 0);
  process.env.ADMIN_EMAILS = "";
});
test("S3 missing account denied, preflight and unsupported methods do not execute", async () => {
  const x = setup(); assert.equal((await call(x.handler, { email: "missing@example.com" })).statusCode, 401);
  assert.equal((await call(x.handler, { method: "OPTIONS", email: null })).statusCode, 204);
  assert.equal((await call(x.handler, { method: "DELETE" })).statusCode, 405); assert.equal(x.runs.length, 0);
});
