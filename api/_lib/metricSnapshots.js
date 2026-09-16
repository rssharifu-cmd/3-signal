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
      pageViews: 0,
      conversions: 0,
      bounceRate: 0,
      crawledPages: 0,
      crawlErrors: 0,
    };
  }

  let totalClicks = 0;
  let totalImpressions = 0;
  let sumPositionImp = 0;
  let totalSessions = 0;
  let totalUsers = 0;
  let totalPageViews = 0;
  let totalConversions = 0;
  let sumBounceSessions = 0;
  let totalCrawledPages = 0;
  let totalCrawlErrors = 0;

  for (const item of slice) {
    const m = item.metrics || {};
    totalClicks += m.clicks || 0;
    totalImpressions += m.impressions || 0;
    if (m.position && m.impressions) {
      sumPositionImp += m.position * m.impressions;
    } else if (m.position) {
      sumPositionImp += m.position;
    }
    totalSessions += m.sessions || 0;
    totalUsers += m.users || 0;
    totalPageViews += m.pageViews || 0;
    totalConversions += m.conversions || 0;
    if (m.bounceRate && m.sessions) {
      sumBounceSessions += m.bounceRate * m.sessions;
    }
    totalCrawledPages += m.crawledPages || 0;
    totalCrawlErrors += m.crawlErrors || 0;
  }

  const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const avgPos = totalImpressions > 0 ? sumPositionImp / totalImpressions : (slice.length > 0 ? sumPositionImp / slice.length : 0);
  const avgBounce = totalSessions > 0 ? sumBounceSessions / totalSessions : 0;

  return {
    count: slice.length,
    clicks: totalClicks,
    impressions: totalImpressions,
    ctr: Number(avgCtr.toFixed(4)),
    position: Number(avgPos.toFixed(1)),
    sessions: totalSessions,
    users: totalUsers,
    pageViews: totalPageViews,
    conversions: totalConversions,
    bounceRate: Number(avgBounce.toFixed(4)),
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
    "pageViews",
    "conversions",
    "bounceRate",
    "crawledPages",
    "crawlErrors",
  ];

  for (const m of metrics) {
    const cVal = curr[m] || 0;
    const pVal = prior[m] || 0;
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
 * Aggregates dimensions across a date window (pages, queries, channels, events).
 * @param {Array<object>} slice
 * @returns {object}
 */
function aggregateDimensions(slice) {
  const pagesMap = new Map();
  const queriesMap = new Map();
  const channelsMap = new Map();
  const eventsMap = new Map();

  for (const s of slice) {
    const dims = s.dimensions || {};

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
        const existing = channelsMap.get(channel) || { channel, sessions: 0, users: 0 };
        existing.sessions += ts.sessions || 0;
        existing.users += ts.users || 0;
        channelsMap.set(channel, existing);
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

  const queries = Array.from(queriesMap.values()).map((q) => ({
    query: q.query,
    clicks: q.clicks,
    impressions: q.impressions,
    ctr: q.impressions > 0 ? Number((q.clicks / q.impressions).toFixed(4)) : 0,
    position: q.count > 0 ? Number((q.sumPos / q.count).toFixed(1)) : 0,
  })).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  const channels = Array.from(channelsMap.values()).sort((a, b) => b.sessions - a.sessions);
  const events = Array.from(eventsMap.values()).sort((a, b) => b.eventCount - a.eventCount);

  return {
    pages,
    queries,
    channels,
    events,
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
