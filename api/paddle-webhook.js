/**
 * Vercel Serverless Function — POST /api/paddle-webhook
 *
 * Production Paddle Billing v2 Webhook Handler:
 * 1. Verifies official Paddle-Signature using exact raw request body.
 * 2. Implements atomic claim/lease and idempotent deduplication via MongoDB `billing_events`:
 *    - Unprocessed, failed, or expired-lease events can be retried without double-granting access.
 *    - Fully processed events return HTTP 200 without re-running state mutations.
 *    - Failures during user updates or event processing return HTTP 500 so Paddle retries.
 * 3. Secure authenticated account linking with server-stored token binding:
 *    - Cryptographically verifies checkoutToken (signed by server JWT_SECRET).
 *    - Validates against server-stored pendingPaddleCheckoutToken, checking exact token, expiry, and intended user.
 *    - Enforces safe consumption: prevents reuse for different subscriptions while allowing legitimate Paddle retries.
 *    - Never uses email or unauthenticated custom data alone to prove account ownership.
 * 4. Multi-subscription safety & destructive event isolation:
 *    - Prevents events for old or unmatched subscriptions from downgrading or canceling newer subscriptions.
 *    - Does not fall back from unmatched subscription ID to customer ID for destructive events.
 * 5. Rigorous subscription and price validation:
 *    - Pro access requires matching configured Pro price ID AND active/paid subscription status.
 *    - One-off transactions without verified active subscription do NOT grant Pro access.
 * 6. Accurate refund & refund-reversal handling per Paddle official documentation:
 *    - Approved refund: revokes Pro access, sets subscriptionStatus to 'refunded'.
 *    - Reversed refund: ONLY restores Pro if the relevant subscription is confirmed active/trialing,
 *      not canceled, period still valid, and contains the configured Pro price ID.
 *    - Pending/rejected refunds: leaves active subscription untouched.
 * 7. Out-of-order event replay guard via occurred_at timestamps.
 */

