const { verified } = require("./accountSecurity");
/**
 * Sharflow — Unified Daily Intelligence Pipeline Entry Point
 *
 * Exports generateDailyIntelligence(userId, options) which runs the full pipeline:
 * Step 1: Fetches performance data from connected sources (GSC, GA4, Bing).
 * Step 2: Persists normalized snapshots into `metric_snapshots` & computes comparison windows.
 * Step 3: Executes deterministic anomaly detection (pure code, NO LLM).
 * Step 4: Explains and prioritizes findings locally without AI or research requests.
 *
 * Usable by scheduled background cron, CLI scripts, and on-demand dashboard "Run Now" triggers.
 */

const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
const { fetchGscPerformance } = require("./gsc");
const {
  inspectPropertyUrls,
  saveUrlInspection,
  loadLatestUrlInspection,
  isInspectionDue,
} = require("./gscUrlInspection");
const { fetchGa4Performance } = require("./ga4");
const { fetchBingPerformance } = require("./bing");
const {
  saveMetricSnapshots,
  loadComparisonWindows,
  providerDate,
  shiftDate,
  validDate,
} = require("./metricSnapshots");
const { detectAnomalies } = require("./anomalies");
const {
  interpretFindings,
  buildNoSourcesInterpretation,
  buildInsufficientDataInterpretation,
} = require("./intelligence");
const { normalizeMonitoringPreferences } = require("./preferences");

const { getEntitlements } = require("./plans");

async function preservePreviousEvidence(db, report) {
  if (report.status!=='insufficient_data' && report.status!=='no_sources' && !report.coverageIncomplete) return;
  const prior=await db.collection('intelligence_reports').findOne({userEmail:report.userEmail,targetDate:report.targetDate});
  if (!prior) return;
  const verified=(prior.findings || []).filter(f=>f.evidence && f.confidence>=0.7);
  report.previousVerifiedEvidence=verified.length ? {reportId:prior.reportId,generatedAt:prior.generatedAt,currentlyRevalidated:false,findings:verified} : prior.previousVerifiedEvidence || null;
}

/**
 * Maps raw provider identifiers to display labels.
 * @param {string} provider
 * @returns {string}
 */
