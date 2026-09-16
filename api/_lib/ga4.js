/**
 * Sharflow — Google Analytics 4 Performance Data Fetcher
 *
 * Fetches GA4 sessions, users, traffic sources, conversion events, and page views
 * for a given date range using the Google Analytics Data API (v1beta).
 *
 * Uses the stored encrypted refresh token via getGoogleAccessToken() in api/_lib/oauthTokens.js.
 * Normalizes responses into the common snapshot shape:
 * { provider: "google_analytics", propertyRef, date, metrics: {...}, dimensions: {...} }
 */

const { getGoogleAccessToken } = require("./oauthTokens");

const GA4_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";

/**
 * Formats a Date object to YYYY-MM-DD
 * @param {Date} d
 * @returns {string}
 */
function formatDate(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Normalizes GA4 date "YYYYMMDD" to "YYYY-MM-DD"
 * @param {string} d
 * @returns {string}
 */
function parseGa4Date(d) {
  if (!d) return "";
  if (d.includes("-")) return d;
  return d.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
}

/**
 * Calculates a default date range if none is provided.
 * Default: last 28 days ending yesterday.
 */
function getDefaultDateRange() {
  const now = new Date();
  const endDateObj = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
  const startDateObj = new Date(endDateObj.getTime() - 27 * 24 * 60 * 60 * 1000);
  return {
    startDate: formatDate(startDateObj),
    endDate: formatDate(endDateObj),
  };
}

/**
 * Executes a GA4 Data API runReport call.
 * @param {string} accessToken
 * @param {string} propertyId
 * @param {object} reportBody
 * @returns {Promise<object>}
 */
async function runGa4Report(accessToken, propertyId, reportBody) {
  const propPath = propertyId.startsWith("properties/") ? propertyId : `properties/${propertyId}`;
  const url = `${GA4_DATA_BASE}/${propPath}:runReport`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reportBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errJson = {};
    try { errJson = JSON.parse(errText); } catch {}
    const msg = errJson.error?.message || `GA4 API HTTP ${res.status}: ${errText.slice(0, 150)}`;
    throw new Error(msg);
  }

  return res.json();
}

/**
 * Fetches and normalizes GA4 analytics data for a user and property.
 *
 * @param {object} params
 * @param {string} params.userEmail - User email to refresh OAuth token for
 * @param {string} params.propertyRef - GA4 property ID (e.g. "properties/12345678" or "12345678")
 * @param {string} [params.startDate] - YYYY-MM-DD
 * @param {string} [params.endDate] - YYYY-MM-DD
 * @param {string} [params.accessToken] - Optional pre-fetched access token
 * @returns {Promise<Array<{ provider: string, propertyRef: string, date: string, metrics: object, dimensions: object }>>}
 */
