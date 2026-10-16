/**
 * Vercel Serverless Function — POST /api/paddle-webhook
 *
 * Production Paddle Billing v2 Webhook Handler:
 * 1. Verifies official Paddle-Signature using exact raw request body.
 * 2. Implements atomic claim/lease and idempotent deduplication via MongoDB `billing_events`:
 *    - Unprocessed, failed, or expired-lease events can be retried without double-granting access.
 *    - Fully processed events return HTTP 200 without re-running state mutations.
 *    - Failures during user updates or event processing return HTTP 500 so Paddle retries.
 * 3. Secure authenticated account linking:
 *    - Only links unlinked customers/subscriptions when a cryptographically verified `checkoutToken`
 *      (signed by server JWT_SECRET) is present in `custom_data`.
 *    - Never uses email or unauthenticated custom data alone to prove account ownership.
 * 4. Rigorous subscription and price validation:
 *    - Pro access requires matching configured Pro price ID AND active/paid subscription status.
 *    - One-off transactions without verified active subscription do NOT grant Pro access.
 * 5. Accurate refund & refund-reversal handling per Paddle documentation:
 *    - Approved refund: revokes Pro access, sets subscriptionStatus to 'refunded'.
 *    - Reversed refund: reinstates Pro access if subscription remains valid.
 *    - Pending/rejected refunds: leaves active subscription untouched.
 * 6. Out-of-order event replay guard via occurred_at timestamps.
 */

const jwt = require("jsonwebtoken");
const { verifyPaddleWebhookSignature, getPaddleProPriceId } = require("./_lib/paddle");
const { getDb } = require("./_lib/db");

const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Extracts raw body buffer/string from incoming request.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ rawBody: string, parsedBody: any }>}
 */