const jwt = require("jsonwebtoken");
const {
  verifyPaddleWebhookSignature,
  getPaddleProPriceId,
  paddleApiRequest,
  getPaddleApiKey,
} = require("./_lib/paddle");
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

      if (
        existing.status === "unmatched_user" ||
        existing.status === "ignored_out_of_order" ||
        existing.status === "ignored_mismatched_subscription"
      ) {
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

      // If event failed previously or lease expired, re-acquire lease atomically
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
    let userUpdate = {
      paddleLastEventOccurredAt: occurredAt,
      updatedAt: new Date(),
    };

    // Step 4A: Check by authoritative subscription ID if present
    if (subscriptionId) {
      user = await users.findOne({ paddleSubscriptionId: subscriptionId });
    }

    // Step 4B: Check by authoritative customer ID if present
    // Safe guard: Do not fall back to customer ID if this is a specific subscriptionId and
    // the customer already has a different active subscription (prevents old subscription cancellations
    // from destroying a user's newer subscription)
    if (!user && customerId) {
      const candidateByCustomer = await users.findOne({ paddleCustomerId: customerId });
      if (candidateByCustomer) {
        if (
          subscriptionId &&
          candidateByCustomer.paddleSubscriptionId &&
          candidateByCustomer.paddleSubscriptionId !== subscriptionId
        ) {
          console.warn(
            `[Paddle Webhook] Event subscription ${subscriptionId} does not match customer's active subscription ${candidateByCustomer.paddleSubscriptionId}. Refusing fallback and ignoring to protect current subscription.`
          );
          await billingEvents.updateOne(
            { eventId },
            {
              $set: {
                status: "ignored_mismatched_subscription",
                processedAt: new Date(),
                userId: candidateByCustomer._id,
                userEmail: candidateByCustomer.email,
                leaseExpiresAt: null,
              },
            }
          );
          return res.status(200).json({
            ok: true,
            ignored: true,
            eventId,
            message: "Mismatched subscription event ignored to protect current subscription.",
          });
        }

        const isDestructiveSubEvent =
          eventType === "subscription.canceled" ||
          eventType === "subscription.past_due" ||
          eventType === "subscription.paused" ||
          (eventType === "subscription.updated" && ["canceled", "past_due", "paused"].includes((data.status || "").toLowerCase())) ||
          ((eventType === "adjustment.created" || eventType === "adjustment.updated") &&
            (data.action || "").toLowerCase() === "refund" &&
            (data.status || "").toLowerCase() === "approved");

        if (isDestructiveSubEvent && subscriptionId && candidateByCustomer.paddleSubscriptionId !== subscriptionId) {
          console.warn(
            `[Paddle Webhook] Destructive event ${eventType} for subscription ${subscriptionId} does not match verified user subscription. Refusing fallback to customer ID.`
          );
          await billingEvents.updateOne(
            { eventId },
            {
              $set: {
                status: "ignored_mismatched_subscription",
                processedAt: new Date(),
                userId: candidateByCustomer._id,
                userEmail: candidateByCustomer.email,
                leaseExpiresAt: null,
              },
            }
          );
          return res.status(200).json({
            ok: true,
            ignored: true,
            eventId,
            message: "Mismatched subscription event ignored to protect current subscription.",
          });
        }

        user = candidateByCustomer;
      }
    }

    // Step 4C: If customer/subscription is not yet linked, ONLY link via cryptographically verified,
    // server-stored, unexpired, unconsumed checkoutToken
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

              if (candidate) {
                const stored = candidate.pendingPaddleCheckoutToken;
                const storedToken = typeof stored === "object" ? stored?.token : stored;
                const isStoredMatch = Boolean(storedToken && storedToken === checkoutToken);
                const hasValidExpiry = Boolean(
                  stored?.expiresAt &&
                  !isNaN(new Date(stored.expiresAt).getTime()) &&
                  new Date(stored.expiresAt) > now
                );
                const intendedUserId = stored?.userId || decoded.userId;
                const isUserMismatch =
                  !intendedUserId ||
                  String(candidate._id) !== String(intendedUserId) ||
                  (decoded.userId && String(decoded.userId) !== String(candidate._id)) ||
                  (stored?.email && stored.email.toLowerCase() !== candidate.email.toLowerCase()) ||
                  (decoded.email && decoded.email.toLowerCase() !== candidate.email.toLowerCase());

                if (!isStoredMatch) {
                  console.warn(`[Paddle Webhook] Rejected checkoutToken: Token does not match server-stored pending token for ${candidate.email}`);
                } else if (!hasValidExpiry) {
                  console.warn(`[Paddle Webhook] Rejected checkoutToken: Token has missing, invalid, or expired timestamp for ${candidate.email}`);
                } else if (isUserMismatch) {
                  console.warn(`[Paddle Webhook] Rejected checkoutToken: Intended user mismatch for ${candidate.email}`);
                } else if (stored?.consumed) {
                  // Allow legitimate Paddle retry of the same subscription activation
                  if (
                    subscriptionId &&
                    stored.boundSubscriptionId === subscriptionId &&
                    isStoredMatch &&
                    !isUserMismatch
                  ) {
                    console.log(`[Paddle Webhook] Permitting legitimate retry with consumed token for subscription ${subscriptionId}`);
                    user = candidate;
                  } else {
                    console.warn(`[Paddle Webhook] Security Alert: Rejected reuse of already-consumed checkoutToken for subscription ${subscriptionId} (bound: ${stored.boundSubscriptionId})`);
                  }
                } else {
                  // Valid unconsumed token matching server records!
                  if (!candidate.paddleCustomerId || candidate.paddleCustomerId === customerId) {
                    // Safe atomic consumption claim:
                    // Must match EXACT stored token, intended user ID, and unexpired timestamp ($gt: now).
                    // This prevents an older delayed webhook from consuming a newly issued token!
                    const claimFilter = {
                      _id: candidate._id,
                      "pendingPaddleCheckoutToken.token": checkoutToken,
                      "pendingPaddleCheckoutToken.userId": String(candidate._id),
                      "pendingPaddleCheckoutToken.expiresAt": { $gt: now },
                      $or: [
                        { "pendingPaddleCheckoutToken.consumed": false },
                        { "pendingPaddleCheckoutToken.boundSubscriptionId": subscriptionId },
                      ],
                    };
                    const claimUpdate = {
                      $set: {
                        "pendingPaddleCheckoutToken.consumed": true,
                        "pendingPaddleCheckoutToken.boundSubscriptionId": subscriptionId,
                        "pendingPaddleCheckoutToken.consumedAt": now,
                        updatedAt: now,
                      },
                    };
                    const claimRes = await users.updateOne(claimFilter, claimUpdate);
                    if (!claimRes || claimRes.matchedCount === 0) {
                      console.warn(`[Paddle Webhook] Atomic consumption failed (token superseded, expired, mismatched, or race condition) for ${candidate.email} (sub: ${subscriptionId})`);
                    } else {
                      user = candidate;
                      userUpdate["pendingPaddleCheckoutToken.consumed"] = true;
                      userUpdate["pendingPaddleCheckoutToken.boundSubscriptionId"] = subscriptionId;
                      userUpdate["pendingPaddleCheckoutToken.consumedAt"] = now;
                      console.log(`[Paddle Webhook] Successfully verified and atomically bound checkout token for user ${candidate.email}`);
                    }
                  } else {
                    console.warn(`[Paddle Webhook] Security mismatch: user ${candidate.email} already bound to customer ${candidate.paddleCustomerId}, rejected event customer ${customerId}`);
                  }
                }
              }
            }
          } catch (tokenErr) {
            console.warn(`[Paddle Webhook] Invalid or expired checkoutToken in event ${eventId}:`, tokenErr.message);
          }
        }
      } else {
        console.warn(`[Paddle Webhook] Unlinked customer ${customerId} (sub: ${subscriptionId}) provided no verified checkoutToken. Refusing to guess account ownership.`);
      }
    }

    // If no user found or verified in database
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

    // Safeguard: Prevent event for an old subscription from downgrading or modifying a user's newer subscription
    if (
      subscriptionId &&
      user.paddleSubscriptionId &&
      user.paddleSubscriptionId !== subscriptionId
    ) {
      console.warn(
        `[Paddle Webhook] Event subscription ${subscriptionId} does not match user's current subscription ${user.paddleSubscriptionId}. Ignoring to protect current subscription.`
      );
      await billingEvents.updateOne(
        { eventId },
        {
          $set: {
            status: "ignored_mismatched_subscription",
            processedAt: new Date(),
            userId: user._id,
            userEmail: user.email,
            leaseExpiresAt: null,
          },
        }
      );
      return res.status(200).json({
        ok: true,
        ignored: true,
        eventId,
        message: "Mismatched subscription event ignored to protect current subscription.",
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
          userUpdate.paddleSubscriptionStatus = subStatus;
          userUpdate.paddlePriceId = proPriceId;
          userUpdate.paddleCanceledAt = null; // Clear any previous cancellation
          if (data.current_billing_period?.ends_at) {
            userUpdate.paddleCurrentPeriodEnd = new Date(data.current_billing_period.ends_at);
          }
        } else {
          console.warn(`[Paddle Webhook] Subscription ${subscriptionId} active but does not contain Pro price ID ${proPriceId}.`);
          userUpdate.subscriptionStatus = subStatus;
          userUpdate.paddleSubscriptionStatus = subStatus;
        }
      } else if (subStatus === "canceled") {
        updatedPlan = "starter";
        userUpdate.plan = "starter";
        userUpdate.subscriptionStatus = "canceled";
        userUpdate.paddleSubscriptionStatus = "canceled";
        userUpdate.paddleCanceledAt = data.canceled_at ? new Date(data.canceled_at) : occurredAt;
      } else if (subStatus === "past_due") {
        updatedPlan = "starter";
        userUpdate.plan = "starter";
        userUpdate.subscriptionStatus = "past_due";
        userUpdate.paddleSubscriptionStatus = "past_due";
      } else if (subStatus === "paused") {
        updatedPlan = "starter";
        userUpdate.plan = "starter";
        userUpdate.subscriptionStatus = "paused";
        userUpdate.paddleSubscriptionStatus = "paused";
      }
    }

    // ── B. Subscription Cancellation ──────────────────────────────────────────
    else if (eventType === "subscription.canceled") {
      updatedPlan = "starter";
      userUpdate.plan = "starter";
      userUpdate.subscriptionStatus = "canceled";
      userUpdate.paddleSubscriptionStatus = "canceled";
      userUpdate.paddleCanceledAt = data.canceled_at ? new Date(data.canceled_at) : occurredAt;
    }

    // ── C. Subscription Past-Due (Unpaid) ──────────────────────────────────────
    else if (eventType === "subscription.past_due") {
      updatedPlan = "starter";
      userUpdate.plan = "starter";
      userUpdate.subscriptionStatus = "past_due";
      userUpdate.paddleSubscriptionStatus = "past_due";
    }

    // ── D. Subscription Paused ────────────────────────────────────────────────
    else if (eventType === "subscription.paused") {
      updatedPlan = "starter";
      userUpdate.plan = "starter";
      userUpdate.subscriptionStatus = "paused";
      userUpdate.paddleSubscriptionStatus = "paused";
    }

    // ── E. Transaction Events ─────────────────────────────────────────────────
    // Transactions alone do NOT grant indefinite Pro access without an active subscription
    else if (eventType === "transaction.completed" || eventType === "transaction.paid") {
      if (subStatus === "completed" || subStatus === "paid") {
        userUpdate.paddleLastPaymentAt = occurredAt;
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
          // Official Paddle Validation: Only restore Pro after a refund reversal if the relevant
          // subscription is authoritatively confirmed to be active/trialing, not canceled, period is valid, and contains Pro price ID.
          // NEVER assume active when status is unknown or use potentially stale database status!
          const adjSubId = data.subscription_id || data.subscriptionId || subscriptionId;
          const targetSubId = adjSubId || user.paddleSubscriptionId;
          const isMatchingSub = Boolean(targetSubId && user.paddleSubscriptionId && user.paddleSubscriptionId === targetSubId);

          let subDetails = null;

          // 1. Check if subscription is embedded in the webhook payload (Paddle event schema with include/expansion)
          if (data.subscription && typeof data.subscription === "object") {
            subDetails = data.subscription;
          }

          // 2. If not embedded in event, fetch subscription directly from Paddle Billing API (GET /subscriptions/{id})
          const canCallPaddleApi = Boolean(
            typeof global.__mockPaddleApi === "function" ||
            (getPaddleApiKey() && process.env.NODE_ENV !== "test")
          );

          if (!subDetails && targetSubId && canCallPaddleApi) {
            try {
              const apiRes = typeof global.__mockPaddleApi === "function"
                ? await global.__mockPaddleApi(`/subscriptions/${targetSubId}`)
                : await paddleApiRequest(`/subscriptions/${targetSubId}`);
              if (apiRes && apiRes.data) {
                subDetails = apiRes.data;
              }
            } catch (apiErr) {
              console.error(`[Paddle Webhook] Paddle API lookup failed for subscription ${targetSubId}:`, apiErr.message);
              // Do not restore Pro using a potentially stale database status when the Paddle API lookup fails.
              // Safely leave the user's plan unchanged and return a retryable error so Paddle retries.
              throw new Error(`Authoritative Paddle subscription verification failed for ${targetSubId}: ${apiErr.message}`);
            }
          }

          let subStatus = "";
          let subItems = [];
          let subPeriodEnd = null;
          let subCanceledAt = null;

          if (subDetails) {
            subStatus = (subDetails.status || "").toLowerCase();
            subItems = Array.isArray(subDetails.items) ? subDetails.items : [];
            subPeriodEnd = subDetails.current_billing_period?.ends_at || null;
            subCanceledAt = subDetails.canceled_at || null;
          }

          // CRITICAL: Require authoritative current subscription confirmation from Paddle.
          // Never assume subscription is active when its status is unknown or unconfirmed!
          const isConfirmedActiveOrTrialing = (subStatus === "active" || subStatus === "trialing");

          const hasProPrice =
            hasMatchingProPrice(subItems, proPriceId) ||
            hasMatchingProPrice(data.items, proPriceId) ||
            (user.paddlePriceId === proPriceId && (!subItems.length || hasMatchingProPrice(subItems, proPriceId)));

          const isNotCanceled =
            !subCanceledAt &&
            !user.paddleCanceledAt &&
            subStatus !== "canceled" &&
            user.subscriptionStatus !== "canceled" &&
            (user.paddleSubscriptionStatus || "").toLowerCase() !== "canceled";

          // Period end validation: Require a present, valid current_billing_period.ends_at that is later than event time.
          // Missing or invalid period end MUST fail closed!
          let isPeriodValid = false;
          let validPeriodEndDate = null;
          if (subPeriodEnd && (typeof subPeriodEnd === "string" || subPeriodEnd instanceof Date)) {
            const parsedPeriodEnd = new Date(subPeriodEnd);
            if (!isNaN(parsedPeriodEnd.getTime()) && parsedPeriodEnd.getTime() > occurredAt.getTime()) {
              isPeriodValid = true;
              validPeriodEndDate = parsedPeriodEnd;
            }
          }

          if (isMatchingSub && isConfirmedActiveOrTrialing && hasProPrice && isNotCanceled && isPeriodValid) {
            updatedPlan = "pro";
            userUpdate.plan = "pro";
            userUpdate.subscriptionStatus = "active";
            userUpdate.paddleSubscriptionStatus = "active";
            userUpdate.paddleRefundReversedAt = occurredAt;
            userUpdate.paddleCurrentPeriodEnd = validPeriodEndDate;
            console.log(`[Paddle Webhook] Refund reversal verified: reinstated Pro for user ${user.email} (sub: ${user.paddleSubscriptionId})`);
          } else {
            console.warn(
              `[Paddle Webhook] Refund reversal not eligible for Pro restoration (matchingSub: ${isMatchingSub}, activeOrTrialing: ${isConfirmedActiveOrTrialing} [status=${subStatus || 'unconfirmed'}], proPrice: ${hasProPrice}, notCanceled: ${isNotCanceled}, periodValid: ${isPeriodValid})`
            );
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

    return res.status(500).json({ error: "Failed to process webhook. Retry scheduled." });
  }
}

handler.config = config;
module.exports = handler;
