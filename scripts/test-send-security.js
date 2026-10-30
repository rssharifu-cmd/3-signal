const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mockDb, loader, call, user, token, response } = require("./test-helpers/securityHarness");
const { claimEmailSend } = require("../api/_lib/emailSendGuard");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT } = require("./test-helpers/securityHarness");
const reportId = "aaaaaaaaaaaaaaaaaaaaaaaa";
function setup({ owner = user(), report = {}, db: suppliedDb, fetchFn } = {}) {
  const db = suppliedDb || mockDb({ users: owner ? [owner] : [], intelligence_reports: [{ reportId, userId: "111111111111111111111111", userEmail: "owner@example.com", status: "stable", intelligence: { headline: "Server-stored headline" }, ...report }] });
  const sent = [];
  const handler = loader({ db, fetchFn: fetchFn || (async (url, options) => { sent.push({ url, ...options, payload: JSON.parse(options.body) }); return response({ id: "mock-message" }); }) })("api/send.js");
  return { db, handler, sent };
}
test("S2 denies missing, invalid, expired and non-session credentials before DB/provider access", async () => {
  for (const options of [{ email: null }, { bearer: "invalid" }, { bearer: token(undefined, {}, { expiresIn: -1 }) }, { bearer: token(undefined, { purpose: "oauth_state" }) }, { bearer: token(undefined, { purpose: "paddle_checkout_link" }) }]) {
    const { db, handler, sent } = setup();
    assert.equal((await call(handler, { ...options, body: { action: "watchdog_report", reportId } })).statusCode, 401);
    assert.equal(db.calls.length, 0); assert.equal(sent.length, 0);
  }
});
test("S2 rejects recipient and content overrides", async () => {
  for (const extra of [{ email: "victim@example.com" }, { name: "Fake" }, { report: {} }, { websiteUrl: "https://fake.example" }, { profileSummary: "fake" }]) {
    const { handler, sent } = setup();
    assert.equal((await call(handler, { body: { action: "welcome", ...extra } })).statusCode, 400); assert.equal(sent.length, 0);
  }
});
test("S2 own report and digest alias use saved evidence and session recipient", async () => {
  for (const action of ["watchdog_report", "digest"]) {
    const { handler, sent, db } = setup(); const res = await call(handler, { body: { action, reportId } });
    assert.equal(res.statusCode, 200); assert.deepEqual(sent[0].payload.to, ["owner@example.com"]);
    assert.match(sent[0].payload.html, /Server-stored headline/); assert.match(sent[0].headers["Idempotency-Key"], /^browser-email-/);
    const lookup = db.calls.find((c) => c.name === "intelligence_reports"); assert.equal(lookup.query.userEmail, "owner@example.com");
  }
});
test("S2 rejects foreign owner, inconsistent user ID and nonexistent saved report", async () => {
  for (const report of [{ userEmail: "victim@example.com" }, { userId: "victim-id" }, { reportId: "bbbbbbbbbbbbbbbbbbbbbbbb" }]) {
    const { handler, sent } = setup({ report });
    assert.equal((await call(handler, { body: { action: "watchdog_report", reportId } })).statusCode, 404); assert.equal(sent.length, 0);
  }
});
test("S2 rejects malformed IDs and unsupported actions", async () => {
  for (const body of [{ reportId: { $ne: null } }, { reportId: "bad" }, { action: "spam" }]) {
    const { handler, sent } = setup(); assert.equal((await call(handler, { body })).statusCode, 400); assert.equal(sent.length, 0);
  }
});
test("S2 welcome loads saved profile; missing profile, inactive/missing account denied", async () => {
  const { handler, sent } = setup(); assert.equal((await call(handler, { body: { action: "welcome" } })).statusCode, 200);
  assert.match(sent[0].payload.html, /Saved profile/); assert.match(sent[0].payload.html, /store.example/);
  for (const owner of [null, user({ active: false }), user({ profile: null })]) {
    const x = setup({ owner }); assert.ok([400, 401, 403].includes((await call(x.handler, { body: { action: "welcome" } })).statusCode)); assert.equal(x.sent.length, 0);
  }
});
test("S2 enforced expired plan cannot email reports", async () => {
  const { handler, sent } = setup({ owner: user({ trialEndsAt: new Date(0) }) });
  const res = await call(handler, { body: { reportId } }); assert.equal(res.statusCode, 403); assert.equal(res.body.error, "plan_required"); assert.equal(sent.length, 0);
});
test("S2 database failure fails closed", async () => {
  const { handler, sent } = setup({ db: { collection() { throw new Error("isolated DB failure"); } } });
  assert.equal((await call(handler, { body: { reportId } })).statusCode, 503); assert.equal(sent.length, 0);
});
test("S2 simultaneous requests share one account cooldown", async () => {
  const { handler, sent } = setup(); const results = await Promise.all([call(handler, { body: { reportId } }), call(handler, { body: { action: "welcome" } })]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 429]); assert.equal(sent.length, 1);
  assert.equal(results.find((r) => r.statusCode === 429).headers["Retry-After"], "60");
});
test("S2 provider failure is honest and retains cooldown; elapsed cooldown allows another attempt", async () => {
  const { handler, db } = setup({ fetchFn: async () => response({ message: "rejected" }, false) });
  assert.equal((await call(handler, { body: { reportId } })).statusCode, 503);
  assert.equal((await call(handler, { body: { reportId } })).statusCode, 429);
  const guard = db.data.email_send_guards[0];
  assert.equal((await claimEmailSend(db, user()._id, new Date(guard.nextAllowedAt.getTime() + 1))).allowed, true);
});
test("S2 internal helper accepts scheduler call shape without JWT and rejects recipient mismatch", async () => {
  const { handler, sent } = setup();
  const report = { reportId, userEmail: "owner@example.com", status: "stable", findings: [] };
  await handler.sendWatchdogEmail({ toEmail: report.userEmail, userName: "Owner", report, entitlements: { enforced: true, canRunMonitoring: true } });
  assert.equal(sent.length, 1);
  await assert.rejects(handler.sendWatchdogEmail({ toEmail: "victim@example.com", report }), /recipient/); assert.equal(sent.length, 1);
});
test("S2 internal helper resolves owner entitlements and fails closed for missing/expired owners", async () => {
  const report = { userEmail: "owner@example.com", findings: [] };
  const good = setup(); await good.handler.sendWatchdogEmail({ toEmail: report.userEmail, report }); assert.equal(good.sent.length, 1);
  for (const owner of [null, user({ trialEndsAt: new Date(0) })]) {
    const x = setup({ owner }); await assert.rejects(x.handler.sendWatchdogEmail({ toEmail: report.userEmail, report })); assert.equal(x.sent.length, 0);
  }
});

