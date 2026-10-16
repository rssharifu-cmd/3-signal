/**
 * Sharflow — Comprehensive Test Suite for Paddle Billing Security & Webhook Handling
 *
 * Verifies:
 * 1. Paddle environment detection & base URLs
 * 2. Paddle-Signature header parsing
 * 3. HMAC-SHA256 signature verification & replay-attack tolerance
 * 4. Plan authorization security in /api/user:
 *    - Prevent self-upgrade via { plan: "pro" }
 *    - Ensure profile & settings updates continue working
 *    - Support authenticated checkout_token generation with server-stored metadata
 * 5. Frontend checkout safety:
 *    - Verify js/app.js contains NO client authority to grant Pro on checkout=success
 * 6. Webhook endpoint input validation (methods, headers, payload structure)
 * 7. Secure Account Linking & Token Protection:
 *    - Reject linking based on email alone (prevents account takeover)
 *    - Reject token not present in server-stored pendingPaddleCheckoutToken
 *    - Reject expired checkoutToken
 *    - Reject reused checkoutToken for a different subscription
 *    - Allow legitimate retry of same subscription with consumed token
 *    - Successfully links and upgrades user with valid signed checkoutToken
 * 8. Subscription Lifecycle, Multi-Subscription Safety & Validations:
 *    - Activation (subscription.activated) with Pro price verification
 *    - Rejection of unmatching / invalid price IDs
 *    - One-off transactions alone do NOT grant indefinite Pro access
 *    - Isolation: Old subscription cancellation does NOT cancel user's newer active subscription
 *    - Cancellation (subscription.canceled)
 *    - Past-due / unpaid handling (subscription.past_due)
 *    - Approved refund revokes Pro access
 *    - Invalid refund reversal (canceled subscription or expired period) does NOT restore Pro
 *    - Valid refund reversal restores Pro
 * 9. Idempotency, Failure Retries & Atomic Claims:
 *    - Duplicate of fully processed event returns 200 duplicate without re-processing
 *    - Failed event can be retried and successfully processed on subsequent delivery
 *    - Concurrent in-progress event returns 429 to schedule safe retry
 *    - Safely ignores out-of-order events (stale activation cannot undo newer cancellation)
 * 10. Resilience:
 *    - Database connection drop returns HTTP 500 for Paddle retry
 *    - Unknown user handled gracefully without crash
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const {
  verifyPaddleWebhookSignature,
  parsePaddleSignatureHeader,
  getPaddleEnv,
  getPaddleBaseUrl,
  getPaddleProPriceId,
} = require("../api/_lib/paddle");

const TEST_SECRET = "pdl_ntf_set_01testsecretkey123456789";
const TEST_JWT_SECRET = "test-jwt-secret-key-32-chars-ok-here";
const TARGET_PRO_PRICE_ID = "pri_01m4tf8w6602rpfrhv9mbrcm7b";

process.env.PADDLE_WEBHOOK_SECRET = TEST_SECRET;
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.PADDLE_PRICE_ID_PRO = TARGET_PRO_PRICE_ID;

function createValidSignature(payload, secret = TEST_SECRET, customTs = null) {
  const ts = customTs !== null ? customTs : Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}:${payload}`;
  const h1 = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  return {
    ts,
    h1,
    header: `ts=${ts};h1=${h1}`,
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    end() {
      return this;
    },
  };
}

function getNestedVal(obj, path) {
  if (!path.includes(".")) return obj ? obj[path] : undefined;
  return path.split(".").reduce((curr, p) => (curr && typeof curr === "object" ? curr[p] : undefined), obj);
}

function matchesFilter(item, filter) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") {
      const orMatched = v.some((subFilter) => matchesFilter(item, subFilter));
      if (!orMatched) return false;
      continue;
    }
    const val = k.includes(".") ? getNestedVal(item, k) : item[k];
    if (typeof v === "object" && v !== null) {
      if ("$in" in v) {
        if (!v.$in.includes(val)) return false;
        continue;
      }
      if ("$lte" in v) {
        if (val === undefined || val === null) return true;
        if (new Date(val) > new Date(v.$lte)) return false;
        continue;
      }
      if ("$lt" in v) {
        if (val === undefined || val === null) return true;
        if (new Date(val) >= new Date(v.$lt)) return false;
        continue;
      }
    }
    if (val !== v) return false;
  }
  return true;
}

function applySetUpdate(doc, setObj) {
  for (const [key, value] of Object.entries(setObj)) {
    if (key.includes(".")) {
      const parts = key.split(".");
      let target = doc;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!target[parts[i]] || typeof target[parts[i]] !== "object") {
          target[parts[i]] = {};
        }
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = value;
    } else {
      doc[key] = value;
    }
  }
}

function createMockDb(initialUsers = [], initialEvents = []) {
  const usersList = JSON.parse(JSON.stringify(initialUsers));
  const eventsList = JSON.parse(JSON.stringify(initialEvents));

  const users = {
    async findOne(query) {
      return usersList.find((u) => matchesFilter(u, query)) || null;
    },
    async insertOne(doc) {
      const copy = { _id: "usr_" + Math.random().toString(36).slice(2, 9), ...doc };
      usersList.push(copy);
      return { insertedId: copy._id };
    },
    async updateOne(filter, update) {
      const doc = await this.findOne(filter);
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) {
        applySetUpdate(doc, update.$set);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async createIndex() {},
  };

  const billingEvents = {
    async findOne(query) {
      return eventsList.find((e) => matchesFilter(e, query)) || null;
    },
    async findOneAndUpdate(filter, update) {
      const doc = await this.findOne(filter);
      if (!doc) return null;
      if (update.$set) {
        applySetUpdate(doc, update.$set);
      }
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          doc[k] = (doc[k] || 0) + v;
        }
      }
      return { value: doc };
    },
    async insertOne(doc) {
      if (doc.eventId && eventsList.some((e) => e.eventId === doc.eventId)) {
        const err = new Error("E11000 duplicate key error collection");
        err.code = 11000;
        throw err;
      }
      eventsList.push({ _id: "evt_" + Math.random().toString(36).slice(2, 9), ...doc });
      return { insertedId: doc._id };
    },
    async updateOne(filter, update) {
      const doc = await this.findOne(filter);
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) {
        applySetUpdate(doc, update.$set);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async createIndex() {},
  };

  return {
    collection(name) {
      if (name === "users") return users;
      if (name === "billing_events") return billingEvents;
      throw new Error(`Unknown collection ${name}`);
    },
    _usersList: usersList,
    _eventsList: eventsList,
  };
}

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error: ${err.message}`);
    failed++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error: ${err.message}`);
    failed++;
  }
}

async function runAllTests() {
  console.log("\n=== 1. Testing Paddle Environment & Base URLs ===");

  runTest("Default environment defaults to 'live' when PADDLE_ENV is unset", () => {
    const orig = process.env.PADDLE_ENV;
    delete process.env.PADDLE_ENV;
    assert.strictEqual(getPaddleEnv(), "live");
    assert.strictEqual(getPaddleBaseUrl(), "https://api.paddle.com");
    process.env.PADDLE_ENV = orig;
  });

  runTest("Environment detects 'sandbox' and sets sandbox base URL", () => {
    const orig = process.env.PADDLE_ENV;
    process.env.PADDLE_ENV = "sandbox";
    assert.strictEqual(getPaddleEnv(), "sandbox");
    assert.strictEqual(getPaddleBaseUrl(), "https://sandbox-api.paddle.com");
    process.env.PADDLE_ENV = orig;
  });

  console.log("\n=== 2. Testing Paddle-Signature Header Parsing ===");

  runTest("Parses standard ts and h1 header format", () => {
    const parsed = parsePaddleSignatureHeader("ts=1712345678;h1=abcd1234ef5678");
    assert.ok(parsed);
    assert.strictEqual(parsed.ts, 1712345678);
    assert.deepStrictEqual(parsed.signatures, ["abcd1234ef5678"]);
  });

  runTest("Rejects invalid header formats", () => {
    assert.strictEqual(parsePaddleSignatureHeader(""), null);
    assert.strictEqual(parsePaddleSignatureHeader(null), null);
    assert.strictEqual(parsePaddleSignatureHeader("random-text"), null);
    assert.strictEqual(parsePaddleSignatureHeader("ts=abc;h1=def"), null);
  });

  console.log("\n=== 3. Testing Paddle Webhook Signature Verification ===");

  runTest("Successfully verifies genuine Paddle signature", () => {
    const payload = JSON.stringify({ event_id: "evt_01", event_type: "subscription.created" });
    const sig = createValidSignature(payload);
    const result = verifyPaddleWebhookSignature({
      rawBody: payload,
      signatureHeader: sig.header,
      secretKey: TEST_SECRET,
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.ts, sig.ts);
  });

  runTest("Rejects signature when secret is incorrect", () => {
    const payload = JSON.stringify({ event_id: "evt_01" });
    const sig = createValidSignature(payload, "wrong_secret_key");
    const result = verifyPaddleWebhookSignature({
      rawBody: payload,
      signatureHeader: sig.header,
      secretKey: TEST_SECRET,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, "Signature mismatch.");
  });

  runTest("Rejects signature when payload was tampered in transit", () => {
    const genuinePayload = JSON.stringify({ event_id: "evt_01", amount: "100" });
    const tamperedPayload = JSON.stringify({ event_id: "evt_01", amount: "10" });
    const sig = createValidSignature(genuinePayload);
    const result = verifyPaddleWebhookSignature({
      rawBody: tamperedPayload,
      signatureHeader: sig.header,
      secretKey: TEST_SECRET,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, "Signature mismatch.");
  });

  runTest("Rejects signature when timestamp is expired (replay attack tolerance exceeded)", () => {
    const payload = JSON.stringify({ event_id: "evt_replay" });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const sig = createValidSignature(payload, TEST_SECRET, oldTimestamp);
    const result = verifyPaddleWebhookSignature({
      rawBody: payload,
      signatureHeader: sig.header,
      secretKey: TEST_SECRET,
      toleranceSeconds: 300,
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes("Webhook timestamp expired"));
  });

  console.log("\n=== 4. Testing Plan Authorization Security in /api/user ===");

  const userHandler = require("../api/user");

  await runAsyncTest("Prevent self-upgrade: POST /api/user with { plan: 'pro' } does NOT grant Pro", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_attacker",
        email: "victim@example.com",
        name: "Honest User",
        plan: "starter",
        active: true,
      },
    ]);
    global.__mockDb = mockDb;

    const token = jwt.sign({ email: "victim@example.com" }, TEST_JWT_SECRET);
    const req = {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: { plan: "pro" },
    };
    const res = createMockRes();
    await userHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.user.plan, "starter");

    const inDb = await mockDb.collection("users").findOne({ email: "victim@example.com" });
    assert.strictEqual(inDb.plan, "starter");
  });

  await runAsyncTest("Existing profile and settings updates continue to work in /api/user", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_normal",
        email: "normal@example.com",
        name: "Original Name",
        plan: "starter",
        active: true,
      },
    ]);
    global.__mockDb = mockDb;

    const token = jwt.sign({ email: "normal@example.com" }, TEST_JWT_SECRET);
    const req = {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: {
        name: "Updated Name",
        profile: {
          websiteUrl: "https://example.com",
          websiteType: "ecommerce",
        },
        settings: {
          notifications: false,
          digestTime: "09:00",
        },
      },
    };
    const res = createMockRes();
    await userHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.user.name, "Updated Name");
    assert.strictEqual(res.body.user.profile.websiteUrl, "https://example.com");
    assert.strictEqual(res.body.user.settings.notifications, false);
    assert.strictEqual(res.body.user.plan, "starter");
  });

  await runAsyncTest("Authenticated user generates signed checkoutToken stored on server with expiry and metadata", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_checkout_user",
        email: "payer@example.com",
        plan: "starter",
      },
    ]);
    global.__mockDb = mockDb;

    const token = jwt.sign({ email: "payer@example.com" }, TEST_JWT_SECRET);
    const req = {
      method: "GET",
      url: "/api/user?action=checkout_token",
      headers: { authorization: `Bearer ${token}` },
    };
    const res = createMockRes();
    await userHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.checkoutToken);

    const userInDb = await mockDb.collection("users").findOne({ email: "payer@example.com" });
    assert.ok(userInDb.pendingPaddleCheckoutToken);
    assert.strictEqual(userInDb.pendingPaddleCheckoutToken.token, res.body.checkoutToken);
    assert.strictEqual(userInDb.pendingPaddleCheckoutToken.consumed, false);
    assert.ok(new Date(userInDb.pendingPaddleCheckoutToken.expiresAt) > new Date());
  });

  console.log("\n=== 5. Testing Frontend Checkout Safety ===");

  runTest("js/app.js contains NO client authority to grant Pro on checkout=success", () => {
    const appJsContent = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

    // Must not write pro to localStorage inside onload
    assert.strictEqual(
      appJsContent.includes('localStorage.setItem(STORAGE.plan, "pro");'),
      false,
      "js/app.js must not unilaterally grant Pro via localStorage"
    );

    // Must not POST plan pro inside onload or checkout callback
    assert.strictEqual(
      appJsContent.includes('body: JSON.stringify({ plan: "pro" })'),
      false,
      "js/app.js must not POST { plan: 'pro' } to /api/user"
    );

    // Must verify via refreshUserPlanFromServer
    assert.ok(
      appJsContent.includes("refreshUserPlanFromServer"),
      "js/app.js must verify status via refreshUserPlanFromServer"
    );
  });

  console.log("\n=== 6. Testing Webhook Endpoint Input Validation ===");

  const webhookHandler = require("../api/paddle-webhook");

  await runAsyncTest("Rejects non-POST methods with 405", async () => {
    const req = { method: "GET", headers: {} };
    const res = createMockRes();
    await webhookHandler(req, res);
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.headers.Allow, "POST");
  });

  await runAsyncTest("Rejects requests without Paddle-Signature with 400", async () => {
    const req = { method: "POST", headers: {}, body: {} };
    const res = createMockRes();
    await webhookHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "Missing Paddle-Signature header.");
  });

  await runAsyncTest("Rejects requests with invalid signature with 401", async () => {
    const payload = JSON.stringify({ event_id: "evt_test", event_type: "transaction.completed" });
    const req = {
      method: "POST",
      headers: { "paddle-signature": "ts=1234567890;h1=invalid_hash" },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, "Invalid webhook signature.");
  });

  await runAsyncTest("Rejects malformed JSON with 400", async () => {
    const badJson = "this is not json";
    const sig = createValidSignature(badJson);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: badJson,
    };
    const res = createMockRes();
    await webhookHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "Malformed JSON payload.");
  });

  await runAsyncTest("Rejects payload missing event_id with 400", async () => {
    const validJsonMissingId = JSON.stringify({ event_type: "subscription.created", data: { id: "123" } });
    const sig = createValidSignature(validJsonMissingId);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: validJsonMissingId,
    };
    const res = createMockRes();
    await webhookHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "Missing event_id in webhook payload.");
  });

  console.log("\n=== 7. Testing Secure Account Linking & Token Protection ===");

  await runAsyncTest("Rejects linking unlinked customer based on email alone (prevents account takeover)", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_alice",
        email: "alice@example.com",
        plan: "starter",
        active: true,
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_spoofed_email_link",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_eve_999",
        status: "active",
        customer_id: "ctm_eve_888",
        customer: { email: "alice@example.com" },
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
        custom_data: { email: "alice@example.com" },
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.matched, false);

    const aliceInDb = await mockDb.collection("users").findOne({ email: "alice@example.com" });
    assert.strictEqual(aliceInDb.plan, "starter");
    assert.strictEqual(aliceInDb.paddleCustomerId, undefined);
  });

  await runAsyncTest("Rejects linking when checkoutToken is not stored on server", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_alice_not_pending",
        email: "alice@example.com",
        plan: "starter",
        // No pendingPaddleCheckoutToken
      },
    ]);
    global.__mockDb = mockDb;

    // Signed token with valid JWT signature, but not stored on user's server record
    const unstoredToken = jwt.sign(
      { userId: "usr_alice_not_pending", email: "alice@example.com", purpose: "paddle_checkout_link" },
      TEST_JWT_SECRET,
      { expiresIn: "1h" }
    );

    const payload = JSON.stringify({
      event_id: "evt_unstored_token",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_unstored_111",
        status: "active",
        customer_id: "ctm_unstored_222",
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
        custom_data: { checkoutToken: unstoredToken },
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.matched, false);

    const userInDb = await mockDb.collection("users").findOne({ email: "alice@example.com" });
    assert.strictEqual(userInDb.plan, "starter");
  });

  await runAsyncTest("Rejects linking when checkoutToken is expired", async () => {
    const expiredDate = new Date(Date.now() - 3600000); // 1 hr in past
    const expiredToken = jwt.sign(
      { userId: "usr_alice_expired", email: "alice@example.com", purpose: "paddle_checkout_link" },
      TEST_JWT_SECRET,
      { expiresIn: "1h" }
    );

    const mockDb = createMockDb([
      {
        _id: "usr_alice_expired",
        email: "alice@example.com",
        plan: "starter",
        pendingPaddleCheckoutToken: {
          token: expiredToken,
          userId: "usr_alice_expired",
          email: "alice@example.com",
          expiresAt: expiredDate,
          consumed: false,
        },
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_expired_token",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_expired_111",
        status: "active",
        customer_id: "ctm_expired_222",
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
        custom_data: { checkoutToken: expiredToken },
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.matched, false);

    const userInDb = await mockDb.collection("users").findOne({ email: "alice@example.com" });
    assert.strictEqual(userInDb.plan, "starter");
  });

  await runAsyncTest("Rejects reuse of already-consumed checkoutToken for a different subscription", async () => {
    const consumedToken = jwt.sign(
      { userId: "usr_alice_consumed", email: "alice@example.com", purpose: "paddle_checkout_link" },
      TEST_JWT_SECRET,
      { expiresIn: "1h" }
    );

    const mockDb = createMockDb([
      {
        _id: "usr_alice_consumed",
        email: "alice@example.com",
        plan: "pro",
        paddleSubscriptionId: "sub_original_111",
        paddleCustomerId: "ctm_original_222",
        pendingPaddleCheckoutToken: {
          token: consumedToken,
          userId: "usr_alice_consumed",
          email: "alice@example.com",
          expiresAt: new Date(Date.now() + 3600000),
          consumed: true,
          boundSubscriptionId: "sub_original_111",
        },
      },
    ]);
    global.__mockDb = mockDb;

    // Attacker tries to use the same consumed token for another subscription ID sub_rogue_999
    const payload = JSON.stringify({
      event_id: "evt_reused_token",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_rogue_999",
        status: "active",
        customer_id: "ctm_rogue_888",
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
        custom_data: { checkoutToken: consumedToken },
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.matched, false);

    // Alice's original subscription must NOT be overwritten by rogue subscription
    const userInDb = await mockDb.collection("users").findOne({ email: "alice@example.com" });
    assert.strictEqual(userInDb.paddleSubscriptionId, "sub_original_111");
  });

  await runAsyncTest("Allows legitimate Paddle retry of same subscription with consumed token", async () => {
    const token = jwt.sign(
      { userId: "usr_retry_sub", email: "retrysub@example.com", purpose: "paddle_checkout_link" },
      TEST_JWT_SECRET,
      { expiresIn: "1h" }
    );

    const mockDb = createMockDb([
      {
        _id: "usr_retry_sub",
        email: "retrysub@example.com",
        plan: "starter",
        paddleSubscriptionId: "sub_legit_same_111",
        paddleCustomerId: "ctm_legit_same_222",
        pendingPaddleCheckoutToken: {
          token,
          userId: "usr_retry_sub",
          email: "retrysub@example.com",
          expiresAt: new Date(Date.now() + 3600000),
          consumed: true,
          boundSubscriptionId: "sub_legit_same_111",
        },
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_legit_retry_same_sub",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_legit_same_111",
        status: "active",
        customer_id: "ctm_legit_same_222",
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
        custom_data: { checkoutToken: token },
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.plan, "pro");
  });

  await runAsyncTest("Successfully links and upgrades user with valid signed, server-stored checkoutToken", async () => {
    const validCheckoutToken = jwt.sign(
      {
        userId: "usr_legit_alice",
        email: "alice@example.com",
        purpose: "paddle_checkout_link",
      },
      TEST_JWT_SECRET,
      { expiresIn: "1h" }
    );

    const mockDb = createMockDb([
      {
        _id: "usr_legit_alice",
        email: "alice@example.com",
        plan: "starter",
        active: true,
        pendingPaddleCheckoutToken: {
          token: validCheckoutToken,
          userId: "usr_legit_alice",
          email: "alice@example.com",
          expiresAt: new Date(Date.now() + 3600000),
          consumed: false,
        },
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_verified_token_link",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_alice_123",
        status: "active",
        customer_id: "ctm_alice_999",
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
        custom_data: { checkoutToken: validCheckoutToken },
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.plan, "pro");

    const updatedAlice = await mockDb.collection("users").findOne({ email: "alice@example.com" });
    assert.strictEqual(updatedAlice.plan, "pro");
    assert.strictEqual(updatedAlice.paddleSubscriptionId, "sub_alice_123");
    assert.strictEqual(updatedAlice.paddleCustomerId, "ctm_alice_999");
    assert.strictEqual(updatedAlice.pendingPaddleCheckoutToken.consumed, true);
    assert.strictEqual(updatedAlice.pendingPaddleCheckoutToken.boundSubscriptionId, "sub_alice_123");
  });

  console.log("\n=== 8. Testing Subscription Lifecycle, Isolation & Refund Reversals ===");

  await runAsyncTest("Isolation: Old subscription cancellation does NOT cancel user's newer active subscription", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_multi_sub",
        email: "multisub@example.com",
        plan: "pro",
        subscriptionStatus: "active",
        paddleCustomerId: "ctm_shared_123",
        paddleSubscriptionId: "sub_new_222", // Active current subscription
        paddlePriceId: TARGET_PRO_PRICE_ID,
      },
    ]);
    global.__mockDb = mockDb;

    // Cancellation event arrives for old subscription sub_old_111 under the same customer ID
    const payload = JSON.stringify({
      event_id: "evt_cancel_old_sub",
      event_type: "subscription.canceled",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_old_111", // Old subscription
        customer_id: "ctm_shared_123",
        status: "canceled",
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ignored, true);

    // User's newer subscription sub_new_222 MUST remain active Pro!
    const userInDb = await mockDb.collection("users").findOne({ _id: "usr_multi_sub" });
    assert.strictEqual(userInDb.plan, "pro");
    assert.strictEqual(userInDb.subscriptionStatus, "active");
    assert.strictEqual(userInDb.paddleSubscriptionId, "sub_new_222");
  });

  await runAsyncTest("Does NOT activate Pro on subscription.created with unmatching price ID", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_bob",
        email: "bob@example.com",
        plan: "starter",
        paddleCustomerId: "ctm_bob_888",
        paddleSubscriptionId: "sub_bob_999",
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_sub_other_price",
      event_type: "subscription.created",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_bob_999",
        status: "active",
        customer_id: "ctm_bob_888",
        items: [{ price: { id: "pri_some_other_item" } }],
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    const updated = await mockDb.collection("users").findOne({ email: "bob@example.com" });
    assert.strictEqual(updated.plan, "starter");
  });

  await runAsyncTest("One-off transaction without subscription does NOT grant Pro", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_oneoff",
        email: "oneoff@example.com",
        plan: "starter",
        paddleCustomerId: "ctm_oneoff_111",
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_oneoff_txn",
      event_type: "transaction.completed",
      occurred_at: new Date().toISOString(),
      data: {
        id: "txn_oneoff_999",
        status: "completed",
        customer_id: "ctm_oneoff_111",
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    const updated = await mockDb.collection("users").findOne({ _id: "usr_oneoff" });
    assert.strictEqual(updated.plan, "starter");
  });

  await runAsyncTest("Downgrades user to starter on subscription.canceled", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_dave",
        email: "dave@example.com",
        plan: "pro",
        paddleSubscriptionId: "sub_dave_123",
        paddleCustomerId: "ctm_dave_456",
        subscriptionStatus: "active",
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_sub_cancel_dave",
      event_type: "subscription.canceled",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_dave_123",
        status: "canceled",
        customer_id: "ctm_dave_456",
        canceled_at: new Date().toISOString(),
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.plan, "starter");

    const updated = await mockDb.collection("users").findOne({ _id: "usr_dave" });
    assert.strictEqual(updated.plan, "starter");
    assert.strictEqual(updated.subscriptionStatus, "canceled");
  });

  await runAsyncTest("Approved refund revokes Pro access", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_frank",
        email: "frank@example.com",
        plan: "pro",
        paddleSubscriptionId: "sub_frank_123",
        paddleCustomerId: "ctm_frank_456",
        paddlePriceId: TARGET_PRO_PRICE_ID,
        subscriptionStatus: "active",
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_adj_refund_approved_frank",
      event_type: "adjustment.created",
      occurred_at: new Date().toISOString(),
      data: {
        id: "adj_frank_01",
        action: "refund",
        status: "approved",
        subscription_id: "sub_frank_123",
        customer_id: "ctm_frank_456",
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    const updated = await mockDb.collection("users").findOne({ _id: "usr_frank" });
    assert.strictEqual(updated.plan, "starter");
    assert.strictEqual(updated.subscriptionStatus, "refunded");
  });

  await runAsyncTest("Invalid refund reversal (canceled subscription) does NOT restore Pro", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_frank_canceled",
        email: "frank_canceled@example.com",
        plan: "starter",
        paddleSubscriptionId: "sub_frank_canceled",
        paddleCustomerId: "ctm_frank_456",
        paddlePriceId: TARGET_PRO_PRICE_ID,
        subscriptionStatus: "canceled",
        paddleCanceledAt: new Date(),
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_adj_reversal_canceled_sub",
      event_type: "adjustment.updated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "adj_frank_rev_01",
        action: "refund",
        status: "reversed",
        subscription_id: "sub_frank_canceled",
        customer_id: "ctm_frank_456",
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    const updated = await mockDb.collection("users").findOne({ _id: "usr_frank_canceled" });
    // Must remain starter!
    assert.strictEqual(updated.plan, "starter");
  });

  await runAsyncTest("Valid refund reversal restores Pro on active subscription", async () => {
    const futureDate = new Date(Date.now() + 15 * 86400000); // 15 days in future
    const mockDb = createMockDb([
      {
        _id: "usr_frank_valid_rev",
        email: "frank_valid@example.com",
        plan: "starter",
        paddleSubscriptionId: "sub_frank_valid",
        paddleCustomerId: "ctm_frank_456",
        paddlePriceId: TARGET_PRO_PRICE_ID,
        paddleCurrentPeriodEnd: futureDate,
        subscriptionStatus: "refunded",
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_adj_reversal_valid",
      event_type: "adjustment.updated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "adj_frank_rev_02",
        action: "refund",
        status: "reversed",
        subscription_id: "sub_frank_valid",
        customer_id: "ctm_frank_456",
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    const updated = await mockDb.collection("users").findOne({ _id: "usr_frank_valid_rev" });
    assert.strictEqual(updated.plan, "pro");
    assert.strictEqual(updated.subscriptionStatus, "active");
  });

  await runAsyncTest("Invalid refund reversal (unmatching price ID) does NOT restore Pro", async () => {
    const futureDate = new Date(Date.now() + 15 * 86400000);
    const mockDb = createMockDb([
      {
        _id: "usr_frank_other_price",
        email: "frank_other@example.com",
        plan: "starter",
        paddleSubscriptionId: "sub_frank_other",
        paddleCustomerId: "ctm_frank_456",
        paddlePriceId: "pri_some_other_starter_price",
        paddleCurrentPeriodEnd: futureDate,
        subscriptionStatus: "refunded",
        paddleSubscriptionStatus: "active",
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_adj_reversal_other_price",
      event_type: "adjustment.updated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "adj_frank_rev_03",
        action: "refund",
        status: "reversed",
        subscription_id: "sub_frank_other",
        customer_id: "ctm_frank_456",
        items: [{ price: { id: "pri_some_other_starter_price" } }],
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    const updated = await mockDb.collection("users").findOne({ _id: "usr_frank_other_price" });
    assert.strictEqual(updated.plan, "starter"); // Must NOT restore Pro
  });

  await runAsyncTest("Invalid refund reversal for unmatched subscription ID does NOT restore Pro", async () => {
    const futureDate = new Date(Date.now() + 15 * 86400000);
    const mockDb = createMockDb([
      {
        _id: "usr_frank_mismatch",
        email: "frank_mismatch@example.com",
        plan: "starter",
        paddleSubscriptionId: "sub_frank_current",
        paddleCustomerId: "ctm_frank_456",
        paddlePriceId: TARGET_PRO_PRICE_ID,
        paddleCurrentPeriodEnd: futureDate,
        subscriptionStatus: "refunded",
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_adj_reversal_mismatched_sub",
      event_type: "adjustment.updated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "adj_frank_rev_04",
        action: "refund",
        status: "reversed",
        subscription_id: "sub_old_irrelevant_111", // does not match current sub
        customer_id: "ctm_frank_456",
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    const updated = await mockDb.collection("users").findOne({ _id: "usr_frank_mismatch" });
    assert.strictEqual(updated.plan, "starter"); // Must NOT restore Pro
  });

  await runAsyncTest("Isolation: Destructive old subscription past_due does NOT modify user's newer active subscription", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_multi_pastdue",
        email: "multipastdue@example.com",
        plan: "pro",
        subscriptionStatus: "active",
        paddleCustomerId: "ctm_shared_pastdue",
        paddleSubscriptionId: "sub_new_active_888",
        paddlePriceId: TARGET_PRO_PRICE_ID,
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_pastdue_old_sub",
      event_type: "subscription.past_due",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_old_defunct_777",
        customer_id: "ctm_shared_pastdue",
        status: "past_due",
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ignored, true);

    const userInDb = await mockDb.collection("users").findOne({ _id: "usr_multi_pastdue" });
    assert.strictEqual(userInDb.plan, "pro");
    assert.strictEqual(userInDb.subscriptionStatus, "active");
    assert.strictEqual(userInDb.paddleSubscriptionId, "sub_new_active_888");
  });

  await runAsyncTest("Security: Reused checkoutToken for intended user mismatch is rejected", async () => {
    const token = jwt.sign(
      { userId: "usr_victim", email: "victim@example.com", purpose: "paddle_checkout_link" },
      TEST_JWT_SECRET,
      { expiresIn: "1h" }
    );

    const mockDb = createMockDb([
      {
        _id: "usr_victim",
        email: "victim@example.com",
        plan: "starter",
        pendingPaddleCheckoutToken: {
          token,
          userId: "usr_victim",
          email: "victim@example.com",
          expiresAt: new Date(Date.now() + 3600000),
          consumed: false,
        },
      },
      {
        _id: "usr_attacker",
        email: "attacker@example.com",
        plan: "starter",
      },
    ]);
    global.__mockDb = mockDb;

    // Attacker tries to consume victim's checkout token for attacker's customer account
    const payload = JSON.stringify({
      event_id: "evt_tampered_user_token",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_attacker_999",
        status: "active",
        customer_id: "ctm_attacker_666",
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
        custom_data: { checkoutToken: token },
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);

    // Attacker must NOT be granted Pro
    const attackerInDb = await mockDb.collection("users").findOne({ _id: "usr_attacker" });
    assert.strictEqual(attackerInDb.plan, "starter");
  });

  console.log("\n=== 9. Testing Idempotency, Failure Retries & Atomic Claims ===");

  await runAsyncTest("Duplicate of fully processed event returns 200 duplicate without re-processing", async () => {
    const mockDb = createMockDb(
      [
        {
          _id: "usr_grace",
          email: "grace@example.com",
          plan: "pro",
          paddleSubscriptionId: "sub_grace_123",
        },
      ],
      [
        {
          eventId: "evt_already_processed_grace",
          eventType: "subscription.activated",
          status: "processed",
        },
      ]
    );
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_already_processed_grace",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: { id: "sub_grace_123", status: "active" },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.duplicate, true);
  });

  await runAsyncTest("Failed event can be retried and successfully processed on subsequent delivery", async () => {
    const mockDb = createMockDb(
      [
        {
          _id: "usr_retry_user",
          email: "retry@example.com",
          plan: "starter",
          paddleSubscriptionId: "sub_retry_123",
        },
      ],
      [
        {
          eventId: "evt_retry_after_fail_01",
          eventType: "subscription.activated",
          status: "failed",
          lastError: "Database write timeout",
        },
      ]
    );
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_retry_after_fail_01",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_retry_123",
        status: "active",
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.plan, "pro");

    const updatedUser = await mockDb.collection("users").findOne({ _id: "usr_retry_user" });
    assert.strictEqual(updatedUser.plan, "pro");

    const eventRecord = await mockDb.collection("billing_events").findOne({ eventId: "evt_retry_after_fail_01" });
    assert.strictEqual(eventRecord.status, "processed");
  });

  await runAsyncTest("Concurrent in-progress event returns 429 to schedule safe retry", async () => {
    const futureDate = new Date(Date.now() + 30000);
    const mockDb = createMockDb(
      [],
      [
        {
          eventId: "evt_concurrent_active_01",
          eventType: "subscription.activated",
          status: "processing",
          leaseExpiresAt: futureDate,
        },
      ]
    );
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_concurrent_active_01",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: { id: "sub_concurrent" },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 429);
    assert.ok(res.body.error.includes("currently processing"));
  });

  await runAsyncTest("Safely ignores out-of-order events (stale activation cannot undo newer cancellation)", async () => {
    const tNew = new Date("2026-10-16T12:00:00Z");
    const tOld = new Date("2026-10-15T12:00:00Z");

    const mockDb = createMockDb([
      {
        _id: "usr_heidi",
        email: "heidi@example.com",
        plan: "starter",
        subscriptionStatus: "canceled",
        paddleSubscriptionId: "sub_heidi_123",
        paddleCustomerId: "ctm_heidi_456",
        paddleLastEventOccurredAt: tNew,
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_stale_activation_heidi",
      event_type: "subscription.activated",
      occurred_at: tOld.toISOString(),
      data: {
        id: "sub_heidi_123",
        customer_id: "ctm_heidi_456",
        status: "active",
        items: [{ price: { id: TARGET_PRO_PRICE_ID } }],
      },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ignored, true);

    const userInDb = await mockDb.collection("users").findOne({ _id: "usr_heidi" });
    assert.strictEqual(userInDb.plan, "starter");
    assert.strictEqual(userInDb.subscriptionStatus, "canceled");
  });

  console.log("\n=== 10. Testing Resilience & Failures ===");

  await runAsyncTest("Returns 500 on database failure so Paddle retries per schedule", async () => {
    global.__mockDb = {
      collection() {
        throw new Error("Simulated MongoDB connection drop / timeout");
      },
    };

    const payload = JSON.stringify({
      event_id: "evt_db_fail_01",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: { id: "sub_db_fail", status: "active" },
    });
    const sig = createValidSignature(payload);
    const req = {
      method: "POST",
      headers: { "paddle-signature": sig.header },
      rawBody: payload,
    };
    const res = createMockRes();
    await webhookHandler(req, res);

    assert.strictEqual(res.statusCode, 500);
    assert.ok(res.body.error.includes("Database unavailable"));
  });

  delete global.__mockDb;

  console.log(`\n========================================`);
  console.log(`Paddle Security & Webhook Tests Completed: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
