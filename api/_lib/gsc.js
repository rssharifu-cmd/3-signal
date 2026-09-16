/**
 * Sharflow — Google Search Console Performance Data Fetcher
 *
 * Fetches Search Console performance data (clicks, impressions, CTR, average position)
 * by date, page, and query for a given date range.
 *
 * Uses the stored encrypted refresh token via getGoogleAccessToken() in api/_lib/oauthTokens.js.
 * Normalizes responses into the common snapshot shape:
 * { provider: "google_search_console", propertyRef, date, metrics: {...}, dimensions: {...} }
 */

const { getGoogleAccessToken } = require("./oauthTokens");

const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3/sites";

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
 * Calculates a default date range if none is provided.
 * Google Search Console typically has a 2-day reporting lag.
 * Default: 28 days ending 2 days ago.
 */
function getDefaultDateRange() {
  const now = new Date();
  const endDateObj = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const startDateObj = new Date(endDateObj.getTime() - 27 * 24 * 60 * 60 * 1000);
  return {
    startDate: formatDate(startDateObj),
    endDate: formatDate(endDateObj),
  };
}

/**
 * Executes a Search Console Search Analytics Query.
 * @param {string} accessToken
 * @param {string} siteUrl
 * @param {object} queryBody
 * @returns {Promise<Array<object>>}
 */
async function runSearchAnalyticsQuery(accessToken, siteUrl, queryBody) {
  const url = `${GSC_API_BASE}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(queryBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errJson = {};
    try { errJson = JSON.parse(errText); } catch {}
    const msg = errJson.error?.message || `GSC API HTTP ${res.status}: ${errText.slice(0, 150)}`;
    throw new Error(msg);
  }

  const data = await res.json();
  return data.rows || [];
}

/**
 * Fetches and normalizes Google Search Console performance data for a user and site.
 *
 * @param {object} params
 * @param {string} params.userEmail - User email to refresh OAuth token for
 * @param {string} params.propertyRef - Site URL (e.g. "https://example.com/" or "sc-domain:example.com")
 * @param {string} [params.startDate] - YYYY-MM-DD
 * @param {string} [params.endDate] - YYYY-MM-DD
 * @param {string} [params.accessToken] - Optional pre-fetched access token
 * @returns {Promise<Array<{ provider: string, propertyRef: string, date: string, metrics: object, dimensions: object }>>}
 */
async function fetchGscPerformance({
  userEmail,
  propertyRef,
  startDate,
  endDate,
  accessToken: explicitToken,
}) {
  if (!propertyRef) {
    throw new Error("Missing propertyRef (site URL) for Google Search Console fetch.");
  }

  const range = (startDate && endDate) ? { startDate, endDate } : getDefaultDateRange();

  let accessToken = explicitToken;
  if (!accessToken) {
    if (!userEmail) {
      throw new Error("userEmail or accessToken is required to fetch GSC performance.");
    }
    const auth = await getGoogleAccessToken(userEmail);
    accessToken = auth.accessToken;
  }

  // 1. Fetch daily site-level totals
  const dailyRows = await runSearchAnalyticsQuery(accessToken, propertyRef, {
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: ["date"],
    rowLimit: 5000,
  });

  // 2. Fetch page-level performance grouped by date and page
  let pageRows = [];
  try {
    pageRows = await runSearchAnalyticsQuery(accessToken, propertyRef, {
      startDate: range.startDate,
      endDate: range.endDate,
      dimensions: ["date", "page"],
      rowLimit: 5000,
    });
  } catch (err) {
    console.warn(`[GSC Fetch] Failed to fetch page-level breakdown for ${propertyRef}:`, err.message);
  }

  // 3. Fetch query-level performance grouped by date and query
  let queryRows = [];
  try {
    queryRows = await runSearchAnalyticsQuery(accessToken, propertyRef, {
      startDate: range.startDate,
      endDate: range.endDate,
      dimensions: ["date", "query"],
      rowLimit: 5000,
    });
  } catch (err) {
    console.warn(`[GSC Fetch] Failed to fetch query-level breakdown for ${propertyRef}:`, err.message);
  }

  // Group pages by date
  const pagesByDate = {};
  pageRows.forEach((r) => {
    const d = r.keys[0];
    const pageUrl = r.keys[1];
    if (!pagesByDate[d]) pagesByDate[d] = [];
    pagesByDate[d].push({
      page: pageUrl,
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: Number((r.ctr || 0).toFixed(4)),
      position: Number((r.position || 0).toFixed(1)),
    });
  });

  // Group queries by date
  const queriesByDate = {};
  queryRows.forEach((r) => {
    const d = r.keys[0];
    const queryStr = r.keys[1];
    if (!queriesByDate[d]) queriesByDate[d] = [];
    queriesByDate[d].push({
      query: queryStr,
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: Number((r.ctr || 0).toFixed(4)),
      position: Number((r.position || 0).toFixed(1)),
    });
  });

  // Assemble normalized snapshots
  const snapshots = [];

  // If dailyRows returned data, build a snapshot for each returned date
  if (dailyRows.length > 0) {
    for (const r of dailyRows) {
      const dateStr = r.keys[0];
      const pages = pagesByDate[dateStr] || [];
      const queries = queriesByDate[dateStr] || [];

      // Sort pages and queries by clicks descending
      pages.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      queries.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

      snapshots.push({
        provider: "google_search_console",
        propertyRef,
        date: dateStr,
        metrics: {
          clicks: r.clicks || 0,
          impressions: r.impressions || 0,
          ctr: Number((r.ctr || 0).toFixed(4)),
          position: Number((r.position || 0).toFixed(1)),
        },
        dimensions: {
          pages: pages.slice(0, 100), // Top 100 pages for the day
          queries: queries.slice(0, 100), // Top 100 queries for the day
        },
      });
    }
  } else {
    // If no rows returned (brand new site or zero search traffic in window),
    // provide a clean baseline snapshot for the end date so pipeline has a valid record
    snapshots.push({
      provider: "google_search_console",
      propertyRef,
      date: range.endDate,
      metrics: {
        clicks: 0,
        impressions: 0,
        ctr: 0,
        position: 0,
      },
      dimensions: {
        pages: [],
        queries: [],
      },
    });
  }

  // Sort chronological ascending
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  return snapshots;
}

module.exports = {
  fetchGscPerformance,
  getDefaultDateRange,
  formatDate,
};