async function fetchGa4Performance({
  userEmail,
  propertyRef,
  startDate,
  endDate,
  accessToken: explicitToken,
}) {
  if (!propertyRef) {
    throw new Error("Missing propertyRef (property ID) for Google Analytics fetch.");
  }

  const range = (startDate && endDate) ? { startDate, endDate } : getDefaultDateRange();

  let accessToken = explicitToken;
  if (!accessToken) {
    if (!userEmail) {
      throw new Error("userEmail or accessToken is required to fetch GA4 performance.");
    }
    const auth = await getGoogleAccessToken(userEmail);
    accessToken = auth.accessToken;
  }

  // 1. Fetch daily totals (sessions, totalUsers, screenPageViews, conversions, bounceRate)
  let dailyData = null;
  try {
    dailyData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "screenPageViews" },
        { name: "conversions" },
        { name: "bounceRate" },
      ],
    });
  } catch (err) {
    // If 'conversions' metric is deprecated in newer GA4 property setup, fallback to eventCount
    if (err.message && err.message.toLowerCase().includes("conversion")) {
      console.warn("[GA4 Fetch] 'conversions' metric failed, falling back to 'eventCount':", err.message);
      dailyData = await runGa4Report(accessToken, propertyRef, {
        dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "sessions" },
          { name: "totalUsers" },
          { name: "screenPageViews" },
          { name: "eventCount" },
          { name: "bounceRate" },
        ],
      });
    } else {
      throw err;
    }
  }

  // 2. Fetch traffic sources breakdown by date
  let trafficSourcesData = null;
  try {
    trafficSourcesData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [
        { name: "date" },
        { name: "sessionSource" },
        { name: "sessionMedium" },
      ],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
      ],
      limit: 2500,
    });
  } catch (err) {
    console.warn(`[GA4 Fetch] Failed to fetch traffic sources for ${propertyRef}:`, err.message);
  }

  // 3. Fetch conversion events breakdown by date
  let eventsData = null;
  try {
    eventsData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [
        { name: "date" },
        { name: "eventName" },
      ],
      metrics: [
        { name: "eventCount" },
      ],
      limit: 2500,
    });
  } catch (err) {
    console.warn(`[GA4 Fetch] Failed to fetch event breakdown for ${propertyRef}:`, err.message);
  }

  // 4. Fetch page views by page path
  let pagesData = null;
  try {
    pagesData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [
        { name: "date" },
        { name: "pagePath" },
      ],
      metrics: [
        { name: "screenPageViews" },
        { name: "sessions" },
      ],
      limit: 2500,
    });
  } catch (err) {
    console.warn(`[GA4 Fetch] Failed to fetch page views breakdown for ${propertyRef}:`, err.message);
  }

  // Index dimensions by normalized date YYYY-MM-DD
  const sourcesByDate = {};
  if (trafficSourcesData?.rows) {
    trafficSourcesData.rows.forEach((r) => {
      const d = parseGa4Date(r.dimensionValues[0]?.value);
      const source = r.dimensionValues[1]?.value || "(direct)";
      const medium = r.dimensionValues[2]?.value || "(none)";
      const sessions = Number(r.metricValues[0]?.value) || 0;
      const users = Number(r.metricValues[1]?.value) || 0;

      if (!sourcesByDate[d]) sourcesByDate[d] = [];
      sourcesByDate[d].push({ source, medium, channel: `${source} / ${medium}`, sessions, users });
    });
  }

  const eventsByDate = {};
  if (eventsData?.rows) {
    eventsData.rows.forEach((r) => {
      const d = parseGa4Date(r.dimensionValues[0]?.value);
      const eventName = r.dimensionValues[1]?.value || "unknown";
      const eventCount = Number(r.metricValues[0]?.value) || 0;

      if (!eventsByDate[d]) eventsByDate[d] = [];
      eventsByDate[d].push({ eventName, eventCount });
    });
  }

  const pagesByDate = {};
  if (pagesData?.rows) {
    pagesData.rows.forEach((r) => {
      const d = parseGa4Date(r.dimensionValues[0]?.value);
      const pagePath = r.dimensionValues[1]?.value || "/";
      const pageViews = Number(r.metricValues[0]?.value) || 0;
      const sessions = Number(r.metricValues[1]?.value) || 0;

      if (!pagesByDate[d]) pagesByDate[d] = [];
      pagesByDate[d].push({ pagePath, pageViews, sessions });
    });
  }

  const snapshots = [];
  const dailyRows = dailyData?.rows || [];

  if (dailyRows.length > 0) {
    for (const r of dailyRows) {
      const dateStr = parseGa4Date(r.dimensionValues[0]?.value);
      const sessions = Number(r.metricValues[0]?.value) || 0;
      const users = Number(r.metricValues[1]?.value) || 0;
      const pageViews = Number(r.metricValues[2]?.value) || 0;
      const conversions = Number(r.metricValues[3]?.value) || 0;
      const bounceRate = Number(Number(r.metricValues[4]?.value || 0).toFixed(4));

      const trafficSources = sourcesByDate[dateStr] || [];
      trafficSources.sort((a, b) => b.sessions - a.sessions);

      const events = eventsByDate[dateStr] || [];
      events.sort((a, b) => b.eventCount - a.eventCount);

      const pages = pagesByDate[dateStr] || [];
      pages.sort((a, b) => b.pageViews - a.pageViews);

      snapshots.push({
        provider: "google_analytics",
        propertyRef,
        date: dateStr,
        metrics: {
          sessions,
          users,
          pageViews,
          conversions,
          bounceRate,
        },
        dimensions: {
          trafficSources: trafficSources.slice(0, 50),
          events: events.slice(0, 50),
          pages: pages.slice(0, 50),
        },
      });
    }
  } else {
    // If no rows, provide baseline zero snapshot
    snapshots.push({
      provider: "google_analytics",
      propertyRef,
      date: range.endDate,
      metrics: {
        sessions: 0,
        users: 0,
        pageViews: 0,
        conversions: 0,
        bounceRate: 0,
      },
      dimensions: {
        trafficSources: [],
        events: [],
        pages: [],
      },
    });
  }

  // Sort chronological ascending
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  return snapshots;
}

module.exports = {
  fetchGa4Performance,
  getDefaultDateRange,
  formatDate,
};
