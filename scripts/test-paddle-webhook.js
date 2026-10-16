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
 * 5. Webhook endpoint input validation (methods, headers, payload structure)
 * 6. Subscription lifecycle processing:
 *    - Activation (subscription.activated / subscription.created) with Pro price verification
 *    - Rejection of unmatching / invalid price IDs
 *    - Transaction payment completion (transaction.completed)
 *    - Cancellation (subscription.canceled)
 *    - Past-due / unpaid handling (subscription.past_due)
 *    - Refund handling (adjustment.created / adjustment.updated)
 * 7. Deduplication & concurrency (duplicate eventId handling)
 * 8. Out-of-order event protection (stale event does not overwrite newer state)
 * 9. Resilience:
 *    - Unknown user handling (durable logging as unmatched_user without crashing)
 *    - Database failure handling (HTTP 500 returned so Paddle retries)
 */

const assert = require("assert");
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

function createMockDb(initialUsers = [], initialEvents = []) {
  const usersList = JSON.parse(JSON.stringify(initialUsers));
  const eventsList = JSON.parse(JSON.stringify(initialEvents));

  const users = {
    async findOne(query) {
      return (
        usersList.find((u) => {
          for (const [k, v] of Object.entries(query)) {
            if (u[k] !== v) return false;
          }
          return true;
        }) || null
      );
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
        Object.assign(doc, update.$set);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async createIndex() {},
  };

  const billingEvents = {
    async findOne(query) {
      return (
        eventsList.find((e) => {
          for (const [k, v] of Object.entries(query)) {
            if (e[k] !== v) return false;
          }
          return true;
        }) || null
      );
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
        Object.assign(doc, update.$set);
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
    // User plan must remain 'starter'
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

  console.log("\n=== 5. Testing Webhook Endpoint Input Validation ===");

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

  console.log("\n=== 6. Testing Subscription Lifecycle & Price Verification ===");

  await runAsyncTest("Activates Pro on subscription.activated with matching Pro price ID", async () => {
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
      event_id: "evt_sub_active_01",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_alice_123",
        status: "active",
        customer_id: "ctm_alice_999",
        customer: { email: "alice@example.com" },
        items: [
          {
            price: { id: TARGET_PRO_PRICE_ID },
            quantity: 1,
          },
        ],
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

    const updated = await mockDb.collection("users").findOne({ email: "alice@example.com" });
    assert.strictEqual(updated.plan, "pro");
    assert.strictEqual(updated.subscriptionStatus, "active");
    assert.strictEqual(updated.paddleSubscriptionId, "sub_alice_123");
    assert.strictEqual(updated.paddleCustomerId, "ctm_alice_999");
  });

  await runAsyncTest("Does NOT activate Pro on subscription.created with unmatching price ID", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_bob",
        email: "bob@example.com",
        plan: "starter",
        active: true,
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
        customer: { email: "bob@example.com" },
        items: [
          {
            price: { id: "pri_some_other_cheap_or_test_product" },
            quantity: 1,
          },
        ],
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
    // Must remain starter!
    assert.strictEqual(updated.plan, "starter");
  });

  await runAsyncTest("Activates Pro on transaction.completed with matching Pro price ID", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_carol",
        email: "carol@example.com",
        plan: "starter",
        active: true,
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_txn_carol_01",
      event_type: "transaction.completed",
      occurred_at: new Date().toISOString(),
      data: {
        id: "txn_carol_123",
        status: "completed",
        customer_id: "ctm_carol_555",
        subscription_id: "sub_carol_444",
        customer: { email: "carol@example.com" },
        items: [
          {
            price: { id: TARGET_PRO_PRICE_ID },
            quantity: 1,
          },
        ],
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
    const updated = await mockDb.collection("users").findOne({ email: "carol@example.com" });
    assert.strictEqual(updated.plan, "pro");
    assert.strictEqual(updated.subscriptionStatus, "active");
  });

  console.log("\n=== 7. Testing Cancellation, Past-Due & Refund Events ===");

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
    assert.ok(updated.paddleCanceledAt);
  });

  await runAsyncTest("Downgrades user to starter on subscription.past_due (unpaid)", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_erin",
        email: "erin@example.com",
        plan: "pro",
        paddleSubscriptionId: "sub_erin_123",
        paddleCustomerId: "ctm_erin_456",
        subscriptionStatus: "active",
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_sub_pastdue_erin",
      event_type: "subscription.past_due",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_erin_123",
        status: "past_due",
        customer_id: "ctm_erin_456",
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
    const updated = await mockDb.collection("users").findOne({ _id: "usr_erin" });
    assert.strictEqual(updated.plan, "starter");
    assert.strictEqual(updated.subscriptionStatus, "past_due");
  });

  await runAsyncTest("Downgrades user to starter on adjustment.created (refund)", async () => {
    const mockDb = createMockDb([
      {
        _id: "usr_frank",
        email: "frank@example.com",
        plan: "pro",
        paddleSubscriptionId: "sub_frank_123",
        paddleCustomerId: "ctm_frank_456",
        subscriptionStatus: "active",
      },
    ]);
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_adj_refund_frank",
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

  console.log("\n=== 8. Testing Concurrency & Out-of-Order Webhook Protection ===");

  await runAsyncTest("Handles duplicate events idempotently (acknowledged without re-processing)", async () => {
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
    assert.strictEqual(res.body.message, "Event already processed.");
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

    // Send old activation that occurred at tOld (1 day prior to cancellation)
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
    // User must remain starter / canceled!
    assert.strictEqual(userInDb.plan, "starter");
    assert.strictEqual(userInDb.subscriptionStatus, "canceled");
  });

  console.log("\n=== 9. Testing Database Failures & Unknown User Handling ===");

  await runAsyncTest("Handles unknown user gracefully (recorded in billing_events as unmatched_user without crashing)", async () => {
    const mockDb = createMockDb([]); // empty users
    global.__mockDb = mockDb;

    const payload = JSON.stringify({
      event_id: "evt_unknown_user_999",
      event_type: "subscription.activated",
      occurred_at: new Date().toISOString(),
      data: {
        id: "sub_unknown_999",
        customer_id: "ctm_unknown_999",
        customer: { email: "ghost@example.com" },
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
    assert.strictEqual(res.body.matched, false);

    const eventRecord = await mockDb.collection("billing_events").findOne({ eventId: "evt_unknown_user_999" });
    assert.ok(eventRecord);
    assert.strictEqual(eventRecord.status, "unmatched_user");
  });

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

  // Reset global mockDb
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
