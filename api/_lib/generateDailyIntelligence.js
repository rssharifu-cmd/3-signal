/**
 * Sharflow — Unified Daily Intelligence Pipeline Entry Point
 *
 * Exports generateDailyIntelligence(userId, options) which runs the full pipeline:
 * Step 1: Fetches performance data from connected sources (GSC, GA4, Bing).
 * Step 2: Persists normalized snapshots into `metric_snapshots` & computes comparison windows.
 * Step 3: Executes deterministic anomaly detection (pure code, NO LLM).
 * Step 4: Executes AI interpretation layer (LLM explains & prioritizes flagged findings only).
 *
 * Usable by scheduled background cron, CLI scripts, and on-demand dashboard "Run Now" triggers.
 */

const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
const { fetchGscPerformance } = require("./gsc");
const { fetchGa4Performance } = require("./ga4");
const { fetchBingPerformance } = require("./bing");
const {
  saveMetricSnapshots,
  loadComparisonWindows,
  getLatestSnapshotDate,
} = require("./metricSnapshots");
const { detectAnomalies } = require("./anomalies");
const { interpretFindings } = require("./intelligence");

/**
 * Resolves a user document by userId (ObjectId or string) or email.
 * @param {import('mongodb').Db} db
 * @param {string} userIdOrEmail
 * @returns {Promise<object|null>}
 */
async function resolveUser(db, userIdOrEmail) {
  if (!userIdOrEmail) return null;
  const users = db.collection("users");

  // Try direct email match
  if (typeof userIdOrEmail === "string" && userIdOrEmail.includes("@")) {
    const byEmail = await users.findOne({ email: userIdOrEmail.toLowerCase().trim() });
    if (byEmail) return byEmail;
  }

  // Try ObjectId
  if (ObjectId.isValid(userIdOrEmail)) {
    try {
      const byObjectId = await users.findOne({ _id: new ObjectId(userIdOrEmail) });
      if (byObjectId) return byObjectId;
    } catch {}
  }

  // Try string ID
  const byStringId = await users.findOne({ _id: userIdOrEmail });
  if (byStringId) return byStringId;

  // Fallback email search
  return users.findOne({ email: userIdOrEmail });
}

/**
 * Runs the end-to-end Daily Intelligence Watchdog pipeline for a single user.
 *
 * @param {string} userId - MongoDB user _id or email
 * @param {object} [options]
 * @param {string} [options.targetDate] - Anchor date YYYY-MM-DD (defaults to latest or yesterday)
 * @param {boolean} [options.skipFetch] - Skip API fetching and analyze existing snapshots
 * @param {boolean} [options.dryRun] - Run without saving report to database
 * @returns {Promise<object>} Complete daily intelligence report object
 */
