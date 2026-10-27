/**
 * Sharflow — Subscription Plans & Entitlements Engine
 *
 * Single source of truth for plans, trial duration, feature matrix,
 * plan normalization, and access control resolution.
 */

const TRIAL_DAYS = 14;

const PLAN_CONFIG = {
  analytics: {
    key: "analytics",
    name: "Analytics",
    priceUsdMonthly: 9,
    providers: ["google_analytics"],
    urlInspection: false,
    description: "Daily automated monitoring for store traffic and conversion health via Google Analytics 4.",
    features: [
      "Daily email report (sent once per day)",
      "Google Analytics 4 traffic & sessions",
      "Landing pages & shopper engagement",
      "E-commerce funnel (view item, add to cart, checkout, purchases, revenue)",
      "AI referral traffic attribution (ChatGPT, Perplexity, Claude)",
      "Rule-based drop & anomaly detection",
      "Dashboard: Check my website now, CSV export, Email report",
    ],
  },
  complete: {
    key: "complete",
    name: "Complete",
    priceUsdMonthly: 19,
    providers: ["google_analytics", "google_search_console", "bing_webmaster"],
    urlInspection: true,
    description: "Full search and analytics monitoring: Google Analytics 4, Search Console, and Bing Webmaster.",
    features: [
      "Everything in Analytics",
      "Google Search Console (clicks, impressions, CTR, position, top pages & queries)",
      "Weekly URL Inspection (indexing + mobile usability, up to 10 URLs)",
      "Bing Webmaster performance & crawl issues",
      "Rule-based search visibility anomaly alerts",
      "Cross-channel organic and revenue comparison",
      "Full priority intelligence report",
    ],
  },
};

const ALL_PROVIDERS = [
  "google_analytics",
  "google_search_console",
  "bing_webmaster",
];

/**
 * Normalizes raw plan keys from various database states or inputs.
 * "analytics" -> "analytics"
 * "complete" | "pro" | "sharflow_pro" -> "complete"
 * "starter" / empty / unknown -> null
 *
 * @param {string} raw
 * @returns {"analytics"|"complete"|null}
 */
function normalizePlanKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "analytics") return "analytics";
  if (cleaned === "complete" || cleaned === "pro" || cleaned === "sharflow_pro") {
    return "complete";
  }
  return null;
}

/**
 * Determines whether a user currently has an active paid subscription.
 * Reuses the exact fields written by api/paddle-webhook.js (plan / subscriptionStatus / paddleSubscriptionStatus).
 *
 * @param {object} user
 * @returns {boolean}
 */
function isPaidActive(user) {
  if (!user) return false;
  const planKey = normalizePlanKey(user.plan);
  if (!planKey) return false;

  const status = (user.subscriptionStatus || user.paddleSubscriptionStatus || "").toLowerCase();
  if (status === "active" || status === "trialing") {
    return true;
  }
  // If subscriptionStatus is not explicitly set, but user has a recognized paid plan and is not canceled/past_due/paused/refunded
  if (!status && planKey) {
    return true;
  }
  return false;
}

/**
 * Resolves user entitlements based on plan, trial, admin status, and enforcement flag.
 *
 * @param {object} user - User document
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {boolean} [options.enforced] - Defaults to process.env.PLANS_ENFORCED === "true"
 * @param {string|string[]} [options.adminEmails] - Admin email list or comma-separated string
 * @returns {{
 *   enforced: boolean,
 *   status: "admin"|"trial"|"active"|"expired",
 *   planKey: "analytics"|"complete"|null,
 *   trialEndsAt: Date|null,
 *   trialDaysLeft: number|null,
 *   allowedProviders: string[],
 *   urlInspection: boolean,
 *   canRunMonitoring: boolean,
 *   needsTrialInit: boolean
 * }}
 */
