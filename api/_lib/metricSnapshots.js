/**
 * Sharflow — Historical Storage & Comparison Windows
 *
 * Manages the `metric_snapshots` MongoDB collection:
 * - One document per user + provider + date.
 * - Upserts normalized metrics and dimension breakdowns.
 * - Computes comparison windows:
 *   1. Today vs Yesterday (1d vs prior 1d)
 *   2. Last 7 days vs Prior 7 days (7d vs prior 7d)
 *   3. Last 28 days vs Prior 28 days (28d vs prior 28d)
 */

const { getDb } = require("./db");

const COLLECTION_NAME = "metric_snapshots";

/**
 * Ensures indexes exist on metric_snapshots collection.
 */
let indexCreated = false;
async function ensureIndexes() {
  if (indexCreated) return;
  try {
    const db = await getDb();
    const col = db.collection(COLLECTION_NAME);
    await col.createIndex({ userEmail: 1, provider: 1, date: 1 }, { unique: true });
    await col.createIndex({ userId: 1, provider: 1, date: 1 });
    await col.createIndex({ date: 1 });
    indexCreated = true;
  } catch (err) {
    console.warn("[MetricSnapshots] Index creation notice:", err.message);
  }
}

/**
 * Saves or updates a single normalized metric snapshot.
 *
 * @param {object} snapshot
 * @param {string} [snapshot.userId]
 * @param {string} snapshot.userEmail
 * @param {string} snapshot.provider - "google_search_console" | "google_analytics" | "bing_webmaster"
 * @param {string} snapshot.propertyRef
 * @param {string} snapshot.date - "YYYY-MM-DD"
 * @param {object} snapshot.metrics
 * @param {object} snapshot.dimensions
 * @returns {Promise<object>}
 */
async function saveMetricSnapshot(snapshot) {
  if (!snapshot.userEmail || !snapshot.provider || !snapshot.date) {
    throw new Error("Missing required fields for metric snapshot (userEmail, provider, date).");
  }

  await ensureIndexes();
  const db = await getDb();
  const col = db.collection(COLLECTION_NAME);
  const now = new Date();

  const query = {
    userEmail: snapshot.userEmail,
    provider: snapshot.provider,
    date: snapshot.date,
  };

  const update = {
    $set: {
      userId: snapshot.userId || null,
      userEmail: snapshot.userEmail,
      provider: snapshot.provider,
      propertyRef: snapshot.propertyRef || "",
      date: snapshot.date,
      metrics: snapshot.metrics || {},
      dimensions: snapshot.dimensions || {},
      updatedAt: now,
    },
    $setOnInsert: {
      createdAt: now,
    },
  };

  const res = await col.updateOne(query, update, { upsert: true });
  return res;
}

/**
 * Saves multiple normalized metric snapshots in bulk.
 *
 * @param {Array<object>} snapshots
 * @returns {Promise<number>} Number of snapshots written
 */
async function saveMetricSnapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return 0;

  await ensureIndexes();
  const db = await getDb();
  const col = db.collection(COLLECTION_NAME);
  const now = new Date();

  const ops = snapshots.map((s) => ({
    updateOne: {
      filter: {
        userEmail: s.userEmail,
        provider: s.provider,
        date: s.date,
      },
      update: {
        $set: {
          userId: s.userId || null,
          userEmail: s.userEmail,
          provider: s.provider,
          propertyRef: s.propertyRef || "",
          date: s.date,
          metrics: s.metrics || {},
          dimensions: s.dimensions || {},
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      upsert: true,
    },
  }));

  const res = await col.bulkWrite(ops, { ordered: false });
  return (res.upsertedCount || 0) + (res.modifiedCount || 0);
}

/**
 * Retrieves snapshots for a user, provider, and date range.
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} params.userEmail
 * @param {string} [params.provider]
 * @param {string} [params.startDate]
 * @param {string} [params.endDate]
 * @returns {Promise<Array<object>>}
 */
async function getMetricSnapshots({ userId, userEmail, provider, startDate, endDate }) {
  const db = await getDb();
  const col = db.collection(COLLECTION_NAME);

  const query = {};
  if (userEmail) {
    query.userEmail = userEmail;
  } else if (userId) {
    query.userId = userId;
  }

  if (provider) {
    query.provider = provider;
  }

  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
  }

  return col.find(query).sort({ date: 1 }).toArray();
}