async function generateDailyIntelligence(userId, options = {}) {
  const db = await getDb();
  const user = await resolveUser(db, userId);

  if (!user) {
    throw new Error(`User not found for identifier: ${userId}`);
  }

  const userEmail = user.email;
  const stringUserId = String(user._id);
  const now = new Date();

  // ── 1. RETRIEVE CONNECTED DATA SOURCES ────────────────────────────────────
  const datasourcesCol = db.collection("datasources");
  const connectedSources = await datasourcesCol
    .find({
      userEmail,
      status: "connected",
      encryptedRefreshToken: { $exists: true, $ne: "" },
    })
    .toArray();

  const activeSourcesWithProperty = connectedSources.filter(
    (s) => s.selectedProperty && s.selectedProperty.id
  );

  const fetchResults = [];
  const fetchErrors = [];
  const newSnapshots = [];

  // ── 2. DATA FETCHING (STEP 1) ─────────────────────────────────────────────
  if (!options.skipFetch && activeSourcesWithProperty.length > 0) {
    for (const source of activeSourcesWithProperty) {
      const provider = source.provider;
      const propertyRef = source.selectedProperty.id;

      try {
        let snapshots = [];

        if (provider === "google_search_console") {
          snapshots = await fetchGscPerformance({
            userEmail,
            propertyRef,
          });
        } else if (provider === "google_analytics") {
          snapshots = await fetchGa4Performance({
            userEmail,
            propertyRef,
          });
        } else if (provider === "bing_webmaster" || provider === "bing") {
          snapshots = await fetchBingPerformance({
            userEmail,
            propertyRef,
          });
        }

        // Tag with userId and userEmail
        snapshots.forEach((s) => {
          s.userId = stringUserId;
          s.userEmail = userEmail;
        });

        newSnapshots.push(...snapshots);
        fetchResults.push({
          provider,
          propertyRef,
          snapshotsCount: snapshots.length,
          dateRange: snapshots.length > 0 ? `${snapshots[0].date} to ${snapshots[snapshots.length - 1].date}` : "none",
          success: true,
        });

        // Update lastSuccessfulSync on datasource document
        await datasourcesCol.updateOne(
          { _id: source._id },
          { $set: { lastSuccessfulSync: now, updatedAt: now } }
        );
      } catch (err) {
        console.error(`[Watchdog Fetch Error] ${provider} for ${userEmail}:`, err.message);
        fetchErrors.push({
          provider,
          propertyRef,
          error: err.message,
          success: false,
        });
      }
    }

    // Persist all fetched snapshots into metric_snapshots collection (Step 2)
    if (newSnapshots.length > 0) {
      await saveMetricSnapshots(newSnapshots);
    }
  }

  // ── 3. LOAD HISTORICAL COMPARISON WINDOWS (STEP 2) ────────────────────────
  // Anchor target date: options.targetDate -> latest snapshot in DB -> yesterday
  let targetDate = options.targetDate;
  if (!targetDate) {
    targetDate = await getLatestSnapshotDate({ userEmail });
  }
  if (!targetDate) {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    targetDate = yesterday.toISOString().split("T")[0];
  }

  const comparisonWindowsByProvider = {};
  const providersToAnalyze = [
    ...new Set(activeSourcesWithProperty.map((s) => s.provider)),
  ];

  for (const prov of providersToAnalyze) {
    try {
      const windows = await loadComparisonWindows({
        userId: stringUserId,
        userEmail,
        provider: prov,
        targetDate,
      });
      comparisonWindowsByProvider[prov] = windows;
    } catch (err) {
      console.warn(`[Watchdog Windows Warning] Failed to load windows for ${prov}:`, err.message);
    }
  }

  // ── 4. DETERMINISTIC ANOMALY DETECTION (STEP 3) ───────────────────────────
  // Pure code rules, strictly zero LLM calls
  const findings = detectAnomalies({
    userId: stringUserId,
    userEmail,
    comparisonWindows: comparisonWindowsByProvider,
    userProfile: user.profile || {},
    targetDate,
  });

  // ── 5. AI INTERPRETATION LAYER (STEP 4) ───────────────────────────────────
  // The ONLY place an LLM is called. If findings is empty, AI call is skipped.
  const intelligence = await interpretFindings({
    findings,
    userContext: {
      userId: stringUserId,
      email: userEmail,
      name: user.name || userEmail.split("@")[0],
      profile: user.profile || {},
    },
    comparisonWindows: comparisonWindowsByProvider,
  });

  // ── 6. COMPILE FINAL REPORT ───────────────────────────────────────────────
  const reportId = new ObjectId();
  const report = {
    reportId: String(reportId),
    userId: stringUserId,
    userEmail,
    userName: user.name || userEmail.split("@")[0],
    targetDate,
    generatedAt: now,
    websiteUrl: user.profile?.websiteUrl || activeSourcesWithProperty[0]?.selectedProperty?.url || "",
    activeSources: activeSourcesWithProperty.map((s) => ({
      provider: s.provider,
      propertyId: s.selectedProperty.id,
      propertyName: s.selectedProperty.name,
      url: s.selectedProperty.url,
      lastSync: s.lastSuccessfulSync || now,
    })),
    dataFetchSummary: {
      fetchedCount: newSnapshots.length,
      providers: fetchResults,
      errors: fetchErrors,
    },
    comparisonWindows: comparisonWindowsByProvider,
    findingsCount: findings.length,
    findings,
    intelligence,
    status: intelligence.status || "stable",
  };

  // ── 7. PERSIST REPORT TO MONGODB ──────────────────────────────────────────
  if (!options.dryRun) {
    const reportsCol = db.collection("intelligence_reports");
    await reportsCol.updateOne(
      { userEmail, targetDate },
      {
        $set: {
          ...report,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true }
    );

    // Update user watchdog metadata
    await db.collection("users").updateOne(
      { email: userEmail },
      {
        $set: {
          "watchdog.lastRunAt": now,
          "watchdog.lastReportId": String(reportId),
          "watchdog.lastStatus": report.status,
          "watchdog.lastFindingsCount": findings.length,
          updatedAt: now,
        },
      }
    );
  }

  return report;
}

module.exports = {
  generateDailyIntelligence,
  resolveUser,
};
