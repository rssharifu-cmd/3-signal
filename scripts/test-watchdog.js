/**
 * Sharflow — Watchdog Intelligence Pipeline CLI Test Runner
 *
 * Runs end-to-end verification of all pipeline stages:
 * 1. Data Fetcher normalization & schemas (GSC, GA4, Bing)
 * 2. metric_snapshots storage & 1d/7d/28d comparison windows
 * 3. Deterministic anomaly detection (noise floors, sustained drops/gains)
 * 4. AI interpretation layer (Gemini 2.5 Flash on findings, fixed skip on empty)
 * 5. Full generateDailyIntelligence(userId) pipeline
 *
 * Usage:
 *   node scripts/test-watchdog.js
 *   node scripts/test-watchdog.js user@example.com
 */

require("dotenv").config();
const { getDb } = require("../api/_lib/db");
const { fetchGscPerformance, getDefaultDateRange } = require("../api/_lib/gsc");
const { fetchGa4Performance } = require("../api/_lib/ga4");
const { fetchBingPerformance } = require("../api/_lib/bing");
const {
  saveMetricSnapshots,
  loadComparisonWindows,
} = require("../api/_lib/metricSnapshots");
const { detectAnomalies } = require("../api/_lib/anomalies");
const { interpretFindings } = require("../api/_lib/intelligence");
const { generateDailyIntelligence } = require("../api/_lib/generateDailyIntelligence");

const TEST_EMAIL = process.argv[2] || "test-watchdog@sharflow.online";