/**
 * Finds the latest snapshot date available for a user and provider.
 *
 * @param {object} params
 * @param {string} params.userEmail
 * @param {string} [params.provider]
 * @returns {Promise<string|null>}
 */
async function getLatestSnapshotDate({ userEmail, provider }) {
  const db = await getDb();
  const col = db.collection(COLLECTION_NAME);

  const query = { userEmail };
  if (provider) query.provider = provider;

  const doc = await col.findOne(query, { sort: { date: -1 } });
  return doc ? doc.date : null;
}

/**
 * Shifts a YYYY-MM-DD date string by a given number of days.
 * @param {string} dateStr
 * @param {number} daysDelta
 * @returns {string} YYYY-MM-DD
 */
function shiftDate(dateStr, daysDelta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + daysDelta);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Calculates aggregate totals and averages for a slice of snapshot records.
 * @param {Array<object>} slice
 * @returns {object}
 */
function aggregateMetrics(slice) {
  if (!slice || slice.length === 0) {
    return {
      count: 0,
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
      sessions: 0,
      users: 0,
      totalUsers: 0,
      newUsers: 0,
      returningUsers: 0,
      pageViews: 0,
      conversions: 0,
      bounceRate: 0,
      engagementRate: null,
      averageEngagementTime: 0,
      ecommerceConfigured: false,
      viewItemCount: null,
      addToCartCount: null,
      checkoutCount: null,
      purchaseCount: null,
      revenue: null,
      addToCartRate: null,
      checkoutRate: null,
      purchaseConversionRate: null,
      checkoutToPurchaseRate: null,
      crawledPages: 0,
      crawlErrors: 0,
    };
  }

  let totalClicks = 0;
  let totalImpressions = 0;
  let sumPositionImp = 0;
  let totalSessions = 0;
  let totalUsers = 0;
  let totalNewUsers = 0;
  let totalReturningUsers = 0;
  let totalPageViews = 0;
  let totalConversions = 0;
  let sumBounceSessions = 0;
  let sumEngagementSessions = 0;
  let hasEngagement = false;
  let sumEngageTimeSessions = 0;
  let totalCrawledPages = 0;
  let totalCrawlErrors = 0;

  // E-commerce tracking
  let isEcomConfigured = false;
  let totalViewItems = 0;
  let totalAddToCart = 0;
  let totalCheckouts = 0;
  let totalPurchases = 0;
  let totalRevenue = 0;

  for (const item of slice) {
    const m = item.metrics || {};
    totalClicks += m.clicks || 0;
    totalImpressions += m.impressions || 0;
    if (m.position && m.impressions) {
      sumPositionImp += m.position * m.impressions;
    } else if (m.position) {
      sumPositionImp += m.position;
    }
    const sess = m.sessions || 0;
    totalSessions += sess;
    totalUsers += m.users || m.totalUsers || 0;
    totalNewUsers += m.newUsers || 0;
    totalReturningUsers += m.returningUsers || 0;
    totalPageViews += m.pageViews || 0;
    totalConversions += m.conversions || 0;

    if (m.bounceRate && sess) {
      sumBounceSessions += m.bounceRate * sess;
    }
    if (m.engagementRate !== null && m.engagementRate !== undefined && sess) {
      hasEngagement = true;
      sumEngagementSessions += m.engagementRate * sess;
    }
    if (m.averageEngagementTime && sess) {
      sumEngageTimeSessions += m.averageEngagementTime * sess;
    }

    if (m.ecommerceConfigured === true || m.purchaseCount !== null || m.revenue !== null || m.addToCartCount !== null) {
      isEcomConfigured = true;
      totalViewItems += m.viewItemCount || 0;
      totalAddToCart += m.addToCartCount || 0;
      totalCheckouts += m.checkoutCount || 0;
      totalPurchases += m.purchaseCount || 0;
      totalRevenue += m.revenue || 0;
    }

    totalCrawledPages += m.crawledPages || 0;
    totalCrawlErrors += m.crawlErrors || 0;
  }

  const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const avgPos = totalImpressions > 0 ? sumPositionImp / totalImpressions : (slice.length > 0 ? sumPositionImp / slice.length : 0);
  const avgBounce = totalSessions > 0 ? sumBounceSessions / totalSessions : 0;
  const avgEngagementRate = hasEngagement && totalSessions > 0 ? Number((sumEngagementSessions / totalSessions).toFixed(4)) : null;
  const avgEngagementTime = totalSessions > 0 ? Number((sumEngageTimeSessions / totalSessions).toFixed(1)) : 0;

  // Funnel Rates
  const addToCartRate = isEcomConfigured && totalSessions > 0 && totalAddToCart > 0 ? Number(((totalAddToCart / totalSessions) * 100).toFixed(2)) : (isEcomConfigured ? 0 : null);
  const checkoutRate = isEcomConfigured && totalSessions > 0 && totalCheckouts > 0 ? Number(((totalCheckouts / totalSessions) * 100).toFixed(2)) : (isEcomConfigured ? 0 : null);
  const purchaseConversionRate = isEcomConfigured && totalSessions > 0 && totalPurchases > 0 ? Number(((totalPurchases / totalSessions) * 100).toFixed(2)) : (isEcomConfigured ? 0 : null);
  const checkoutToPurchaseRate = isEcomConfigured && totalCheckouts > 0 && totalPurchases > 0 ? Number(((totalPurchases / totalCheckouts) * 100).toFixed(2)) : (isEcomConfigured ? 0 : null);

  return {
    count: slice.length,
    clicks: totalClicks,
    impressions: totalImpressions,
    ctr: Number(avgCtr.toFixed(4)),
    position: Number(avgPos.toFixed(1)),
    sessions: totalSessions,
    users: totalUsers,
    totalUsers,
    newUsers: totalNewUsers,
    returningUsers: totalReturningUsers,
    pageViews: totalPageViews,
    conversions: totalConversions,
    bounceRate: Number(avgBounce.toFixed(4)),
    engagementRate: avgEngagementRate,
    averageEngagementTime: avgEngagementTime,
    // E-Commerce
    ecommerceConfigured: isEcomConfigured,
    viewItemCount: isEcomConfigured ? totalViewItems : null,
    addToCartCount: isEcomConfigured ? totalAddToCart : null,
    checkoutCount: isEcomConfigured ? totalCheckouts : null,
    purchaseCount: isEcomConfigured ? totalPurchases : null,
    revenue: isEcomConfigured ? Number(totalRevenue.toFixed(2)) : null,
    addToCartRate,
    checkoutRate,
    purchaseConversionRate,
    checkoutToPurchaseRate,
    crawledPages: totalCrawledPages,
    crawlErrors: totalCrawlErrors,
  };
}