function getEntitlements(user, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const enforced = options.enforced !== undefined
    ? Boolean(options.enforced)
    : process.env.PLANS_ENFORCED === "true";

  const rawAdmin = options.adminEmails !== undefined
    ? options.adminEmails
    : (process.env.ADMIN_EMAILS || "");
  const adminList = (Array.isArray(rawAdmin) ? rawAdmin : String(rawAdmin).split(","))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const email = (user?.email || "").trim().toLowerCase();
  const isAdmin = Boolean(email && adminList.includes(email));

  const needsTrialInit = Boolean(!user || !user.trialEndsAt);

  // 1. ADMIN BYPASS — full access
  if (isAdmin) {
    return {
      enforced,
      status: "admin",
      planKey: "complete",
      trialEndsAt: user?.trialEndsAt ? new Date(user.trialEndsAt) : null,
      trialDaysLeft: null,
      allowedProviders: [...ALL_PROVIDERS],
      urlInspection: true,
      canRunMonitoring: true,
      needsTrialInit,
    };
  }

  // 2. PAID ACTIVE
  if (isPaidActive(user)) {
    const planKey = normalizePlanKey(user.plan) || "complete";
    const planConfig = PLAN_CONFIG[planKey] || PLAN_CONFIG.complete;

    return {
      enforced,
      status: "active",
      planKey,
      trialEndsAt: user?.trialEndsAt ? new Date(user.trialEndsAt) : null,
      trialDaysLeft: null,
      allowedProviders: enforced ? [...planConfig.providers] : [...ALL_PROVIDERS],
      urlInspection: enforced ? planConfig.urlInspection : true,
      canRunMonitoring: true,
      needsTrialInit,
    };
  }

  // 3. TRIAL OR EXPIRED
  let trialEndsAt = null;
  let trialDaysLeft = 0;
  let isTrialActive = false;

  if (user?.trialEndsAt) {
    trialEndsAt = new Date(user.trialEndsAt);
    const diffMs = trialEndsAt.getTime() - now.getTime();
    if (diffMs > 0) {
      isTrialActive = true;
      trialDaysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    } else {
      isTrialActive = false;
      trialDaysLeft = 0;
    }
  } else {
    // Missing trialEndsAt -> needsTrialInit, trial not yet started, treat as fresh 14-day trial
    isTrialActive = true;
    trialDaysLeft = TRIAL_DAYS;
  }

  if (isTrialActive) {
    return {
      enforced,
      status: "trial",
      planKey: "complete", // Full Complete access during trial
      trialEndsAt,
      trialDaysLeft,
      allowedProviders: [...ALL_PROVIDERS],
      urlInspection: true,
      canRunMonitoring: true,
      needsTrialInit,
    };
  }

  // Trial expired and no active paid plan
  return {
    enforced,
    status: "expired",
    planKey: null,
    trialEndsAt,
    trialDaysLeft: 0,
    allowedProviders: enforced ? [] : [...ALL_PROVIDERS],
    urlInspection: enforced ? false : true,
    canRunMonitoring: enforced ? false : true,
    needsTrialInit: false,
  };
}

/**
 * Ensures trial dates are initialized on the user document.
 * Conditional update never overwrites an existing trialEndsAt.
 *
 * @param {import('mongodb').Db} db
 * @param {object} user
 * @param {Date} [now]
 * @returns {Promise<object>} The user with trialStartedAt and trialEndsAt set
 */
async function ensureTrial(db, user, now = new Date()) {
  if (!user) return user;
  if (user.trialEndsAt) return user;

  const trialStartedAt = now;
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  if (db && user.email) {
    try {
      const users = db.collection("users");
      await users.updateOne(
        { email: user.email.toLowerCase(), trialEndsAt: { $exists: false } },
        {
          $set: {
            trialStartedAt,
            trialEndsAt,
            updatedAt: now,
          },
        }
      );
    } catch (err) {
      console.warn(`[ensureTrial] Warning initializing trial for ${user.email}:`, err.message);
    }
  }

  user.trialStartedAt = trialStartedAt;
  user.trialEndsAt = trialEndsAt;
  return user;
}

module.exports = {
  TRIAL_DAYS,
  PLAN_CONFIG,
  ALL_PROVIDERS,
  normalizePlanKey,
  isPaidActive,
  getEntitlements,
  ensureTrial,
};
