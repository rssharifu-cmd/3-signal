/**
 * Sharflow — Bing Webmaster Tools Performance Data Fetcher
 *
 * Fetches Bing Webmaster crawl, indexation, and traffic statistics for a selected site.
 *
 * Uses the stored encrypted refresh token via getBingAccessToken() in api/_lib/oauthTokens.js,
 * with support for BING_WEBMASTER_API_KEY if configured.
 * Normalizes responses into the common snapshot shape:
 * { provider: "bing_webmaster", propertyRef, date, metrics: {...}, dimensions: {...} }
 */

const { getBingAccessToken } = require("./oauthTokens");

const BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";

/**
 * Parses Bing dates which can be:
 * - WCF serialized: "/Date(1588665600000)/" or "/Date(1588665600000-0800)/"
 * - ISO string: "2026-09-14T00:00:00"
 * - Date string: "2026-09-14"
 * @param {string|number} rawDate
 * @returns {string} YYYY-MM-DD
 */
function parseBingDate(rawDate) {
  if (!rawDate) return "";
  if (typeof rawDate === "string") {
    const match = rawDate.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
    if (match) {
      const ts = parseInt(match[1], 10);
      const d = new Date(ts);
      return d.toISOString().split("T")[0];
    }
    if (rawDate.includes("T")) {
      return rawDate.split("T")[0];
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return rawDate;
    }
  }
  try {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split("T")[0];
    }
  } catch {}
  return "";
}

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
 * Invokes a Bing Webmaster JSON API endpoint with either OAuth accessToken or BING_WEBMASTER_API_KEY.
 * @param {string} endpointName
 * @param {string} siteUrl
 * @param {string} [accessToken]
 * @returns {Promise<Array<object>>}
 */