/**
 * Computes difference and percentage change between two metric states.
 * @param {object} curr
 * @param {object} prior
 * @returns {object}
 */
function computeChanges(curr, prior) {
  const diff = {};
  const metrics = [
    "clicks",
    "impressions",
    "ctr",
    "position",
    "sessions",
    "users",
    "totalUsers",
    "newUsers",
    "returningUsers",
    "pageViews",
    "conversions",
    "bounceRate",
    "engagementRate",
    "averageEngagementTime",
    "viewItemCount",
    "addToCartCount",
    "checkoutCount",
    "purchaseCount",
    "revenue",
    "addToCartRate",
    "checkoutRate",
    "purchaseConversionRate",
    "checkoutToPurchaseRate",
    "crawledPages",
    "crawlErrors",
  ];

  for (const m of metrics) {
    const cVal = curr[m];
    const pVal = prior[m];

    if (cVal === null || cVal === undefined || pVal === null || pVal === undefined) {
      diff[m] = {
        current: cVal ?? null,
        prior: pVal ?? null,
        absolute: null,
        percent: null,
      };
      continue;
    }

    const absolute = Number((cVal - pVal).toFixed(2));
    let percent = 0;
    if (pVal !== 0) {
      percent = Number((((cVal - pVal) / pVal) * 100).toFixed(2));
    } else if (cVal > 0) {
      percent = 100.0;
    }
    diff[m] = {
      current: cVal,
      prior: pVal,
      absolute,
      percent,
    };
  }

  return diff;
}

