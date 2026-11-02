const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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
  let queriesComplete=true, crawlComplete=true, issuesComplete=true;
  try {
    trafficStats = await callBingApi("GetRankAndTrafficStats", propertyRef, accessToken);
  } catch (err) {
    throw new Error("Bing daily traffic request failed");
  }

  // 2. Fetch query-level stats
  let queryStats = [];
  try {
    queryStats = await callBingApi("GetQueryStats", propertyRef, accessToken);
  } catch (err) {
    queriesComplete=false;
    console.warn(`[Bing Fetch] GetQueryStats failed for ${propertyRef}:`, err.message);
  }

  // 3. Fetch crawl stats
  let crawlStats = [];
  try {
    crawlStats = await callBingApi("GetCrawlStats", propertyRef, accessToken);
  } catch (err) {
    crawlComplete=false;
    console.warn(`[Bing Fetch] GetCrawlStats failed for ${propertyRef}:`, err.message);
  }

  // 4. Fetch crawl issues
  let crawlIssues = [];
  try {
    crawlIssues = await callBingApi("GetCrawlIssues", propertyRef, accessToken);
  } catch (err) {
    issuesComplete=false;
    console.warn(`[Bing Fetch] GetCrawlIssues failed for ${propertyRef}:`, err.message);
  }

  // Index crawl stats by date
  const crawlByDate = {};
  crawlStats.forEach((cs) => {
    const d = parseBingDate(cs.CrawlDate || cs.Date);
    if (d) {
      crawlByDate[d] = {
        crawledPages: numeric(cs.CrawledPages),
        crawlErrors: numeric(cs.CrawlErrors),
        inCrawlQueue: numeric(cs.InCrawlQueue),
        code2xx: numeric(cs.Code2xx),
        code3xx: numeric(cs.Code3xx),
        code4xx: numeric(cs.Code4xx),
        code5xx: numeric(cs.Code5xx),
      };
    }
  });

  // Index queries by date
  const queriesByDate = {};
  queryStats.forEach((qs) => {
    const d = parseBingDate(qs.Date);
    const query = qs.Query || "";
    const clicks = numeric(qs.Clicks);
    const impressions = numeric(qs.Impressions);
    const avgPosition = numeric(qs.AvgClickPosition) ?? numeric(qs.AvgImpressionPosition);
    const ctr = clicks !== null && impressions > 0 ? Number((clicks / impressions).toFixed(4)) : null;

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
        clicks: numeric(ts.Clicks),
        impressions: numeric(ts.Impressions),
        avgClickPosition: numeric(ts.AvgClickPosition),
        avgImpressionPosition: numeric(ts.AvgImpressionPosition),
      };
    }
  });

  // Collect all unique dates found across traffic, queries, and crawl stats
  const allDates = new Set(Object.keys(trafficByDate));

  const snapshots = [];

  if (allDates.size > 0) {
    for (const d of allDates) {
      // Filter within range if range is set
      if (d < range.startDate || d > range.endDate) continue;

      const t = trafficByDate[d] || {};
      const c = crawlByDate[d] || {};
      const q = queriesByDate[d] || [];

      q.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

      const clicks = numeric(t.clicks);
      const impressions = numeric(t.impressions);
      const ctr = clicks !== null && impressions > 0 ? Number((clicks / impressions).toFixed(4)) : null;
      const position = t.avgClickPosition ?? t.avgImpressionPosition ?? null;

      snapshots.push({
        provider: "bing_webmaster",
        propertyRef,
        date: d,
        metrics: {
          clicks,
          impressions,
          ctr,
          position,
          crawledPages: crawlComplete && c.crawledPages !== undefined ? c.crawledPages : null,
          crawlErrors: crawlComplete && c.crawlErrors !== undefined ? c.crawlErrors : null,
          inCrawlQueue: c.inCrawlQueue ?? null,
        },
        dimensions: {
          queries: q.slice(0, 100),
          crawlIssues: crawlIssues.slice(0, 20),
        },
      });
    }
  }

  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  for (const snapshot of snapshots) snapshot.dataQuality={daily:true, dimensions:{queries:queriesComplete && snapshot.dimensions.queries.length<100, crawlIssues:false}, warnings:!queriesComplete||!crawlComplete||!issuesComplete ? ["Bing optional evidence unavailable"] : []};
  return snapshots;
}

module.exports = {
  fetchBingPerformance,
  parseBingDate,
  getDefaultDateRange,
  formatDate,
};