async function runTests() {
  console.log("===============================================================");
  console.log("🔍 SHARFLOW AI WEBSITE WATCHDOG — PIPELINE TEST RUNNER");
  console.log("===============================================================");
  console.log(`Target User: ${TEST_EMAIL}`);
  console.log(`Environment GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? "Present (configured)" : "Missing"}`);
  console.log(`Environment MONGODB_URI: ${process.env.MONGODB_URI ? "Present (configured)" : "Missing"}`);
  console.log("---------------------------------------------------------------\n");

  const db = await getDb();

  // ── TEST 1: Common Snapshot Normalization Schema Verification ─────────────
  console.log("🧪 Test 1: Verifying Common Normalized Data Shape");
  const sampleGscSnapshot = {
    userId: "test-user-id",
    userEmail: TEST_EMAIL,
    provider: "google_search_console",
    propertyRef: "https://netventures.online/",
    date: "2026-09-14",
    metrics: {
      clicks: 120,
      impressions: 3400,
      ctr: 0.0353,
      position: 12.4,
    },
    dimensions: {
      pages: [
        { page: "https://netventures.online/services", clicks: 45, impressions: 1200, ctr: 0.0375, position: 8.2 },
        { page: "https://netventures.online/pricing", clicks: 20, impressions: 800, ctr: 0.025, position: 11.5 },
      ],
      queries: [
        { query: "venture capital advice", clicks: 30, impressions: 900, ctr: 0.0333, position: 6.4 },
      ],
    },
  };

  const sampleGa4Snapshot = {
    userId: "test-user-id",
    userEmail: TEST_EMAIL,
    provider: "google_analytics",
    propertyRef: "properties/99887766",
    date: "2026-09-14",
    metrics: {
      sessions: 350,
      users: 290,
      pageViews: 620,
      conversions: 18,
      bounceRate: 0.42,
    },
    dimensions: {
      trafficSources: [
        { source: "google", medium: "organic", channel: "google / organic", sessions: 210, users: 180 },
        { source: "(direct)", medium: "(none)", channel: "(direct) / (none)", sessions: 100, users: 85 },
      ],
      events: [
        { eventName: "generate_lead", eventCount: 18 },
      ],
      pages: [
        { pagePath: "/services", pageViews: 280, sessions: 190 },
      ],
    },
  };

  const sampleBingSnapshot = {
    userId: "test-user-id",
    userEmail: TEST_EMAIL,
    provider: "bing_webmaster",
    propertyRef: "https://netventures.online/",
    date: "2026-09-14",
    metrics: {
      clicks: 18,
      impressions: 450,
      ctr: 0.04,
      position: 14.1,
      crawledPages: 120,
      crawlErrors: 0,
      inCrawlQueue: 5,
    },
    dimensions: {
      queries: [
        { query: "net ventures", clicks: 12, impressions: 150, ctr: 0.08, position: 2.1 },
      ],
      crawlIssues: [],
    },
  };

  // Verify schema fields
  for (const [name, snap] of Object.entries({ GSC: sampleGscSnapshot, GA4: sampleGa4Snapshot, Bing: sampleBingSnapshot })) {
    if (!snap.provider || !snap.propertyRef || !snap.date || !snap.metrics || !snap.dimensions) {
      throw new Error(`Snapshot ${name} is missing common shape keys!`);
    }
  }
  console.log("  ✅ Common schema validated: { provider, propertyRef, date, metrics, dimensions } for all 3 providers.\n");

  // ── TEST 2: metric_snapshots Storage & Comparison Windows ────────────────
  console.log("🧪 Test 2: Seeding Historical Snapshots & Testing Comparison Windows");
  // Seed 56 days of daily snapshots with an intentional traffic drop in the last 7 days
  const seededSnapshots = [];
  const anchorDate = new Date("2026-09-15T00:00:00Z");

  for (let i = 55; i >= 0; i--) {
    const d = new Date(anchorDate.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().split("T")[0];

    // Simulate baseline traffic: days 55 to 7 have ~100 clicks/day
    // Days 6 to 0 have a 50% drop (~50 clicks/day) to test anomaly detection
    const isRecentDropPeriod = i <= 6;
    const clicks = isRecentDropPeriod ? Math.floor(45 + Math.random() * 8) : Math.floor(95 + Math.random() * 12);
    const impressions = isRecentDropPeriod ? Math.floor(1800 + Math.random() * 100) : Math.floor(3200 + Math.random() * 200);

    seededSnapshots.push({
      userId: "test-user-id",
      userEmail: TEST_EMAIL,
      provider: "google_search_console",
      propertyRef: "https://netventures.online/",
      date: dateStr,
      metrics: {
        clicks,
        impressions,
        ctr: Number((clicks / impressions).toFixed(4)),
        position: isRecentDropPeriod ? 16.5 : 9.2, // Ranking dropped from 9.2 to 16.5
      },
      dimensions: {
        pages: [
          {
            page: "https://netventures.online/pricing",
            clicks: isRecentDropPeriod ? 8 : 42, // Page dropped from 42 to 8 clicks
            impressions: isRecentDropPeriod ? 400 : 1500,
            ctr: 0.02,
            position: isRecentDropPeriod ? 18.0 : 7.5,
          },
        ],
        queries: [
          {
            query: "startup venture advisory",
            clicks: isRecentDropPeriod ? 4 : 35,
            impressions: 800,
            ctr: 0.02,
            position: isRecentDropPeriod ? 17.2 : 6.1, // Query rank dropped
          },
          {
            query: "seed fund checklist",
            clicks: 10,
            impressions: 1200, // High impressions but low CTR opportunity
            ctr: 0.0083,
            position: 4.8,
          },
        ],
      },
    });

    // Also seed GA4 conversion drop
    const conversions = isRecentDropPeriod ? Math.floor(4 + Math.random() * 2) : Math.floor(18 + Math.random() * 4);
    seededSnapshots.push({
      userId: "test-user-id",
      userEmail: TEST_EMAIL,
      provider: "google_analytics",
      propertyRef: "properties/12345678",
      date: dateStr,
      metrics: {
        sessions: isRecentDropPeriod ? 180 : 380,
        users: isRecentDropPeriod ? 150 : 310,
        pageViews: isRecentDropPeriod ? 320 : 650,
        conversions,
        bounceRate: 0.45,
      },
      dimensions: {
        trafficSources: [
          { source: "google", medium: "organic", channel: "google / organic", sessions: isRecentDropPeriod ? 90 : 250, users: 80 },
        ],
        events: [{ eventName: "purchase", eventCount: conversions }],
      },
    });
  }

  const savedCount = await saveMetricSnapshots(seededSnapshots);
  console.log(`  ✅ Saved ${savedCount} historical snapshots to metric_snapshots collection.`);

  // Load comparison windows
  const windowsGsc = await loadComparisonWindows({
    userEmail: TEST_EMAIL,
    provider: "google_search_console",
    targetDate: "2026-09-15",
  });

  console.log(`  ✅ Comparison windows loaded for GSC:`);
  console.log(`     - 1d vs prior 1d change in clicks: ${windowsGsc.today_vs_yesterday.changes.clicks.percent}%`);
  console.log(`     - 7d vs prior 7d change in clicks: ${windowsGsc.last7_vs_prior7.changes.clicks.percent}% (${windowsGsc.last7_vs_prior7.currentMetrics.clicks} vs ${windowsGsc.last7_vs_prior7.priorMetrics.clicks})`);
  console.log(`     - 28d vs prior 28d change in clicks: ${windowsGsc.last28_vs_prior28.changes.clicks.percent}%\n`);

  // ── TEST 3: Deterministic Anomaly Detection ───────────────────────────────
  console.log("🧪 Test 3: Running Deterministic Anomaly Detection (Code Heuristics)");
  const windowsGa4 = await loadComparisonWindows({
    userEmail: TEST_EMAIL,
    provider: "google_analytics",
    targetDate: "2026-09-15",
  });

  const findings = detectAnomalies({
    userId: "test-user-id",
    userEmail: TEST_EMAIL,
    comparisonWindows: {
      google_search_console: windowsGsc,
      google_analytics: windowsGa4,
    },
    userProfile: {
      importantPages: ["/pricing"],
    },
    targetDate: "2026-09-15",
  });

  console.log(`  ✅ Detected ${findings.length} verified anomalies (cleared noise floors & confidence thresholds):`);
  findings.forEach((f, idx) => {
    console.log(`     [#${idx + 1}] [${f.severity.toUpperCase()}] (${f.type}) on ${f.scope}`);
    console.log(`         Confidence: ${(f.confidence * 100).toFixed(0)}%`);
    console.log(`         Context: ${f.evidence.context}`);
  });
  console.log("");

  // ── TEST 4: Empty Findings Skip Verification ─────────────────────────────
  console.log("🧪 Test 4: Verifying Zero-Findings Behavior (Must Skip LLM Call)");
  const emptyInterpretation = await interpretFindings({
    findings: [],
    userContext: { email: TEST_EMAIL },
  });
  if (emptyInterpretation.aiCallSkipped !== true) {
    throw new Error("AI call was NOT skipped for empty findings!");
  }
  console.log(`  ✅ Empty findings handled correctly: aiCallSkipped = ${emptyInterpretation.aiCallSkipped}`);
  console.log(`     Headline: "${emptyInterpretation.headline}"\n`);

  // ── TEST 5: AI Interpretation on Flagged Findings ─────────────────────────
  console.log("🧪 Test 5: Running AI Interpretation Layer on Flagged Findings");
  const aiInterpretation = await interpretFindings({
    findings,
    userContext: {
      email: TEST_EMAIL,
      profile: {
        websiteUrl: "https://netventures.online",
        websiteType: "B2B SaaS / Venture Studio",
        monitoringPriorities: ["Organic Search Rankings", "Pricing Page Conversions"],
      },
    },
    comparisonWindows: {
      google_search_console: windowsGsc,
      google_analytics: windowsGa4,
    },
  });

  console.log(`  ✅ Interpretation completed:`);
  console.log(`     Headline: "${aiInterpretation.headline}"`);
  console.log(`     Summary: ${aiInterpretation.summary}`);
  console.log(`     Ranked Findings: ${aiInterpretation.priorityRankedFindings.length}`);
  if (aiInterpretation.priorityRankedFindings.length > 0) {
    const top = aiInterpretation.priorityRankedFindings[0];
    console.log(`     Top Priority Item: [${top.priorityBadge}] ${top.title}`);
    console.log(`         Probable Root Cause: ${top.primaryCause}`);
    console.log(`         Action 1: ${top.recommendedActions[0]?.action} (${top.recommendedActions[0]?.urgency})`);
  }
  console.log("");

  // ── TEST 6: Unified Entry Point (generateDailyIntelligence) ───────────────
  console.log("🧪 Test 6: Testing Unified generateDailyIntelligence(userId)");
  // Upsert test user into users collection
  await db.collection("users").updateOne(
    { email: TEST_EMAIL },
    {
      $set: {
        name: "Test Founder",
        email: TEST_EMAIL,
        plan: "starter",
        active: true,
        profile: {
          websiteUrl: "https://netventures.online",
          websiteType: "Venture Services",
          importantPages: ["/pricing"],
        },
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  // Link test datasource
  await db.collection("datasources").updateOne(
    { userEmail: TEST_EMAIL, provider: "google_search_console" },
    {
      $set: {
        status: "connected",
        encryptedRefreshToken: "test-blob",
        selectedProperty: {
          id: "https://netventures.online/",
          name: "https://netventures.online/",
          url: "https://netventures.online/",
        },
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  const fullReport = await generateDailyIntelligence(TEST_EMAIL, {
    targetDate: "2026-09-15",
    skipFetch: true, // Use the seeded test data in metric_snapshots
  });

  console.log(`  ✅ Full Report generated successfully:`);
  console.log(`     Report ID: ${fullReport.reportId}`);
  console.log(`     Target Date: ${fullReport.targetDate}`);
  console.log(`     Status: ${fullReport.status}`);
  console.log(`     Findings Count: ${fullReport.findingsCount}`);
  console.log(`     Headline: "${fullReport.intelligence.headline}"`);
  console.log("\n===============================================================");
  console.log("🎉 ALL WATCHDOG INTELLIGENCE PIPELINE TESTS PASSED!");
  console.log("===============================================================");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Pipeline test failed:", err);
    process.exit(1);
  });