/**
 * Aggregates dimensions across a date window (pages, queries, channels, events, aiReferrals, landingPages).
 * @param {Array<object>} slice
 * @returns {object}
 */
function aggregateDimensions(slice) {
  const pagesMap = new Map();
  const queriesMap = new Map();
  const channelsMap = new Map();
  const aiReferralsMap = new Map();
  const landingPagesMap = new Map();
  const eventsMap = new Map();
  const devicesMap = new Map();
  let latestCrawlIssues = [];

  for (const s of slice) {
    const dims = s.dimensions || {};

    // Crawl Issues (keep latest snapshot's crawlIssues list in the slice)
    if (Array.isArray(dims.crawlIssues) && dims.crawlIssues.length > 0) {
      latestCrawlIssues = dims.crawlIssues;
    }

    // Pages
    if (Array.isArray(dims.pages)) {
      for (const p of dims.pages) {
        const key = p.page || p.pagePath || "";
        if (!key) continue;
        const existing = pagesMap.get(key) || { page: key, clicks: 0, impressions: 0, pageViews: 0, sessions: 0, sumPos: 0, count: 0 };
        existing.clicks += p.clicks || 0;
        existing.impressions += p.impressions || 0;
        existing.pageViews += p.pageViews || 0;
        existing.sessions += p.sessions || 0;
        if (p.position) {
          existing.sumPos += p.position * (p.impressions || 1);
          existing.count += (p.impressions || 1);
        }
        pagesMap.set(key, existing);
      }
    }

    // Landing Pages
    if (Array.isArray(dims.landingPages)) {
      for (const lp of dims.landingPages) {
        const key = lp.page || lp.pagePath || "/";
        const existing = landingPagesMap.get(key) || { page: key, sessions: 0, users: 0, pageViews: 0, bounceRateSum: 0, count: 0 };
        existing.sessions += lp.sessions || 0;
        existing.users += lp.users || 0;
        existing.pageViews += lp.pageViews || 0;
        if (lp.bounceRate !== undefined) {
          existing.bounceRateSum += lp.bounceRate;
          existing.count++;
        }
        landingPagesMap.set(key, existing);
      }
    }

    // Queries
    if (Array.isArray(dims.queries)) {
      for (const q of dims.queries) {
        const key = q.query || "";
        if (!key) continue;
        const existing = queriesMap.get(key) || { query: key, clicks: 0, impressions: 0, sumPos: 0, count: 0 };
        existing.clicks += q.clicks || 0;
        existing.impressions += q.impressions || 0;
        if (q.position) {
          existing.sumPos += q.position * (q.impressions || 1);
          existing.count += (q.impressions || 1);
        }
        queriesMap.set(key, existing);
      }
    }

    // Traffic Sources / Channels
    if (Array.isArray(dims.trafficSources)) {
      for (const ts of dims.trafficSources) {
        const channel = ts.channel || `${ts.source} / ${ts.medium}`;
        const existing = channelsMap.get(channel) || { channel, source: ts.source, medium: ts.medium, sessions: 0, users: 0 };
        existing.sessions += ts.sessions || 0;
        existing.users += ts.users || 0;
        channelsMap.set(channel, existing);
      }
    }

    // Verified AI Referrals
    if (Array.isArray(dims.aiReferrals)) {
      for (const ai of dims.aiReferrals) {
        const key = `${ai.platform || ai.source}`;
        const existing = aiReferralsMap.get(key) || { platform: ai.platform || "AI Referral", source: ai.source, medium: ai.medium, sessions: 0, users: 0 };
        existing.sessions += ai.sessions || 0;
        existing.users += ai.users || 0;
        aiReferralsMap.set(key, existing);
      }
    }

    // Events
    if (Array.isArray(dims.events)) {
      for (const ev of dims.events) {
        const key = ev.eventName || "";
        if (!key) continue;
        const existing = eventsMap.get(key) || { eventName: key, eventCount: 0 };
        existing.eventCount += ev.eventCount || 0;
        eventsMap.set(key, existing);
      }
    }

    // Devices
    if (Array.isArray(dims.devices)) {
      for (const dev of dims.devices) {
        const key = dev.device || "desktop";
        const existing = devicesMap.get(key) || { device: key, sessions: 0 };
        existing.sessions += dev.sessions || 0;
        devicesMap.set(key, existing);
      }
    }
  }

  // Format summaries
  const pages = Array.from(pagesMap.values()).map((p) => ({
    page: p.page,
    clicks: p.clicks,
    impressions: p.impressions,
    ctr: p.impressions > 0 ? Number((p.clicks / p.impressions).toFixed(4)) : 0,
    position: p.count > 0 ? Number((p.sumPos / p.count).toFixed(1)) : 0,
    pageViews: p.pageViews,
    sessions: p.sessions,
  })).sort((a, b) => b.clicks - a.clicks || b.pageViews - a.pageViews);

  const landingPages = Array.from(landingPagesMap.values()).map((lp) => ({
    page: lp.page,
    sessions: lp.sessions,
    users: lp.users,
    pageViews: lp.pageViews,
    bounceRate: lp.count > 0 ? Number((lp.bounceRateSum / lp.count).toFixed(4)) : 0,
  })).sort((a, b) => b.sessions - a.sessions);

  const queries = Array.from(queriesMap.values()).map((q) => ({
    query: q.query,
    clicks: q.clicks,
    impressions: q.impressions,
    ctr: q.impressions > 0 ? Number((q.clicks / q.impressions).toFixed(4)) : 0,
    position: q.count > 0 ? Number((q.sumPos / q.count).toFixed(1)) : 0,
  })).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  const channels = Array.from(channelsMap.values()).sort((a, b) => b.sessions - a.sessions);
  const aiReferrals = Array.from(aiReferralsMap.values()).sort((a, b) => b.sessions - a.sessions);
  const events = Array.from(eventsMap.values()).sort((a, b) => b.eventCount - a.eventCount);
  const devices = Array.from(devicesMap.values()).sort((a, b) => b.sessions - a.sessions);

  // Deduplicate latestCrawlIssues by URL
  const seenIssueUrls = new Set();
  const crawlIssues = [];
  for (const issue of latestCrawlIssues) {
    if (!issue || typeof issue !== "object") continue;
    const urlKey = String(issue.Url || issue.url || JSON.stringify(issue)).toLowerCase().trim();
    if (seenIssueUrls.has(urlKey)) continue;
    seenIssueUrls.add(urlKey);
    crawlIssues.push(issue);
  }

  return {
    pages,
    landingPages,
    queries,
    channels,
    aiReferrals,
    events,
    devices,
    crawlIssues,
  };
}