function getProviderDisplayName(provider) {
  if (provider === "google_search_console") return "Google Search Console";
  if (provider === "google_analytics") return "Google Analytics 4";
  if (provider === "bing_webmaster" || provider === "bing") return "Bing Webmaster Tools";
  return provider;
}

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

  if (!verified(user) || user.configurationReviewRequired) throw new Error("Verified and reviewed account required.");
  const userEmail = user.email;
  const stringUserId = String(user._id);
  const now = new Date();
  if (options.targetDate && (!validDate(options.targetDate) || options.targetDate > shiftDate(now.toISOString().slice(0,10),-1))) throw Error("Report target must be a valid completed UTC day");

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
    (s) => s.selectedProperty && s.selectedProperty.id && (!user.integrationResetAt || s.ownershipVerifiedAt >= user.integrationResetAt)
  );

  // Resolve plan entitlements and allowed providers
  const entitlements = getEntitlements(user);
  const allowedProvidersSet = new Set(entitlements.allowedProviders || []);

  const allowedSources = activeSourcesWithProperty.filter((s) =>
    allowedProvidersSet.has(s.provider)
  );
  const notInPlanSources = activeSourcesWithProperty.filter(
    (s) => !allowedProvidersSet.has(s.provider)
  );

  // ── REQUIREMENT 2: ZERO ALLOWED CONNECTED DATA SOURCES CHECK ─────────────
  // If zero allowed sources connected, short-circuit immediately:
  // - Return clear "no_sources" / "Monitoring not active" state
  // - Do NOT call Gemini, external research, or invent metrics
  if (allowedSources.length === 0) {
    const targetDate = options.targetDate || shiftDate(now.toISOString().slice(0,10),-1);

    const reportId = new ObjectId();
    let intelligence;
    if (entitlements.planKey === "analytics" && notInPlanSources.length > 0) {
      intelligence = {
        headline: "Monitoring not active · Connect your store data",
        summary: "Your plan monitors Google Analytics. Connect GA4 or switch to Complete.",
        status: "no_sources",
        recommendations: [
          {
            title: "Connect Google Analytics 4",
            description: "Your plan monitors Google Analytics. Connect GA4 or switch to Complete.",
            actionUrl: "#sources",
          },
        ],
      };
    } else {
      intelligence = buildNoSourcesInterpretation();
    }

    const emptySummary = {
      fetchedCount: 0,
      providers: notInPlanSources.map((s) => ({
        provider: s.provider,
        propertyRef: s.selectedProperty?.id,
        status: "not_in_plan",
        available: false,
        success: true,
        snapshotsCount: 0,
        error: null,
        reason: "Not included in your plan",
      })),
      errors: [],
    };

    const notInPlanActiveSources = notInPlanSources.map((s) => ({
      provider: s.provider,
      propertyId: s.selectedProperty.id,
      propertyName: s.selectedProperty.name,
      url: s.selectedProperty.url,
      lastSync: s.lastSuccessfulSync || null,
      status: "not_in_plan",
      text: "Not included in your plan",
      reason: "Not included in your plan",
      error: null,
    }));

    const report = {
      reportId: String(reportId),
      userId: stringUserId,
      userEmail,
      userName: user.name || userEmail.split("@")[0],
      targetDate,
      generatedAt: now,
      websiteUrl: user.profile?.websiteUrl || "",
      monitoringStatus: "no_sources",
      status: "no_sources",
      activeSources: notInPlanActiveSources,
      dataFetchSummary: emptySummary,
      fetchSummary: emptySummary,
      comparisonWindows: {},
      findingsCount: 0,
      findings: [],
      externalResearch: [],
      intelligence,
      sourceEvidence: [],
    };

    if (!options.dryRun) {
      await preservePreviousEvidence(db,report);
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

      await db.collection("users").updateOne(
        { email: userEmail },
        {
          $set: {
            "watchdog.lastRunAt": now,
            "watchdog.lastReportId": String(reportId),
            "watchdog.lastStatus": "no_sources",
            "watchdog.lastMonitoringStatus": "no_sources",
            "watchdog.lastFindingsCount": 0,
            updatedAt: now,
          },
        }
      );
    }

    return report;
  }

  const fetchResults = [];
  const fetchErrors = [];
  const newSnapshots = [];

  // ── 2. DATA FETCHING (STEP 1) ─────────────────────────────────────────────
  if (!options.skipFetch && allowedSources.length > 0) {
    for (const source of allowedSources) {
      const provider = source.provider;
      const propertyRef = source.selectedProperty.id;

      try {
        let snapshots = [];

        if (provider === "google_search_console") {
          snapshots = await fetchGscPerformance({
            userEmail,
            propertyRef,
            endDate: providerDate(provider,now),
            startDate: shiftDate(providerDate(provider,now),-55),
          });
        } else if (provider === "google_analytics") {
          snapshots = await fetchGa4Performance({
            userEmail,
            propertyRef,
            endDate: providerDate(provider,now),
            startDate: shiftDate(providerDate(provider,now),-55),
          });
        } else if (provider === "bing_webmaster" || provider === "bing") {
          snapshots = await fetchBingPerformance({
            userEmail,
            propertyRef,
            endDate: providerDate(provider,now),
            startDate: shiftDate(providerDate(provider,now),-55),
          });
        }

        if (Array.isArray(snapshots) && snapshots.some(row=>row.dataQuality?.daily===false)) throw Error('Daily totals are incomplete, thresholded or sampled');
        if (!Array.isArray(snapshots) || snapshots.length===0) throw Error('No observed daily rows returned; zero traffic cannot be inferred');
        if (snapshots.some(row=>row.provider!==provider || String(row.propertyRef)!==String(propertyRef))) throw Error('Provider returned mismatched property evidence');
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
  const targetDate = options.targetDate || shiftDate(now.toISOString().slice(0,10),-1);

  const comparisonWindowsByProvider = {};
  const usableWindowsByProvider = {};
  const usableProviders = [];
  const unusableProviders = [];

  const providersToAnalyze = [
    ...new Set(allowedSources.map((s) => s.provider)),
  ];

  for (const prov of providersToAnalyze) {
    const fetchErr = fetchErrors.find((e) => e.provider === prov);
    const sourceObj = activeSourcesWithProperty.find((s) => s.provider === prov);
    const displayName = getProviderDisplayName(prov);

    if (fetchErr) {
      unusableProviders.push({
        provider: prov,
        name: displayName,
        propertyRef: sourceObj?.selectedProperty?.id,
        reason: `Fetch failed: ${fetchErr.error || "Connection error"}`,
        error: fetchErr.error,
      });
      continue;
    }

    let windows = null;
    try {
      windows = await loadComparisonWindows({
        userId: stringUserId,
        userEmail,
        provider: prov,
        propertyRef: sourceObj?.selectedProperty?.id,
        targetDate,
        now,
      });
      comparisonWindowsByProvider[prov] = windows;
    } catch (err) {
      console.warn(`[Watchdog Windows Warning] Failed to load windows for ${prov}:`, err.message);
    }

    const totalLoaded = windows?.totalSnapshotsLoaded || 0;
    const weeklyComplete=windows?.last7_vs_prior7?.eligible === true;
    if (!weeklyComplete) {
      unusableProviders.push({
        provider: prov,
        name: displayName,
        propertyRef: sourceObj?.selectedProperty?.id,
        reason: totalLoaded === 0
          ? "No metric snapshots found for this provider"
          : "Comparison requires complete, fresh, property-isolated current and prior seven-day periods",
        snapshotsLoaded: totalLoaded,
      });
    } else {
      usableProviders.push({
        provider: prov,
        name: displayName,
        propertyRef: sourceObj?.selectedProperty?.id,
        snapshotsLoaded: totalLoaded,
        partialCoverage: Object.values(windows).some(w=>w && typeof w==='object' && w.window && !w.eligible) ||
          [windows.last7_vs_prior7.currentMetrics,windows.last7_vs_prior7.priorMetrics].some(m=> (prov==='google_analytics' ? ['sessions','conversions','revenue','addToCartCount','checkoutCount','purchaseCount','checkoutToPurchaseRate','engagementRate'] : ['clicks','impressions','position']).some(k=>m[k]===null)),
      });
      usableWindowsByProvider[prov] = windows;
    }
  }

  // ── REQUIREMENT 3: INSUFFICIENT DATA CHECK ────────────────────────────────
  // If ALL connected providers fail or provide no usable comparison data:
  // - Return "insufficient_data" state rather than "All systems normal"
  // - Do NOT call Gemini
  // - Do NOT call external research
  // - Do NOT invent metrics
  if (usableProviders.length === 0) {
    const reportId = new ObjectId();
    const notInPlanProviderSummaries = notInPlanSources.map((s) => ({
      provider: s.provider,
      propertyRef: s.selectedProperty?.id,
      status: "not_in_plan",
      available: false,
      success: true,
      snapshotsCount: 0,
      error: null,
      reason: "Not included in your plan",
    }));

    const notInPlanSourceEntries = notInPlanSources.map((s) => ({
      provider: s.provider,
      propertyId: s.selectedProperty.id,
      propertyName: s.selectedProperty.name,
      url: s.selectedProperty.url,
      lastSync: s.lastSuccessfulSync || null,
      status: "not_in_plan",
      text: "Not included in your plan",
      reason: "Not included in your plan",
      error: null,
    }));

    const fetchSummary = {
      fetchedCount: newSnapshots.length,
      providers: [
        ...allowedSources.map((source) => {
          const prov = source.provider;
          const fetchRes = fetchResults.find((r) => r.provider === prov);
          const fetchErr = fetchErrors.find((e) => e.provider === prov);
          const isUnusable = unusableProviders.find((u) => u.provider === prov);
          return {
            provider: prov,
            propertyRef: source.selectedProperty?.id,
            status: fetchErr ? "error" : "unavailable",
            available: false,
            success: !fetchErr,
            snapshotsCount: fetchRes?.snapshotsCount || 0,
            error: fetchErr?.error || null,
            reason: isUnusable?.reason || null,
          };
        }),
        ...notInPlanProviderSummaries,
      ],
      errors: fetchErrors,
    };

    const intelligence = buildInsufficientDataInterpretation(unusableProviders);
    const websiteUrl = user.profile?.websiteUrl || allowedSources[0]?.selectedProperty?.url || "";

    const report = {
      reportId: String(reportId),
      userId: stringUserId,
      userEmail,
      userName: user.name || userEmail.split("@")[0],
      targetDate,
      generatedAt: now,
      websiteUrl,
      monitoringStatus: "insufficient_data",
      status: "insufficient_data",
      activeSources: [
        ...allowedSources.map((s) => {
          const fetchErr = fetchErrors.find((e) => e.provider === s.provider);
          const unusable = unusableProviders.find((u) => u.provider === s.provider);
          return {
            provider: s.provider,
            propertyId: s.selectedProperty.id,
            propertyName: s.selectedProperty.name,
            url: s.selectedProperty.url,
            lastSync: s.lastSuccessfulSync || null,
            status: fetchErr ? "error" : "insufficient_data",
            error: fetchErr?.error || null,
            reason: unusable?.reason || null,
          };
        }),
        ...notInPlanSourceEntries,
      ],
      dataFetchSummary: fetchSummary,
      fetchSummary,
      comparisonWindows: comparisonWindowsByProvider,
      findingsCount: 0,
      findings: [],
      externalResearch: [],
      intelligence,
      sourceEvidence: unusableProviders.map((u) => `${u.name} (Unavailable: ${u.reason})`),
    };

    if (!options.dryRun) {
      await preservePreviousEvidence(db,report);
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

      await db.collection("users").updateOne(
        { email: userEmail },
        {
          $set: {
            "watchdog.lastRunAt": now,
            "watchdog.lastReportId": String(reportId),
            "watchdog.lastStatus": "insufficient_data",
            "watchdog.lastMonitoringStatus": "insufficient_data",
            "watchdog.lastFindingsCount": 0,
            updatedAt: now,
          },
        }
      );
    }

    return report;
  }

  // Weekly GSC URL Inspection supplement (indexing status + mobile usability)
  // Gated by entitlements.urlInspection (Complete plan or trial)
  let urlInspectionResult = null;
  const usableGsc = usableProviders.find((u) => u.provider === "google_search_console");
  if (entitlements.urlInspection && usableGsc && usableGsc.propertyRef) {
    try {
      urlInspectionResult = await loadLatestUrlInspection(userEmail, usableGsc.propertyRef);
      if (!options.skipFetch && isInspectionDue(urlInspectionResult)) {
        const gscWindows = usableWindowsByProvider.google_search_console;
        const gscPages =
          gscWindows?.last28_vs_prior28?.currentDimensions?.pages ||
          gscWindows?.last7_vs_prior7?.currentDimensions?.pages ||
          [];
        const inspectedItems = await inspectPropertyUrls(
          userEmail,
          usableGsc.propertyRef,
          user.profile || {},
          gscPages
        );
        urlInspectionResult = await saveUrlInspection(
          stringUserId,
          userEmail,
          usableGsc.propertyRef,
          inspectedItems
        );
      }
    } catch (inspectErr) {
      console.warn(`[Watchdog URL Inspection Warning] ${userEmail}:`, inspectErr.message);
      urlInspectionResult = null;
    }
  }

  // Analyze ONLY providers with usable comparison data.
  // Missing/failed providers do not generate spurious findings.
  const findings = detectAnomalies({
    userId: stringUserId,
    userEmail,
    comparisonWindows: usableWindowsByProvider,
    userProfile: user.profile || {},
    targetDate,
    urlInspection: urlInspectionResult,
  });

  const coverageIncomplete=unusableProviders.length>0 || usableProviders.some(p=>p.partialCoverage) ||
    Object.values(usableWindowsByProvider).some(w=>!w.last7_vs_prior7.coverage.dimensionsComplete || !w.last7_vs_prior7.coverage.unitsCompatible) ||
    newSnapshots.some(row=>row.dataQuality?.warnings?.length || Object.values(row.dataQuality?.dimensions || {}).some(value=>value===false));

  // Never transmit customer findings or query terms to AI/research services.
  const websiteUrl = user.profile?.websiteUrl || activeSourcesWithProperty[0]?.selectedProperty?.url || "";
  const externalResearch = [];

  const userPreferences = normalizeMonitoringPreferences(
    user.profile?.monitoringPriorities,
    user.profile?.websiteType
  );

  let intelligence = await interpretFindings({
    findings,
    userContext: {
      userId: stringUserId,
      email: userEmail,
      name: user.name || userEmail.split("@")[0],
      profile: user.profile || {},
      websiteUrl,
      userPreferences,
    },
    comparisonWindows: usableWindowsByProvider,
    externalResearch,
    usableProviders,
    unusableProviders,
  });

  const severityStatus=findings.some(f=>f.severity==='critical')?'critical':findings.some(f=>f.severity==='warning')?'warning':findings.length?'opportunity':coverageIncomplete?'insufficient_data':'stable';
  const described=new Map((intelligence.priorityRankedFindings || []).map(f=>[f.id,f]));
  intelligence={...intelligence,status:severityStatus,priorityRankedFindings:findings.map(f=>({...described.get(f.id),...f}))};
  if (!findings.length) intelligence={...intelligence,headline:coverageIncomplete?'Monitoring evidence incomplete':'No significant changes in evaluated periods',
    summary:coverageIncomplete?'Some providers, periods, metrics or breakdowns could not be evaluated. Overall business stability cannot be confirmed.':'No deterministic anomaly cleared its threshold in the complete evaluated periods. This does not establish technical health or coverage beyond these sources.',
    recommendedActions:coverageIncomplete?[{action:'Review missing evidence and allow complete comparison history',detail:'Check provider availability, period coverage and metric units.',urgency:'routine'}]:[]};

  // ── 7. COMPILE FINAL REPORT ───────────────────────────────────────────────
  const reportId = new ObjectId();
  const notInPlanFinalSummaries = notInPlanSources.map((s) => ({
    provider: s.provider,
    propertyRef: s.selectedProperty?.id,
    status: "not_in_plan",
    available: false,
    success: true,
    snapshotsCount: 0,
    error: null,
    reason: "Not included in your plan",
  }));

  const notInPlanFinalSourceEntries = notInPlanSources.map((s) => ({
    provider: s.provider,
    propertyId: s.selectedProperty.id,
    propertyName: s.selectedProperty.name,
    url: s.selectedProperty.url,
    lastSync: s.lastSuccessfulSync || null,
    status: "not_in_plan",
    text: "Not included in your plan",
    reason: "Not included in your plan",
    error: null,
  }));

  const fetchSummary = {
    fetchedCount: newSnapshots.length,
    providers: [
      ...allowedSources.map((source) => {
        const prov = source.provider;
        const fetchRes = fetchResults.find((r) => r.provider === prov);
        const fetchErr = fetchErrors.find((e) => e.provider === prov);
        const isUsable = usableProviders.find((u) => u.provider === prov);
        const isUnusable = unusableProviders.find((u) => u.provider === prov);
        return {
          provider: prov,
          propertyRef: source.selectedProperty?.id,
          status: fetchErr ? "error" : (isUsable ? "available" : "unavailable"),
          available: Boolean(isUsable),
          success: !fetchErr,
          snapshotsCount: fetchRes?.snapshotsCount || isUsable?.snapshotsLoaded || 0,
          error: fetchErr?.error || null,
          reason: isUnusable?.reason || null,
        };
      }),
      ...notInPlanFinalSummaries,
    ],
    errors: fetchErrors,
  };

  const sourceEvidence = [
    ...usableProviders.map((s) => {
      if (s.provider === "google_analytics") return "Google Analytics 4 (Primary e-commerce & traffic intelligence)";
      if (s.provider === "google_search_console") return "Google Search Console (Secondary organic search diagnostics)";
      if (s.provider === "bing_webmaster" || s.provider === "bing") return "Bing Webmaster Tools (Secondary search indexing diagnostics)";
      return s.name || s.provider;
    }),
    ...unusableProviders.map((u) => `${u.name} (Unavailable: ${u.reason})`),
    ...(externalResearch.length > 0 ? ["External Research Layer (Official Search Central, community webmaster reports)"] : []),
  ];

  // ── 7.5 ASSEMBLE STORE PERFORMANCE SUMMARY (GA4 PRIMARY) ─────────────────
  const ga4Windows = usableWindowsByProvider.google_analytics || null;
  let storePerformance = null;
  if (ga4Windows) {
    const todayWin = ga4Windows.today_vs_yesterday?.eligible ? ga4Windows.today_vs_yesterday : null;
    const weekWin = ga4Windows.last7_vs_prior7;
    const latestMetrics = todayWin?.currentMetrics || weekWin?.currentMetrics || null;
    const changes = todayWin?.changes || weekWin?.changes || {};
    const dims = todayWin?.currentDimensions || weekWin?.currentDimensions || {};

    if (latestMetrics) {
      storePerformance = {
        configured: Boolean(latestMetrics.ecommerceConfigured),
        window: todayWin?.window || weekWin?.window,
        dateRange: todayWin?.currentRange || weekWin?.currentRange,
        sessions: latestMetrics.sessions ?? null,
        users: latestMetrics.users ?? latestMetrics.totalUsers ?? null,
        newUsers: latestMetrics.newUsers ?? null,
        engagementRate: latestMetrics.engagementRate !== null ? latestMetrics.engagementRate : null,
        averageEngagementTime: latestMetrics.averageEngagementTime ?? null,
        bounceRate: latestMetrics.bounceRate ?? null,
        // E-commerce Funnel (null when tracking unconfigured)
        viewItemCount: latestMetrics.viewItemCount,
        addToCartCount: latestMetrics.addToCartCount,
        checkoutCount: latestMetrics.checkoutCount,
        purchaseCount: latestMetrics.purchaseCount,
        revenue: latestMetrics.revenue,
        currencyCode: latestMetrics.currencyCode,
        userCountUnit: latestMetrics.userCountUnit,
        // Funnel Rates (%)
        addToCartRate: latestMetrics.addToCartRate,
        checkoutRate: latestMetrics.checkoutRate,
        purchaseConversionRate: latestMetrics.purchaseConversionRate,
        checkoutToPurchaseRate: latestMetrics.checkoutToPurchaseRate,
        // Window Changes
        changes: {
          revenue: changes.revenue || null,
          purchases: changes.purchaseCount || null,
          checkouts: changes.checkoutCount || null,
          cartAdds: changes.addToCartCount || null,
          sessions: changes.sessions || null,
        },
        // Attributed Channels & Verified AI Referrals
        topChannels: (dims.channels || []).slice(0, 5),
        aiReferrals: (dims.aiReferrals || []).slice(0, 5),
        landingPages: (dims.landingPages || []).slice(0, 5),
      };
    }
  }

  const report = {
    reportId: String(reportId),
    userId: stringUserId,
    userEmail,
    userName: user.name || userEmail.split("@")[0],
    targetDate,
    generatedAt: now,
    websiteUrl,
    monitoringStatus: coverageIncomplete ? "partial" : "active",
    coverageIncomplete,
    status: intelligence.status || (findings.length === 0 ? "stable" : "warning"),
    userPreferences,
    storePerformance,
    activeSources: [
      ...allowedSources.map((s) => {
        const isUsable = usableProviders.some((u) => u.provider === s.provider);
        const fetchErr = fetchErrors.find((e) => e.provider === s.provider);
        const unusable = unusableProviders.find((u) => u.provider === s.provider);
        return {
          provider: s.provider,
          propertyId: s.selectedProperty.id,
          propertyName: s.selectedProperty.name,
          url: s.selectedProperty.url,
          lastSync: s.lastSuccessfulSync || now,
          status: isUsable ? "active" : (fetchErr ? "error" : "insufficient_data"),
          error: fetchErr?.error || null,
          reason: unusable?.reason || null,
        };
      }),
      ...notInPlanFinalSourceEntries,
    ],
    dataFetchSummary: fetchSummary,
    fetchSummary,
    comparisonWindows: comparisonWindowsByProvider,
    findingsCount: findings.length,
    findings,
    externalResearch,
    intelligence,
    sourceEvidence,
  };

  // ── 8. PERSIST REPORT TO MONGODB ──────────────────────────────────────────
  if (!options.dryRun) {
    await preservePreviousEvidence(db,report);
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
          "watchdog.lastMonitoringStatus": report.monitoringStatus,
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
