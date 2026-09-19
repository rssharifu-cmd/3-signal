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

  // ── TEST 6: Unified Pipeline Verification Across All Monitoring States ───
  console.log("🧪 Test 6: Verifying generateDailyIntelligence Across Monitoring States\n");

  const { getWatchdogEmailSubject, watchdogReportHtml } = require("../api/send");

  // Helper assertion
  function assert(condition, msg) {
    if (!condition) {
      throw new Error(`Assertion failed: ${msg}`);
    }
    console.log(`     ✅ ${msg}`);
  }

  // ── CASE A: Zero Connected Sources ─────────────────────────────────────────
  console.log("  📋 Case A: Zero connected data sources");
  const NO_SOURCES_USER = "test-no-sources@sharflow.online";
  await db.collection("users").updateOne(
    { email: NO_SOURCES_USER },
    {
      $set: {
        name: "No Sources User",
        email: NO_SOURCES_USER,
        plan: "starter",
        active: true,
        profile: { websiteUrl: "https://nosources-example.com" },
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  // Ensure no connected datasources
  await db.collection("datasources").deleteMany({ userEmail: NO_SOURCES_USER });

  const reportA = await generateDailyIntelligence(NO_SOURCES_USER, {
    targetDate: "2026-09-15",
    skipFetch: true,
  });

  assert(reportA.status === "no_sources", "reportA.status is 'no_sources'");
  assert(reportA.monitoringStatus === "no_sources", "reportA.monitoringStatus is 'no_sources'");
  assert(reportA.findingsCount === 0, "reportA findingsCount is 0");
  assert(reportA.intelligence?.status === "no_sources", "reportA intelligence.status is 'no_sources'");
  assert(reportA.intelligence?.aiCallSkipped === true, "reportA skipped LLM call (aiCallSkipped === true)");
  assert(!reportA.intelligence?.headline.toLowerCase().includes("all systems normal"), "reportA headline does NOT claim 'All systems normal'");
  assert(reportA.intelligence?.headline.toLowerCase().includes("not active") || reportA.intelligence?.headline.toLowerCase().includes("connect"), "reportA headline clearly states monitoring not active / connect source");
  assert(getWatchdogEmailSubject(reportA).includes("Monitoring not active"), "reportA email subject indicates monitoring not active");
  assert(!watchdogReportHtml({ report: reportA }).includes("ALL SYSTEMS NORMAL"), "reportA email HTML does not render 'ALL SYSTEMS NORMAL'");
  console.log("");

  // ── CASE B: Connected Source With Failed Fetch ────────────────────────────
  console.log("  📋 Case B: Connected data source with failed fetch (and no prior snapshots)");
  const FAILED_FETCH_USER = "test-failed-fetch@sharflow.online";
  await db.collection("users").updateOne(
    { email: FAILED_FETCH_USER },
    {
      $set: {
        name: "Failed Fetch User",
        email: FAILED_FETCH_USER,
        plan: "starter",
        active: true,
        profile: { websiteUrl: "https://failedfetch-example.com" },
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  // Clear any existing snapshots
  await db.collection("metric_snapshots").deleteMany({ userEmail: FAILED_FETCH_USER });
  // Add connected datasource with invalid encrypted token to trigger fetch error
  await db.collection("datasources").updateOne(
    { userEmail: FAILED_FETCH_USER, provider: "google_search_console" },
    {
      $set: {
        status: "connected",
        encryptedRefreshToken: "invalid-token-payload",
        selectedProperty: {
          id: "https://failedfetch-example.com/",
          name: "https://failedfetch-example.com/",
          url: "https://failedfetch-example.com/",
        },
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  const reportB = await generateDailyIntelligence(FAILED_FETCH_USER, {
    targetDate: "2026-09-15",
    skipFetch: false, // execute real fetch which fails gracefully
  });

  assert(reportB.status === "insufficient_data", "reportB.status is 'insufficient_data'");
  assert(reportB.monitoringStatus === "insufficient_data", "reportB.monitoringStatus is 'insufficient_data'");
  assert(reportB.findingsCount === 0, "reportB findingsCount is 0");
  assert(reportB.intelligence?.status === "insufficient_data", "reportB intelligence.status is 'insufficient_data'");
  assert(reportB.intelligence?.aiCallSkipped === true, "reportB skipped LLM call (aiCallSkipped === true)");
  assert(!reportB.intelligence?.headline.toLowerCase().includes("all systems normal"), "reportB headline does NOT claim 'All systems normal'");
  assert(reportB.intelligence?.headline.toLowerCase().includes("insufficient"), "reportB headline clearly states insufficient monitoring data");
  assert(reportB.fetchSummary?.providers?.some(p => p.status === "error" || p.available === false), "reportB fetchSummary tracks provider failure");
  assert(getWatchdogEmailSubject(reportB).includes("Gathering baseline data"), "reportB email subject indicates gathering baseline data");
  console.log("");

  // ── CASE C: Connected Source With Insufficient Historical Data (<2 Days) ─
  console.log("  📋 Case C: Connected data source with insufficient history (< 2 snapshots)");
  const INSUFFICIENT_HISTORY_USER = "test-insufficient-history@sharflow.online";
  await db.collection("users").updateOne(
    { email: INSUFFICIENT_HISTORY_USER },
    {
      $set: {
        name: "Insufficient History User",
        email: INSUFFICIENT_HISTORY_USER,
        plan: "starter",
        active: true,
        profile: { websiteUrl: "https://insufficient-history-example.com" },
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  await db.collection("datasources").updateOne(
    { userEmail: INSUFFICIENT_HISTORY_USER, provider: "google_search_console" },
    {
      $set: {
        status: "connected",
        encryptedRefreshToken: "test-token",
        selectedProperty: {
          id: "https://insufficient-history-example.com/",
          name: "https://insufficient-history-example.com/",
          url: "https://insufficient-history-example.com/",
        },
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
  // Clear old and seed ONLY 1 day snapshot
  await db.collection("metric_snapshots").deleteMany({ userEmail: INSUFFICIENT_HISTORY_USER });
  await saveMetricSnapshots([{
    userId: "test-insufficient-history-id",
    userEmail: INSUFFICIENT_HISTORY_USER,
    provider: "google_search_console",
    propertyRef: "https://insufficient-history-example.com/",
    date: "2026-09-15",
    metrics: { clicks: 80, impressions: 2000, ctr: 0.04, position: 11.2 },
    dimensions: { pages: [], queries: [] },
  }]);

  const reportC = await generateDailyIntelligence(INSUFFICIENT_HISTORY_USER, {
    targetDate: "2026-09-15",
    skipFetch: true,
  });

  assert(reportC.status === "insufficient_data", "reportC.status is 'insufficient_data'");
  assert(reportC.monitoringStatus === "insufficient_data", "reportC.monitoringStatus is 'insufficient_data'");
  assert(reportC.findingsCount === 0, "reportC findingsCount is 0");
  assert(reportC.intelligence?.status === "insufficient_data", "reportC intelligence.status is 'insufficient_data'");
  assert(reportC.intelligence?.aiCallSkipped === true, "reportC skipped LLM call (aiCallSkipped === true)");
  assert(!reportC.intelligence?.headline.toLowerCase().includes("all systems normal"), "reportC headline does NOT claim 'All systems normal'");
  assert(reportC.fetchSummary?.providers[0]?.available === false, "reportC provider marked unavailable due to <2 snapshots");
  console.log("");

  // ── CASE D: Valid Provider With Zero Anomalies (Legitimate Normal State) ──
  console.log("  📋 Case D: Valid provider with healthy, stable metrics (zero anomalies)");
  const STABLE_USER = "test-stable-normal@sharflow.online";
  await db.collection("users").updateOne(
    { email: STABLE_USER },
    {
      $set: {
        name: "Stable User",
        email: STABLE_USER,
        plan: "starter",
        active: true,
        profile: { websiteUrl: "https://stable-example.com" },
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  await db.collection("datasources").updateOne(
    { userEmail: STABLE_USER, provider: "google_search_console" },
    {
      $set: {
        status: "connected",
        encryptedRefreshToken: "test-token",
        selectedProperty: {
          id: "https://stable-example.com/",
          name: "https://stable-example.com/",
          url: "https://stable-example.com/",
        },
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
  // Clear old snapshots and seed 14 days of completely stable, non-anomalous metrics
  await db.collection("metric_snapshots").deleteMany({ userEmail: STABLE_USER });
  const stableSnapshots = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(anchorDate.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().split("T")[0];
    stableSnapshots.push({
      userId: "test-stable-id",
      userEmail: STABLE_USER,
      provider: "google_search_console",
      propertyRef: "https://stable-example.com/",
      date: dateStr,
      metrics: { clicks: 120, impressions: 3500, ctr: 0.0343, position: 9.8 },
      dimensions: {
        pages: [{ page: "https://stable-example.com/about", clicks: 40, impressions: 1000, ctr: 0.04, position: 8.0 }],
        queries: [{ query: "stable brand", clicks: 30, impressions: 800, ctr: 0.0375, position: 5.0 }],
      },
    });
  }
  await saveMetricSnapshots(stableSnapshots);

  const reportD = await generateDailyIntelligence(STABLE_USER, {
    targetDate: "2026-09-15",
    skipFetch: true,
  });

  assert(reportD.status === "stable", "reportD.status is 'stable'");
  assert(reportD.monitoringStatus === "active", "reportD.monitoringStatus is 'active'");
  assert(reportD.findingsCount === 0, "reportD findingsCount is 0");
  assert(reportD.intelligence?.status === "stable", "reportD intelligence.status is 'stable'");
  assert(reportD.intelligence?.aiCallSkipped === true, "reportD skipped LLM call (aiCallSkipped === true)");
  assert(reportD.intelligence?.headline.toLowerCase().includes("all systems normal"), "reportD headline legitimately states 'All systems normal'");
  assert(getWatchdogEmailSubject(reportD).includes("All systems normal"), "reportD email subject states 'All systems normal'");
  assert(watchdogReportHtml({ report: reportD }).includes("ALL SYSTEMS NORMAL"), "reportD email HTML includes 'ALL SYSTEMS NORMAL'");
  console.log("");

  // ── CASE E: Valid Provider With Real Anomaly Findings ──────────────────────
  console.log("  📋 Case E: Valid provider with genuine anomaly findings");
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

  const reportE = await generateDailyIntelligence(TEST_EMAIL, {
    targetDate: "2026-09-15",
    skipFetch: true, // Use the seeded 56-day test data with anomalies
  });

  assert(reportE.monitoringStatus === "active", "reportE.monitoringStatus is 'active'");
  assert(reportE.findingsCount > 0, "reportE findingsCount > 0");
  assert(reportE.status === "critical_attention" || reportE.status === "needs_attention", "reportE status indicates attention required");
  assert(Array.isArray(reportE.intelligence?.priorityRankedFindings) && reportE.intelligence.priorityRankedFindings.length > 0, "reportE has ranked findings");
  assert(!reportE.intelligence?.headline.toLowerCase().includes("all systems normal"), "reportE headline does NOT claim all systems normal");
  assert(getWatchdogEmailSubject(reportE).includes("Website changes detected"), "reportE email subject indicates website changes detected");
  console.log("");

  console.log("===============================================================");
  console.log("🎉 ALL 5 MONITORING STATE CASES (A through E) VERIFIED!");
  console.log("===============================================================");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Pipeline test failed:", err);
    process.exit(1);
  });