/**
 * Calculates the number of calendar days between two YYYY-MM-DD dates inclusive.
 *
 * @param {string} startStr
 * @param {string} endStr
 * @returns {number}
 */
function getCalendarDaysInclusive(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const start = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.round(diffTime / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * Builds comparison window data comparing a current period to its prior equivalent.
 *
 * @param {Array<object>} allSnapshots
 * @param {string} currStart
 * @param {string} currEnd
 * @param {string} priorStart
 * @param {string} priorEnd
 * @param {string} windowName
 * @returns {object}
 */
function buildWindow(allSnapshots, currStart, currEnd, priorStart, priorEnd, windowName) {
  const currentSlice = allSnapshots.filter((s) => s.date >= currStart && s.date <= currEnd);
  const priorSlice = allSnapshots.filter((s) => s.date >= priorStart && s.date <= priorEnd);

  const currentMetrics = aggregateMetrics(currentSlice);
  const priorMetrics = aggregateMetrics(priorSlice);
  const changes = computeChanges(currentMetrics, priorMetrics);

  const currentDims = aggregateDimensions(currentSlice);
  const priorDims = aggregateDimensions(priorSlice);

  // Daily series in current window for trend checking (sustained change detection)
  const dailySeries = currentSlice.map((s) => ({
    date: s.date,
    metrics: s.metrics || {},
  }));

  const currentCalendarDays = getCalendarDaysInclusive(currStart, currEnd);
  const priorCalendarDays = getCalendarDaysInclusive(priorStart, priorEnd);

  return {
    window: windowName,
    currentRange: {
      start: currStart,
      end: currEnd,
      days: currentCalendarDays,
      daysInRange: currentCalendarDays,
      snapshotsFoundInRange: currentSlice.length,
      snapshotsCount: currentSlice.length,
    },
    priorRange: {
      start: priorStart,
      end: priorEnd,
      days: priorCalendarDays,
      daysInRange: priorCalendarDays,
      snapshotsFoundInRange: priorSlice.length,
      snapshotsCount: priorSlice.length,
    },
    currentMetrics,
    priorMetrics,
    changes,
    dailySeries,
    currentDimensions: currentDims,
    priorDimensions: priorDims,
  };
}

/**
 * Loads comparison windows for a user and provider:
 * 1. Today vs Yesterday (1d vs prior 1d)
 * 2. Last 7 days vs Prior 7 days (7d vs prior 7d)
 * 3. Last 28 days vs Prior 28 days (28d vs prior 28d)
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} params.userEmail
 * @param {string} [params.provider]
 * @param {string} [params.targetDate] - YYYY-MM-DD anchor date (defaults to latest available)
 * @returns {Promise<object>}
 */
async function loadComparisonWindows({ userId, userEmail, provider, targetDate: explicitDate }) {
  let targetDate = explicitDate;
  if (!targetDate) {
    targetDate = await getLatestSnapshotDate({ userEmail, provider });
  }
  if (!targetDate) {
    // If no records in database, default anchor to yesterday
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    targetDate = yesterday.toISOString().split("T")[0];
  }

  // Define window date ranges based on targetDate (Day 0)
  // Window 1: 1d vs prior 1d
  const todayStart = targetDate;
  const todayEnd = targetDate;
  const yesterdayStart = shiftDate(targetDate, -1);
  const yesterdayEnd = shiftDate(targetDate, -1);

  // Window 2: 7d vs prior 7d
  const last7Start = shiftDate(targetDate, -6);
  const last7End = targetDate;
  const prior7Start = shiftDate(targetDate, -13);
  const prior7End = shiftDate(targetDate, -7);

  // Window 3: 28d vs prior 28d
  const last28Start = shiftDate(targetDate, -27);
  const last28End = targetDate;
  const prior28Start = shiftDate(targetDate, -55);
  const prior28End = shiftDate(targetDate, -28);

  // Load all snapshots from prior28Start up to targetDate
  const allSnapshots = await getMetricSnapshots({
    userId,
    userEmail,
    provider,
    startDate: prior28Start,
    endDate: targetDate,
  });

  const todayVsYesterday = buildWindow(
    allSnapshots,
    todayStart,
    todayEnd,
    yesterdayStart,
    yesterdayEnd,
    "today_vs_yesterday"
  );

  const last7VsPrior7 = buildWindow(
    allSnapshots,
    last7Start,
    last7End,
    prior7Start,
    prior7End,
    "last7_vs_prior7"
  );

  const last28VsPrior28 = buildWindow(
    allSnapshots,
    last28Start,
    last28End,
    prior28Start,
    prior28End,
    "last28_vs_prior28"
  );

  return {
    targetDate,
    totalSnapshotsLoaded: allSnapshots.length,
    today_vs_yesterday: todayVsYesterday,
    last7_vs_prior7: last7VsPrior7,
    last28_vs_prior28: last28VsPrior28,
  };
}

module.exports = {
  saveMetricSnapshot,
  saveMetricSnapshots,
  getMetricSnapshots,
  getLatestSnapshotDate,
  loadComparisonWindows,
  shiftDate,
  aggregateMetrics,
  buildWindow,
  getCalendarDaysInclusive,
};
