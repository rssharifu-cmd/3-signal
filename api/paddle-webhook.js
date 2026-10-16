/**
 * Vercel Serverless Function — POST /api/paddle-webhook
 *
 * Receives and processes Paddle Billing v2 webhook notifications:
 * 1. Verifies official Paddle-Signature using exact raw request body.
 * 2. Durably records every event into MongoDB `billing_events` collection before processing.
 * 3. Enforces idempotent deduplication on event_id.
 * 4. Verifies subscription status, customer identity, and price ID before granting Pro access.
 * 5. Handles subscription activations, updates, cancellations, past-due states, and refunds.
 * 6. Guards against out-of-order event replay via occurred_at timestamps.
 * 7. Returns 500 on database failure so Paddle retries per official retry schedule.
 */

const { verifyPaddleWebhookSignature, getPaddleProPriceId } = require("./_lib/paddle");
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
      return { rawBody: JSON.stringify(req.body), parsedBody: req.body };
    }
  }

  return { rawBody: "", parsedBody: {} };
}

/**
 * Checks if subscription/transaction items include the configured Sharflow Pro price ID.
 *
 * @param {Array<object>} items
 * @param {string} proPriceId
 * @returns {boolean}
 */
function hasMatchingProPrice(items, proPriceId) {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.some((item) => {
    const priceId = item?.price?.id || item?.price_id || item?.priceId;
    return priceId && priceId === proPriceId;
  });
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

  // 1. Signature Verification against exact raw request body
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
  const data = payload.data || {};

  if (!eventId) {
    return res.status(400).json({ error: "Missing event_id in webhook payload." });
  }

  if (!eventType) {
    return res.status(400).json({ error: "Missing event_type in webhook payload." });
  }

  const occurredAt = payload.occurred_at ? new Date(payload.occurred_at) : new Date();

  // 3. Durable Recording & Idempotent Deduplication via MongoDB billing_events
  let db;
  let billingEvents;
  let users;

  try {
    db = await getDb();
    billingEvents = db.collection("billing_events");
    users = db.collection("users");

    // Ensure index on eventId exists (idempotent)
    await billingEvents.createIndex({ eventId: 1 }, { unique: true }).catch(() => {});
  } catch (dbErr) {
    console.error("[Paddle Webhook] Database connection error:", dbErr.message);
    // Never return 200 on DB failure: Paddle must retry per its official retry schedule
    return res.status(500).json({ error: "Database unavailable. Retrying webhook delivery." });
  }

  // Check for duplicate event
  try {
    const existing = await billingEvents.findOne({ eventId });
    if (existing) {
      console.log(`[Paddle Webhook] Duplicate event detected (${eventId}). Acknowledging without re-processing.`);
      return res.status(200).json({
        ok: true,
        duplicate: true,
        eventId,
        message: "Event already processed.",
      });
    }

    // Durably record event receipt before processing
    await billingEvents.insertOne({
      eventId,
      eventType,
      occurredAt,
      receivedAt: new Date(),
      data,
      status: "received",
    });
  } catch (insertErr) {
    if (insertErr.code === 11000) {
      // Duplicate key error from concurrent request
      return res.status(200).json({
        ok: true,
        duplicate: true,
        eventId,
        message: "Concurrent duplicate event acknowledged.",
      });
    }
    console.error("[Paddle Webhook] Failed to durably record event:", insertErr.message);
    return res.status(500).json({ error: "Could not durably record webhook event." });
  }

  // 4. Safe Customer & Subscription Mapping
  const subscriptionId = data.id && eventType.startsWith("subscription.")
    ? data.id
    : (data.subscription_id || data.subscriptionId || null);

  const customerId = data.customer_id || data.customerId || (data.customer && data.customer.id) || null;
  const customData = data.custom_data || data.customData || {};
  const customerEmail = (data.customer && data.customer.email) || data.customer_email || customData.email || null;

  let user = null;

  // Step 4A: Check by authoritative subscription ID if present
  if (subscriptionId) {
    user = await users.findOne({ paddleSubscriptionId: subscriptionId });
  }

  // Step 4B: Check by authoritative customer ID if present
  if (!user && customerId) {
    user = await users.findOne({ paddleCustomerId: customerId });
  }

  // Step 4C: If unlinked, map during initial activation/payment using customer email or customData
  const isInitialActivationEvent =
    eventType === "subscription.created" ||
    eventType === "subscription.activated" ||
    eventType === "transaction.completed" ||
    eventType === "transaction.paid";

  if (!user && isInitialActivationEvent) {
    if (customerEmail && typeof customerEmail === "string") {
      const normalizedEmail = customerEmail.trim().toLowerCase();
      const candidateUser = await users.findOne({ email: normalizedEmail });

      // Verify candidate is not bound to a different active customer
      if (candidateUser) {
        if (!candidateUser.paddleCustomerId || candidateUser.paddleCustomerId === customerId) {
          user = candidateUser;
        } else {
          console.warn(`[Paddle Webhook] Security mismatch: email ${normalizedEmail} already bound to customer ${candidateUser.paddleCustomerId}, event customer ${customerId}`);
        }
      }
    }
  }

  // If no user found in database
  if (!user) {
    console.warn(`[Paddle Webhook] No matching user found for event ${eventId} (sub: ${subscriptionId}, ctm: ${customerId}, email: ${customerEmail})`);
    await billingEvents.updateOne(
      { eventId },
      { $set: { status: "unmatched_user", processedAt: new Date() } }
    );
    return res.status(200).json({
      ok: true,
      matched: false,
      eventId,
      eventType,
      message: "Webhook recorded; customer not associated with a registered user.",
    });
  }

  // 5. Out-of-Order Event Protection
  if (user.paddleLastEventOccurredAt && occurredAt < new Date(user.paddleLastEventOccurredAt)) {
    console.warn(`[Paddle Webhook] Out-of-order event (${eventId}) occurred at ${occurredAt.toISOString()}, prior to user's last recorded event ${user.paddleLastEventOccurredAt}. Skipping state change.`);
    await billingEvents.updateOne(
      { eventId },
      { $set: { status: "ignored_out_of_order", processedAt: new Date(), userId: user._id } }
    );
    return res.status(200).json({
      ok: true,
      ignored: true,
      eventId,
      message: "Out-of-order event safely ignored.",
    });
  }

  // 6. Process Subscription & Transaction Lifecycle Events
  const proPriceId = getPaddleProPriceId();
  const subStatus = (data.status || "").toLowerCase();
  let updatedPlan = user.plan || "starter";
  let userUpdate = {
    paddleLastEventOccurredAt: occurredAt,
    updatedAt: new Date(),
  };

  if (customerId) userUpdate.paddleCustomerId = customerId;
  if (subscriptionId) userUpdate.paddleSubscriptionId = subscriptionId;

  // ── A. Subscription Activation & Renewal ──────────────────────────────────
  if (
    eventType === "subscription.created" ||
    eventType === "subscription.activated" ||
    eventType === "subscription.resumed" ||
    eventType === "subscription.updated"
  ) {
    if (subStatus === "active" || subStatus === "trialing") {
      // Verify items contain the configured Pro price ID
      if (hasMatchingProPrice(data.items, proPriceId)) {
        updatedPlan = "pro";
        userUpdate.plan = "pro";
        userUpdate.subscriptionStatus = subStatus;
        userUpdate.paddlePriceId = proPriceId;
        if (data.current_billing_period?.ends_at) {
          userUpdate.paddleCurrentPeriodEnd = new Date(data.current_billing_period.ends_at);
        }
      } else {
        console.warn(`[Paddle Webhook] Subscription ${subscriptionId} active but does not contain Pro price ID ${proPriceId}. Items:`, data.items);
        userUpdate.subscriptionStatus = subStatus;
      }
    } else if (subStatus === "canceled") {
      updatedPlan = "starter";
      userUpdate.plan = "starter";
      userUpdate.subscriptionStatus = "canceled";
      userUpdate.paddleCanceledAt = data.canceled_at ? new Date(data.canceled_at) : occurredAt;
    } else if (subStatus === "past_due") {
      updatedPlan = "starter";
      userUpdate.plan = "starter";
      userUpdate.subscriptionStatus = "past_due";
    } else if (subStatus === "paused") {
      updatedPlan = "starter";
      userUpdate.plan = "starter";
      userUpdate.subscriptionStatus = "paused";
    }
  }

  // ── B. Subscription Cancellation ──────────────────────────────────────────
  else if (eventType === "subscription.canceled") {
    updatedPlan = "starter";
    userUpdate.plan = "starter";
    userUpdate.subscriptionStatus = "canceled";
    userUpdate.paddleCanceledAt = data.canceled_at ? new Date(data.canceled_at) : occurredAt;
  }

  // ── C. Subscription Past-Due (Unpaid) ──────────────────────────────────────
  else if (eventType === "subscription.past_due") {
    updatedPlan = "starter";
    userUpdate.plan = "starter";
    userUpdate.subscriptionStatus = "past_due";
  }

  // ── D. Subscription Paused ────────────────────────────────────────────────
  else if (eventType === "subscription.paused") {
    updatedPlan = "starter";
    userUpdate.plan = "starter";
    userUpdate.subscriptionStatus = "paused";
  }

  // ── E. Transaction Paid / Completed ───────────────────────────────────────
  else if (eventType === "transaction.completed" || eventType === "transaction.paid") {
    if (subStatus === "completed" || subStatus === "paid") {
      if (hasMatchingProPrice(data.items, proPriceId)) {
        updatedPlan = "pro";
        userUpdate.plan = "pro";
        userUpdate.subscriptionStatus = "active";
        userUpdate.paddlePriceId = proPriceId;
      }
    }
  }

  // ── F. Refunds & Adjustments ──────────────────────────────────────────────
  else if (eventType === "adjustment.created" || eventType === "adjustment.updated") {
    const action = (data.action || "").toLowerCase();
    const adjStatus = (data.status || "").toLowerCase();

    if (action === "refund" && (adjStatus === "approved" || adjStatus === "reversed")) {
      updatedPlan = "starter";
      userUpdate.plan = "starter";
      userUpdate.subscriptionStatus = "refunded";
      userUpdate.paddleRefundedAt = occurredAt;
    }
  }

  // Apply user updates
  await users.updateOne({ _id: user._id }, { $set: userUpdate });

  // Update billing_events record to processed
  await billingEvents.updateOne(
    { eventId },
    {
      $set: {
        status: "processed",
        processedAt: new Date(),
        userId: user._id,
        userEmail: user.email,
        resultingPlan: updatedPlan,
      },
    }
  );

  return res.status(200).json({
    ok: true,
    eventId,
    eventType,
    userId: user._id,
    plan: updatedPlan,
    message: "Webhook processed and subscription state synchronized.",
  });
}

handler.config = config;
module.exports = handler;