async function callBingApi(endpointName, siteUrl, accessToken) {
  let url = `${BING_API_BASE}/${endpointName}?siteUrl=${encodeURIComponent(siteUrl)}`;
  const headers = {};

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else if (process.env.BING_WEBMASTER_API_KEY) {
    url += `&apikey=${encodeURIComponent(process.env.BING_WEBMASTER_API_KEY.trim())}`;
  } else {
    throw new Error("No Bing OAuth access token or BING_WEBMASTER_API_KEY available.");
  }

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Bing API ${endpointName} HTTP ${res.status}: ${errText.slice(0, 150)}`);
  }

  const data = await res.json();
  return data.d || [];
}

/**
 * Fetches and normalizes Bing Webmaster Tools performance data for a user and site.
 *
 * @param {object} params
 * @param {string} params.userEmail - User email to refresh OAuth token for
 * @param {string} params.propertyRef - Site URL (e.g. "https://example.com/")
 * @param {string} [params.startDate] - YYYY-MM-DD
 * @param {string} [params.endDate] - YYYY-MM-DD
 * @param {string} [params.accessToken] - Optional pre-fetched access token
 * @returns {Promise<Array<{ provider: string, propertyRef: string, date: string, metrics: object, dimensions: object }>>}
 */
async function fetchBingPerformance({
  userEmail,
  propertyRef,
  startDate,
  endDate,
  accessToken: explicitToken,
}) {
  if (!propertyRef) {
    throw new Error("Missing propertyRef (site URL) for Bing Webmaster fetch.");
  }

  const range = (startDate && endDate) ? { startDate, endDate } : getDefaultDateRange();

  let accessToken = explicitToken;
  if (!accessToken && userEmail) {
    try {
      const auth = await getBingAccessToken(userEmail);
      accessToken = auth.accessToken;
    } catch (err) {
      if (!process.env.BING_WEBMASTER_API_KEY) {
        throw err;
      }
    }
  }

  // 1. Fetch traffic & ranking stats
  let trafficStats = [];
  try {
    trafficStats = await callBingApi("GetRankAndTrafficStats", propertyRef, accessToken);
  } catch (err) {
    console.warn(`[Bing Fetch] GetRankAndTrafficStats failed for ${propertyRef}:`, err.message);
  }

  // 2. Fetch query-level stats
  let queryStats = [];
  try {
    queryStats = await callBingApi("GetQueryStats", propertyRef, accessToken);
  } catch (err) {
    console.warn(`[Bing Fetch] GetQueryStats failed for ${propertyRef}:`, err.message);
  }

  // 3. Fetch crawl stats
  let crawlStats = [];
  try {
    crawlStats = await callBingApi("GetCrawlStats", propertyRef, accessToken);
  } catch (err) {
    console.warn(`[Bing Fetch] GetCrawlStats failed for ${propertyRef}:`, err.message);
  }

  // 4. Fetch crawl issues
  let crawlIssues = [];
  try {
    crawlIssues = await callBingApi("GetCrawlIssues", propertyRef, accessToken);
  } catch (err) {
    console.warn(`[Bing Fetch] GetCrawlIssues failed for ${propertyRef}:`, err.message);
  }

  // Index crawl stats by date
  const crawlByDate = {};
  crawlStats.forEach((cs) => {
    const d = parseBingDate(cs.CrawlDate || cs.Date);
    if (d) {
      crawlByDate[d] = {
        crawledPages: cs.CrawledPages || 0,
        crawlErrors: cs.CrawlErrors || 0,
        inCrawlQueue: cs.InCrawlQueue || 0,
        code2xx: cs.Code2xx || 0,
        code3xx: cs.Code3xx || 0,
        code4xx: cs.Code4xx || 0,
        code5xx: cs.Code5xx || 0,
      };
    }
  });

  // Index queries by date
  const queriesByDate = {};
  queryStats.forEach((qs) => {
    const d = parseBingDate(qs.Date);
    const query = qs.Query || "";
    const clicks = qs.Clicks || 0;
    const impressions = qs.Impressions || 0;
    const avgPosition = qs.AvgClickPosition || qs.AvgImpressionPosition || 0;
    const ctr = impressions > 0 ? Number((clicks / impressions).toFixed(4)) : 0;

    if (d) {
      if (!queriesByDate[d]) queriesByDate[d] = [];
      queriesByDate[d].push({ query, clicks, impressions, ctr, position: avgPosition });
    }
  });

  // Index traffic stats by date
  const trafficByDate = {};
  trafficStats.forEach((ts) => {
    const d = parseBingDate(ts.Date);
    if (d) {
      trafficByDate[d] = {
        clicks: ts.Clicks || 0,
        impressions: ts.Impressions || 0,
        avgClickPosition: ts.AvgClickPosition || 0,
        avgImpressionPosition: ts.AvgImpressionPosition || 0,
      };
    }
  });

  // Collect all unique dates found across traffic, queries, and crawl stats
  const allDates = new Set([
    ...Object.keys(trafficByDate),
    ...Object.keys(queriesByDate),
    ...Object.keys(crawlByDate),
  ]);

  const snapshots = [];

  if (allDates.size > 0) {
    for (const d of allDates) {
      // Filter within range if range is set
      if (d < range.startDate || d > range.endDate) continue;

      const t = trafficByDate[d] || {};
      const c = crawlByDate[d] || {};
      const q = queriesByDate[d] || [];

      q.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

      const clicks = t.clicks || 0;
      const impressions = t.impressions || 0;
      const ctr = impressions > 0 ? Number((clicks / impressions).toFixed(4)) : 0;
      const position = Number((t.avgClickPosition || t.avgImpressionPosition || 0).toFixed(1));

      snapshots.push({
        provider: "bing_webmaster",
        propertyRef,
        date: d,
        metrics: {
          clicks,
          impressions,
          ctr,
          position,
          crawledPages: c.crawledPages || 0,
          crawlErrors: c.crawlErrors || 0,
          inCrawlQueue: c.inCrawlQueue || 0,
        },
        dimensions: {
          queries: q.slice(0, 100),
          crawlIssues: crawlIssues.slice(0, 20),
        },
      });
    }
  }

  // If no date entries within range, return baseline snapshot
  if (snapshots.length === 0) {
    snapshots.push({
      provider: "bing_webmaster",
      propertyRef,
      date: range.endDate,
      metrics: {
        clicks: 0,
        impressions: 0,
        ctr: 0,
        position: 0,
        crawledPages: 0,
        crawlErrors: 0,
        inCrawlQueue: 0,
      },
      dimensions: {
        queries: [],
        crawlIssues: crawlIssues.slice(0, 20),
      },
    });
  }

  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  return snapshots;
}

module.exports = {
  fetchBingPerformance,
  parseBingDate,
  getDefaultDateRange,
  formatDate,
};
