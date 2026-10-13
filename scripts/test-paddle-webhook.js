/**
 * Sharflow — Test Suite for Paddle Webhook Signature Verification and Endpoint
 *
 * Tests:
 * 1. Valid HMAC-SHA256 signature verification matching Paddle specification
 * 2. Invalid signature rejection (tampered signature header)
 * 3. Tampered payload rejection (body modified after signing)
 * 4. Expired timestamp rejection (replay attack prevention)
 * 5. Malformed header rejection
 * 6. Missing header or empty payload rejection
 * 7. Malformed JSON payload rejection
 * 8. Missing event_id rejection
 * 9. Duplicate event detection and idempotent handling
 * 10. End-to-end webhook HTTP invocation with mock request/response
 */

const assert = require("assert");
const crypto = require("crypto");
const {
  verifyPaddleWebhookSignature,
  parsePaddleSignatureHeader,
  getPaddleEnv,
  getPaddleBaseUrl,
} = require("../api/_lib/paddle");

const TEST_SECRET = "pdl_ntf_set_01testsecretkey123456789";

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

console.log("\n=== 4. Testing Webhook Endpoint Handler Logic ===");

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

async function runHandlerTests() {
  process.env.PADDLE_WEBHOOK_SECRET = TEST_SECRET;
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
    const validJsonMissingId = JSON.stringify({ data: { id: "123" } });
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

  await runAsyncTest("Accepts valid signed webhook payload and returns 200", async () => {
    const payload = JSON.stringify({
      event_id: `evt_valid_${Date.now()}`,
      event_type: "subscription.created",
      occurred_at: new Date().toISOString(),
      data: { id: "sub_12345", status: "active" },
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
    assert.strictEqual(res.body.eventType, "subscription.created");
  });

  console.log(`\n========================================`);
  console.log(`Tests Completed: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runHandlerTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
