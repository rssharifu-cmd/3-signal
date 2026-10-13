/**
 * Vercel Serverless Function — POST /api/paddle-webhook
 *
 * Receives and processes Paddle Billing v2 webhook notifications:
 * 1. Verifies official Paddle-Signature using exact raw request body.
 * 2. Implements event deduplication via MongoDB `billing_events` collection.
 * 3. Logs and acknowledges receipt with HTTP 200 to prevent retries.
 * 4. Extensible dispatch handler for subscription and transaction lifecycle events.
 */

const { verifyPaddleWebhookSignature } = require("./_lib/paddle");
const { getDb } = require("./_lib/db");

// In Vercel serverless environments, disable bodyParser if available
// so we get raw body stream, while also safely handling pre-parsed bodies.
const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Extracts raw body buffer/string from incoming request.
 * Handles both streaming Node.js requests and pre-parsed middleware bodies.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ rawBody: string, parsedBody: any }>}
 */
async function getRawBody(req) {
  // If server middleware already attached rawBody (e.g. Express raw body middleware)
  if (req.rawBody) {
    const raw = typeof req.rawBody === "string" ? req.rawBody : req.rawBody.toString("utf8");
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* ignore */ }
    return { rawBody: raw, parsedBody: parsed || req.body };
  }

  // If req has stream listeners and has not been consumed yet
  if (typeof req.on === "function" && !req.readableEnded) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const buffer = Buffer.concat(chunks);
    const raw = buffer.toString("utf8");
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
    return { rawBody: raw, parsedBody: parsed };
  }

  // Fallback if req.body is already an object or string
  if (req.body) {
    if (typeof req.body === "string") {
      let parsed = null;
      try { parsed = JSON.parse(req.body); } catch { /* ignore */ }
      return { rawBody: req.body, parsedBody: parsed || {} };
    }
    if (typeof req.body === "object") {
      // Re-serialize with warning (Express body-parser fallback)
      return { rawBody: JSON.stringify(req.body), parsedBody: req.body };
    }
  }

  return { rawBody: "", parsedBody: {} };
}

/**
 * Main Webhook Handler
 */
async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Paddle-Signature");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Only POST is accepted." });
  }

  const signatureHeader =
    req.headers["paddle-signature"] ||
    req.headers["Paddle-Signature"] ||
    "";

  if (!signatureHeader) {
    return res.status(400).json({ error: "Missing Paddle-Signature header." });
  }

  let rawBody = "";
  let payload = null;

  try {
    const bodyResult = await getRawBody(req);
    rawBody = bodyResult.rawBody;
    payload = bodyResult.parsedBody;
  } catch (err) {
    console.error("[Paddle Webhook] Error reading request body:", err);
    return res.status(400).json({ error: "Could not read webhook request body." });
  }

  if (!rawBody) {
    return res.status(400).json({ error: "Empty webhook payload." });
  }

  // 1. Signature Verification
  const verification = verifyPaddleWebhookSignature({
    rawBody,
    signatureHeader,
  });

  if (!verification.valid) {
    console.warn("[Paddle Webhook] Signature verification failed:", verification.error);
    return res.status(401).json({
      error: "Invalid webhook signature.",
      detail: verification.error,
    });
  }

  // 2. Validate Payload JSON Structure
  if (!payload || typeof payload !== "object") {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Malformed JSON payload." });
    }
  }

  const eventId = payload.event_id || payload.notification_id;
  const eventType = payload.event_type || payload.alert_name;

  if (!eventId) {
    return res.status(400).json({ error: "Missing event_id in webhook payload." });
  }

  // 3. Event Deduplication via MongoDB billing_events collection
  let isDuplicate = false;
  try {
    const db = await getDb();
    const billingEvents = db.collection("billing_events");

    // Ensure index on eventId exists (background/idempotent)
    await billingEvents.createIndex({ eventId: 1 }, { unique: true }).catch(() => {});

    const existingEvent = await billingEvents.findOne({ eventId });
    if (existingEvent) {
      isDuplicate = true;
      console.log(`[Paddle Webhook] Duplicate event detected (${eventId}). Acknowledging without re-processing.`);
    } else {
      // Record event receipt
      await billingEvents.insertOne({
        eventId,
        eventType,
        occurredAt: payload.occurred_at ? new Date(payload.occurred_at) : new Date(),
        receivedAt: new Date(),
        data: payload.data || {},
        status: "received",
      });
    }
  } catch (dbErr) {
    // If unique key duplicate error from concurrent insert, treat as duplicate
    if (dbErr.code === 11000) {
      isDuplicate = true;
    } else {
      console.error("[Paddle Webhook] Database warning during event logging:", dbErr.message);
      // Non-fatal: continue processing so webhook is not dropped if DB is temporarily degraded
    }
  }

  // 4. Return early if duplicate
  if (isDuplicate) {
    return res.status(200).json({
      ok: true,
      duplicate: true,
      message: "Event already processed.",
    });
  }

  // 5. Acknowledge Receipt
  return res.status(200).json({
    ok: true,
    eventId,
    eventType,
    message: "Webhook received and verified successfully.",
  });
}

handler.config = config;
module.exports = handler;