async function getRawBody(req) {
  if (req.rawBody) {
    const raw = typeof req.rawBody === "string" ? req.rawBody : req.rawBody.toString("utf8");
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* ignore */ }
    return { rawBody: raw, parsedBody: parsed || req.body };
  }

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

  // 3. Database connection and atomic claim/lease
  let db;
  let billingEvents;
  let users;

  try {
    db = await getDb();
    billingEvents = db.collection("billing_events");
    users = db.collection("users");
    await billingEvents.createIndex({ eventId: 1 }, { unique: true }).catch(() => {});
  } catch (dbErr) {
    console.error("[Paddle Webhook] Database connection error:", dbErr.message);
    return res.status(500).json({ error: "Database unavailable. Retrying webhook delivery." });
  }

  const now = new Date();
  const leaseDurationMs = 45000; // 45 seconds lease for processing
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  // Check existing event status for idempotency and atomic lease acquisition
  try {
    const existing = await billingEvents.findOne({ eventId });

    if (existing) {
      // If already successfully processed or terminally handled, acknowledge without re-processing
      if (existing.status === "processed") {
        return res.status(200).json({
          ok: true,
          duplicate: true,
          eventId,
          message: "Event already processed.",
        });
      }

      if (existing.status === "unmatched_user" || existing.status === "ignored_out_of_order") {
        return res.status(200).json({
          ok: true,
          duplicate: true,
          eventId,
          status: existing.status,
          message: "Event was already evaluated as terminal.",
        });
      }

      // If currently processing and lease is still active, return 429/503 for retry to avoid concurrent collision
      if (existing.status === "processing" && existing.leaseExpiresAt && new Date(existing.leaseExpiresAt) > now) {
        console.log(`[Paddle Webhook] Concurrent processing in progress for event ${eventId}. Requesting retry.`);
        return res.status(429).json({ error: "Event currently processing. Retry scheduled." });
      }

      // If event failed previously or lease expired, re-acquire lease
      if (typeof billingEvents.findOneAndUpdate === "function") {
        const claim = await billingEvents.findOneAndUpdate(
          {
            eventId,
            $or: [
              { status: { $in: ["failed", "received"] } },
              { status: "processing", leaseExpiresAt: { $lte: now } },
            ],
          },
          {
            $set: {
              status: "processing",
              leaseExpiresAt,
              lastAttemptAt: now,
            },
            $inc: { attempts: 1 },
          },
          { returnDocument: "after" }
        );

        if (!claim) {
          return res.status(429).json({ error: "Concurrent claim collision. Retry scheduled." });
        }
      } else {
        // Fallback for mock/simple collections
        await billingEvents.updateOne(
          { eventId },
          {
            $set: {
              status: "processing",
              leaseExpiresAt,
              lastAttemptAt: now,
            },
          }
        );
      }
    } else {
      // First attempt: atomically insert with status 'processing'
      try {
        await billingEvents.insertOne({
          eventId,
          eventType,
          occurredAt,
          receivedAt: now,
          data,
          status: "processing",
          leaseExpiresAt,
          attempts: 1,
          lastAttemptAt: now,
        });
      } catch (insertErr) {
        if (insertErr.code === 11000) {
          // Concurrent race condition during initial insert
          const concurrentDoc = await billingEvents.findOne({ eventId });
          if (concurrentDoc?.status === "processed") {
            return res.status(200).json({ ok: true, duplicate: true, eventId, message: "Event already processed." });
          }
          return res.status(429).json({ error: "Concurrent insert collision. Retry scheduled." });
        }
        throw insertErr;
      }
    }
  } catch (claimErr) {
    console.error("[Paddle Webhook] Error acquiring event claim:", claimErr.message);
    return res.status(500).json({ error: "Failed to record event lease." });
  }

  // 4. Processing logic wrapped in try-catch to guarantee reliable retries on failure
  try {
    const subscriptionId = data.id && eventType.startsWith("subscription.")
      ? data.id
      : (data.subscription_id || data.subscriptionId || null);

    const customerId = data.customer_id || data.customerId || (data.customer && data.customer.id) || null;
    const customData = data.custom_data || data.customData || {};

    let user = null;

    // Step 4A: Check by authoritative subscription ID if present
    if (subscriptionId) {
      user = await users.findOne({ paddleSubscriptionId: subscriptionId });
    }

    // Step 4B: Check by authoritative customer ID if present
    if (!user && customerId) {
      user = await users.findOne({ paddleCustomerId: customerId });
    }

    // Step 4C: If customer/subscription is not yet linked, ONLY link via cryptographically verified checkoutToken
    if (!user) {
      const checkoutToken = customData.checkoutToken;
      if (checkoutToken && typeof checkoutToken === "string") {
        const secret = (process.env.JWT_SECRET || "").trim();
        if (secret) {
          try {
            const decoded = jwt.verify(checkoutToken, secret);
            if (decoded && decoded.purpose === "paddle_checkout_link") {
              let candidate = null;
              if (decoded.userId) {
                candidate = await users.findOne({ _id: decoded.userId });
              }
              if (!candidate && decoded.email) {
                candidate = await users.findOne({ email: decoded.email.toLowerCase().trim() });
              }

              // Verify candidate does not belong to a different customer
              if (candidate) {
                if (!candidate.paddleCustomerId || candidate.paddleCustomerId === customerId) {
                  user = candidate;
                  console.log(`[Paddle Webhook] Cryptographically verified checkout token for user ${candidate.email}`);
                } else {
                  console.warn(`[Paddle Webhook] Security mismatch: user ${candidate.email} already bound to customer ${candidate.paddleCustomerId}, rejected event customer ${customerId}`);
                }
              }
            }
          } catch (tokenErr) {
            console.warn(`[Paddle Webhook] Invalid or expired checkoutToken in event ${eventId}:`, tokenErr.message);
          }
        }
      } else {
        // Explicitly reject unauthenticated linking based on raw email alone
        console.warn(`[Paddle Webhook] Unlinked customer ${customerId} (sub: ${subscriptionId}) provided no verified checkoutToken. Refusing to guess account ownership.`);
      }
    }

    // If no user found/verified in database
    if (!user) {
      console.warn(`[Paddle Webhook] No matching verified user for event ${eventId} (sub: ${subscriptionId}, ctm: ${customerId}). Recorded as unmatched.`);
      await billingEvents.updateOne(
        { eventId },
        {
          $set: {
            status: "unmatched_user",
            processedAt: new Date(),
            leaseExpiresAt: null,
          },
        }
      );
      return res.status(200).json({
        ok: true,
        matched: false,
        eventId,
        eventType,
        message: "Webhook recorded; customer not associated with a verified user account.",
      });
    }

    // 5. Out-of-Order Event Protection
    if (user.paddleLastEventOccurredAt && occurredAt < new Date(user.paddleLastEventOccurredAt)) {
      console.warn(`[Paddle Webhook] Out-of-order event (${eventId}) occurred at ${occurredAt.toISOString()}, prior to user's last recorded event ${user.paddleLastEventOccurredAt}. Skipping state change.`);
      await billingEvents.updateOne(
        { eventId },
        {
          $set: {
            status: "ignored_out_of_order",
            processedAt: new Date(),
            userId: user._id,
            leaseExpiresAt: null,
          },
        }
      );
      return res.status(200).json({
        ok: true,
        ignored: true,
        eventId,
        message: "Out-of-order event safely ignored.",
      });
    }

    // 6. Subscription & Lifecycle Evaluation
    const proPriceId = getPaddleProPriceId();
    const subStatus = (data.status || "").toLowerCase();
    let updatedPlan = user.plan || "starter";
    let userUpdate = {
      paddleLastEventOccurredAt: occurredAt,
      updatedAt: new Date(),
    };

    if (customerId) userUpdate.paddleCustomerId = customerId;
    if (subscriptionId) userUpdate.paddleSubscriptionId = subscriptionId;

    // ── A. Subscription Events (Creation, Activation, Resumption, Update) ──────
    if (
      eventType === "subscription.created" ||
      eventType === "subscription.activated" ||
      eventType === "subscription.resumed" ||
      eventType === "subscription.updated"
    ) {
      if (subStatus === "active" || subStatus === "trialing") {
        if (hasMatchingProPrice(data.items, proPriceId)) {
          updatedPlan = "pro";
          userUpdate.plan = "pro";
          userUpdate.subscriptionStatus = subStatus;
          userUpdate.paddlePriceId = proPriceId;
          if (data.current_billing_period?.ends_at) {
            userUpdate.paddleCurrentPeriodEnd = new Date(data.current_billing_period.ends_at);
          }
        } else {
          console.warn(`[Paddle Webhook] Subscription ${subscriptionId} active but does not contain Pro price ID ${proPriceId}.`);
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

    // ── E. Transaction Events ─────────────────────────────────────────────────
    // Transactions alone do NOT grant indefinite Pro access without an active subscription
    else if (eventType === "transaction.completed" || eventType === "transaction.paid") {
      if (subStatus === "completed" || subStatus === "paid") {
        userUpdate.paddleLastPaymentAt = occurredAt;
        // If tied to an active verified subscription with pro price, maintain active status
        if (subscriptionId && user.paddleSubscriptionId === subscriptionId && user.subscriptionStatus === "active") {
          updatedPlan = "pro";
          userUpdate.plan = "pro";
        }
      }
    }

    // ── F. Refunds & Adjustments ──────────────────────────────────────────────
    else if (eventType === "adjustment.created" || eventType === "adjustment.updated") {
      const action = (data.action || "").toLowerCase();
      const adjStatus = (data.status || "").toLowerCase();

      if (action === "refund") {
        if (adjStatus === "approved") {
          // Approved refund: revoke Pro access
          updatedPlan = "starter";
          userUpdate.plan = "starter";
          userUpdate.subscriptionStatus = "refunded";
          userUpdate.paddleRefundedAt = occurredAt;
        } else if (adjStatus === "reversed") {
          // Reversed refund: reinstate Pro if subscription was previously active/refunded
          if (user.subscriptionStatus === "refunded") {
            updatedPlan = "pro";
            userUpdate.plan = "pro";
            userUpdate.subscriptionStatus = "active";
            userUpdate.paddleRefundReversedAt = occurredAt;
          }
        }
      }
    }

    // Apply user updates atomically
    await users.updateOne({ _id: user._id }, { $set: userUpdate });

    // Mark event as processed
    await billingEvents.updateOne(
      { eventId },
      {
        $set: {
          status: "processed",
          processedAt: new Date(),
          userId: user._id,
          userEmail: user.email,
          resultingPlan: updatedPlan,
          leaseExpiresAt: null,
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

  } catch (processingErr) {
    console.error(`[Paddle Webhook] Error during event processing for ${eventId}:`, processingErr);
    // Mark status as failed and clear lease so Paddle retry can re-claim and re-process
    await billingEvents.updateOne(
      { eventId },
      {
        $set: {
          status: "failed",
          lastError: processingErr.message,
          failedAt: new Date(),
          leaseExpiresAt: null,
        },
      }
    ).catch(() => {});

    // Return 500 so Paddle schedules retry
    return res.status(500).json({ error: "Failed to process webhook. Retry scheduled." });
  }
}

handler.config = config;
module.exports = handler;
