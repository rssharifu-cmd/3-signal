/**
 * Unit Test Suite for Plans & Entitlements Engine
 *
 * Tests:
 * 1. Plan normalization (analytics, complete, legacy pro/sharflow_pro, starter, null)
 * 2. Paid active detection (Paddle fields compatibility)
 * 3. Entitlements - Admin bypass
 * 4. Entitlements - Active 14-day free trial (full Complete access)
 * 5. Entitlements - Expired trial when enforced=true vs enforced=false (blocking behavior)
 * 6. Entitlements - Paid active Analytics plan ($9/mo, GA4 only, no URL inspection)
 * 7. Entitlements - Paid active Complete plan ($19/mo, all sources, URL inspection)
 * 8. Entitlements - Legacy user missing trialEndsAt (needsTrialInit flag)
 * 9. ensureTrial conditional persistence logic
 *
 * Run with: node scripts/test-plans.js
 */

const assert = require("assert");
const {
  TRIAL_DAYS,
  PLAN_CONFIG,
  normalizePlanKey,
  isPaidActive,
  getEntitlements,
  ensureTrial,
} = require("../api/_lib/plans");

let totalTests = 0;
let passedTests = 0;

function it(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function itAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function run() {
  console.log("\n--- Testing api/_lib/plans.js ---");

  // ── 1. Plan Normalization ───────────────────────────────────────────────────
  console.log("\n[1] normalizePlanKey");
  it("normalizes 'analytics' to 'analytics'", () => {
    assert.strictEqual(normalizePlanKey("analytics"), "analytics");
    assert.strictEqual(normalizePlanKey("Analytics"), "analytics");
  });

  it("normalizes 'complete', 'pro', and 'sharflow_pro' to 'complete'", () => {
    assert.strictEqual(normalizePlanKey("complete"), "complete");
    assert.strictEqual(normalizePlanKey("Complete"), "complete");
    assert.strictEqual(normalizePlanKey("pro"), "complete");
    assert.strictEqual(normalizePlanKey("PRO"), "complete");
    assert.strictEqual(normalizePlanKey("sharflow_pro"), "complete");
  });

  it("normalizes 'starter', empty, and unknown values to null", () => {
    assert.strictEqual(normalizePlanKey("starter"), null);
    assert.strictEqual(normalizePlanKey(""), null);
    assert.strictEqual(normalizePlanKey(null), null);
    assert.strictEqual(normalizePlanKey(undefined), null);
    assert.strictEqual(normalizePlanKey("enterprise"), null);
  });

  // ── 2. Paid Active Detection ────────────────────────────────────────────────
  console.log("\n[2] isPaidActive");
  it("identifies active and trialing subscriptions as paid active", () => {
    assert.strictEqual(isPaidActive({ plan: "pro", subscriptionStatus: "active" }), true);
    assert.strictEqual(isPaidActive({ plan: "analytics", paddleSubscriptionStatus: "active" }), true);
    assert.strictEqual(isPaidActive({ plan: "complete", subscriptionStatus: "trialing" }), true);
  });

  it("identifies non-active subscription statuses as not active", () => {
    assert.strictEqual(isPaidActive({ plan: "pro", subscriptionStatus: "canceled" }), false);
    assert.strictEqual(isPaidActive({ plan: "complete", subscriptionStatus: "past_due" }), false);
    assert.strictEqual(isPaidActive({ plan: "complete", subscriptionStatus: "paused" }), false);
    assert.strictEqual(isPaidActive({ plan: "complete", subscriptionStatus: "refunded" }), false);
  });

  it("returns false for starter or missing plan regardless of subscriptionStatus", () => {
    assert.strictEqual(isPaidActive({ plan: "starter", subscriptionStatus: "active" }), false);
    assert.strictEqual(isPaidActive({ subscriptionStatus: "active" }), false);
    assert.strictEqual(isPaidActive(null), false);
  });

  // ── 3. Entitlements: Admin Bypass ───────────────────────────────────────────
  console.log("\n[3] getEntitlements - Admin Bypass");
  it("grants full Complete access to admins regardless of trial or subscription", () => {
    const adminUser = {
      email: "admin@example.com",
      plan: "starter",
      trialEndsAt: new Date(Date.now() - 1000000), // expired trial
    };

    const ent = getEntitlements(adminUser, { adminEmails: ["admin@example.com"], enforced: true });
    assert.strictEqual(ent.status, "admin");
    assert.strictEqual(ent.canRunMonitoring, true);
    assert.strictEqual(ent.urlInspection, true);
    assert.deepStrictEqual(ent.allowedProviders, ["google_analytics", "google_search_console", "bing_webmaster"]);
  });

  // ── 4. Entitlements: Active Free Trial ──────────────────────────────────────
  console.log("\n[4] getEntitlements - Active 14-day Free Trial");
  it("grants full Complete access during active trial", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const futureEndsAt = new Date("2026-11-05T12:00:00Z"); // 9 days left

    const trialUser = {
      email: "user@example.com",
      plan: "starter",
      trialEndsAt: futureEndsAt,
    };

    const ent = getEntitlements(trialUser, { now, enforced: true });
    assert.strictEqual(ent.status, "trial");
    assert.strictEqual(ent.trialDaysLeft, 9);
    assert.strictEqual(ent.canRunMonitoring, true);
    assert.strictEqual(ent.urlInspection, true);
    assert.deepStrictEqual(ent.allowedProviders, ["google_analytics", "google_search_console", "bing_webmaster"]);
    assert.strictEqual(ent.needsTrialInit, false);
  });

  // ── 5. Entitlements: Expired Trial & PLANS_ENFORCED flag ────────────────────
  console.log("\n[5] getEntitlements - Expired Trial (Enforced vs Non-enforced)");
  it("blocks monitoring when trial expired and enforced is TRUE", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const pastEndsAt = new Date("2026-10-20T12:00:00Z"); // expired 7 days ago

    const expiredUser = {
      email: "expired@example.com",
      trialEndsAt: pastEndsAt,
    };

    const ent = getEntitlements(expiredUser, { now, enforced: true });
    assert.strictEqual(ent.status, "expired");
    assert.strictEqual(ent.trialDaysLeft, 0);
    assert.strictEqual(ent.canRunMonitoring, false);
    assert.strictEqual(ent.urlInspection, false);
    assert.deepStrictEqual(ent.allowedProviders, []);
  });

  it("BLOCKS NOBODY when enforced is FALSE even if trial is expired", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const pastEndsAt = new Date("2026-10-20T12:00:00Z");

    const expiredUser = {
      email: "expired@example.com",
      trialEndsAt: pastEndsAt,
    };

    const ent = getEntitlements(expiredUser, { now, enforced: false });
    // Status and countdown reflect reality for UI display
    assert.strictEqual(ent.status, "expired");
    assert.strictEqual(ent.trialDaysLeft, 0);
    // But nobody is blocked when enforced=false
    assert.strictEqual(ent.canRunMonitoring, true);
    assert.strictEqual(ent.urlInspection, true);
    assert.deepStrictEqual(ent.allowedProviders, ["google_analytics", "google_search_console", "bing_webmaster"]);
  });

  // ── 6. Entitlements: Paid Analytics Plan ($9/mo) ────────────────────────────
  console.log("\n[6] getEntitlements - Paid Analytics Plan");
  it("restricts providers to GA4 and disables URL Inspection on Analytics plan", () => {
    const analyticsUser = {
      email: "store@example.com",
      plan: "analytics",
      subscriptionStatus: "active",
    };

    const ent = getEntitlements(analyticsUser, { enforced: true });
    assert.strictEqual(ent.status, "active");
    assert.strictEqual(ent.planKey, "analytics");
    assert.strictEqual(ent.canRunMonitoring, true);
    assert.strictEqual(ent.urlInspection, false);
    assert.deepStrictEqual(ent.allowedProviders, ["google_analytics"]);
  });

  // ── 7. Entitlements: Paid Complete Plan ($19/mo) ────────────────────────────
  console.log("\n[7] getEntitlements - Paid Complete Plan");
  it("allows all providers and enables URL Inspection on Complete plan", () => {
    const completeUser = {
      email: "store@example.com",
      plan: "complete",
      subscriptionStatus: "active",
    };

    const ent = getEntitlements(completeUser, { enforced: true });
    assert.strictEqual(ent.status, "active");
    assert.strictEqual(ent.planKey, "complete");
    assert.strictEqual(ent.canRunMonitoring, true);
    assert.strictEqual(ent.urlInspection, true);
    assert.deepStrictEqual(ent.allowedProviders, ["google_analytics", "google_search_console", "bing_webmaster"]);
  });

  // ── 8. Entitlements: Legacy User Without trialEndsAt ────────────────────────
  console.log("\n[8] getEntitlements - Legacy User Initialization");
  it("flags needsTrialInit: true when trialEndsAt is missing", () => {
    const legacyUser = {
      email: "legacy@example.com",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };

    const ent = getEntitlements(legacyUser);
    assert.strictEqual(ent.needsTrialInit, true);
    assert.strictEqual(ent.status, "trial");
    assert.strictEqual(ent.canRunMonitoring, true);
  });

  // ── 9. ensureTrial Logic ────────────────────────────────────────────────────
  console.log("\n[9] ensureTrial Database Helper");
  await itAsync("sets trialStartedAt and trialEndsAt without overwriting existing trial", async () => {
    const fixedNow = new Date("2026-10-27T12:00:00Z");
    let updatedFilter = null;
    let updatedDoc = null;

    const mockDb = {
      collection: (name) => {
        assert.strictEqual(name, "users");
        return {
          updateOne: async (filter, update) => {
            updatedFilter = filter;
            updatedDoc = update;
            return { modifiedCount: 1 };
          },
        };
      },
    };

    const existingUserNoTrial = {
      email: "Existing@Example.com",
      createdAt: new Date("2026-05-01T00:00:00Z"),
    };

    const res = await ensureTrial(mockDb, existingUserNoTrial, fixedNow);
    assert.strictEqual(updatedFilter.email, "existing@example.com");
    assert.deepStrictEqual(updatedFilter.trialEndsAt, { $exists: false });
    assert.strictEqual(res.trialStartedAt.toISOString(), fixedNow.toISOString());

    const expectedEnds = new Date(fixedNow.getTime() + 14 * 24 * 60 * 60 * 1000);
    assert.strictEqual(res.trialEndsAt.toISOString(), expectedEnds.toISOString());

    // Test that an existing trial is not overwritten
    const userWithTrial = {
      email: "has_trial@example.com",
      trialEndsAt: new Date("2026-11-01T00:00:00Z"),
    };
    const res2 = await ensureTrial(mockDb, userWithTrial, fixedNow);
    assert.strictEqual(res2.trialEndsAt.toISOString(), "2026-11-01T00:00:00.000Z");
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n================================`);
  console.log(`Tests: ${passedTests} passed, ${totalTests - passedTests} failed, ${totalTests} total`);
  console.log(`================================\n`);

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