function frontend(saveOk = true) {
  const source = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
  const requests = [], notices = [];
  const saved = { signal_email: "owner@example.com", signal_token: "mock-session" };
  const report = { reportId, userEmail: "owner@example.com" };
  const context = vm.createContext({
    console: { warn() {} }, Date, Intl,
    STORAGE: { email: "signal_email", token: "signal_token", profileForm: "form", profile: "profile", lastWatchdogReport: "lastReport", plan: "plan" },
    localStorage: { getItem: (key) => saved[key] || null, setItem: (key, val) => { saved[key] = val; } },
    window: { _lastWatchdogReport: report }, document: { getElementById: () => null },
    onboardingData: { websiteUrl: "https://store.example", monitoringPriorities: [] },
    buildWebsiteSummaryText: () => "Saved summary", getSavedForm: () => ({}), getUserName: () => "Owner",
    authHeaders: () => ({ Authorization: "Bearer mock-session" }),
    toast: (msg) => notices.push(msg), showDashboard() {}, dashNav() {},
    fetch: async (url, options) => { requests.push({ url, ...options, payload: JSON.parse(options.body) }); return response({}, url !== "/api/user" || saveOk); },
  });
  for (const [name, next] of [["submitWebsiteOnboarding", "digestLengthToTone"], ["sendDigestEmail", "exportReportCSV"]]) {
    const start = source.indexOf("async function " + name + "(");
    const end = source.indexOf("function " + next + "(", start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end), context);
  }
  return { context, requests, notices };
}
test("S2 actual frontend welcome caller authenticates and sends only action after profile save", async () => {
  const x = frontend(); await x.context.submitWebsiteOnboarding();
  const sent = x.requests.find((r) => r.url === "/api/send"); assert.ok(sent);
  assert.equal(sent.headers.Authorization, "Bearer mock-session"); assert.deepEqual(JSON.parse(sent.body), { action: "welcome" });
  const failed = frontend(false); await failed.context.submitWebsiteOnboarding(); assert.equal(failed.requests.filter((r) => r.url === "/api/send").length, 0);
});
test("S2 actual frontend report caller authenticates and sends stored report identifier only", async () => {
  const x = frontend(); await x.context.sendDigestEmail(); const sent = x.requests[0];
  assert.equal(sent.headers.Authorization, "Bearer mock-session"); assert.deepEqual(JSON.parse(sent.body), { action: "watchdog_report", reportId });
});
test("S2 actual scheduler processUser sends owned report through direct helper", async () => {
  const x = setup(), source = fs.readFileSync(path.join(ROOT, "scripts/run-watchdog-scheduler.js"), "utf8");
  const start = source.indexOf("async function processUser("), end = source.indexOf("async function run()", start);
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date, process: { env: { RESEND_API_KEY: "isolated" } },
    verified: u => Boolean(u.emailVerifiedAt && u.authVersion && u.active !== false),
    ensureTrial: async () => {}, getEntitlements: () => ({ enforced: true, canRunMonitoring: true }),
    generateDailyIntelligence: async () => ({ reportId, userEmail: "owner@example.com", findings: [] }),
    sendWatchdogEmail: x.handler.sendWatchdogEmail,
  });
  vm.runInContext(source.slice(start, end), context);
  for (const denied of [user({emailVerifiedAt:undefined}),user({configurationReviewRequired:true})]) {
    const skipped = await context.processUser(denied,x.db,"2026-10-28"); assert.equal(skipped.reason,"ownership_or_review_required");
  }
  assert.equal(x.sent.length,0);
  const result = await context.processUser(user(), x.db, "2026-10-28");
  assert.equal(result.status, "success"); assert.equal(result.emailSent, true); assert.equal(x.sent.length, 1);
  assert.deepEqual(x.sent[0].payload.to, ["owner@example.com"]);
});
