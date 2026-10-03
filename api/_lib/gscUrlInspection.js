/**
 * Sharflow — Google Search Console URL Inspection Helper
 *
 * Weekly, quota-respecting URL inspection supplement (indexing status + mobile usability).
 * Reuses existing getGoogleAccessToken(userEmail) with webmasters.readonly scope.
 * Selects up to 10 high-priority URLs per property and inspects with max concurrency 3.
 */

const { getDb } = require("./db");
const { getGoogleAccessToken } = require("./oauthTokens");

const URL_INSPECTION_ENDPOINT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const COLLECTION_NAME = "url_inspections";
const MAX_URLS_PER_RUN = 10;
const CONCURRENCY_LIMIT = 3;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let indexCreated = false;
async function ensureIndexes() {
  if (indexCreated) return;
  try {
    const db = await getDb();
    await db.collection(COLLECTION_NAME).createIndex({ userEmail: 1, propertyRef: 1, inspectedAt: -1 });
    indexCreated = true;
  } catch (err) {
    console.warn("[UrlInspection] Index creation notice:", err.message);
  }
}

/**
 * Derives the canonical root URL (https://domain/) from propertyRef or userProfile.websiteUrl.
 */
function resolveRootUrl(propertyRef = "", userProfile = {}) {
  const rawProp = String(propertyRef || "").trim();
  if (rawProp.startsWith("http://") || rawProp.startsWith("https://")) {
    try {
      const u = new URL(rawProp);
      return `${u.origin}/`;
    } catch {}
  }
  const profileSite = String(userProfile?.websiteUrl || "").trim();
  if (profileSite) {
    try {
      const u = new URL(profileSite.startsWith("http") ? profileSite : `https://${profileSite}`);
      return `${u.origin}/`;
    } catch {}
  }
  if (rawProp.startsWith("sc-domain:")) {
    const domain = rawProp.slice("sc-domain:".length).trim().replace(/\/+$/, "");
    if (domain) return `https://${domain}/`;
  }
  return "";
}

/**
 * Normalizes a candidate URL against rootUrl for deduplication.
 */
function normalizeCandidateUrl(candidate, rootUrl) {
  if (!candidate) return "";
  const raw = String(candidate).trim();
  if (!raw) return "";
  try {
    const resolved = raw.startsWith("http://") || raw.startsWith("https://")
      ? new URL(raw)
      : new URL(raw.startsWith("/") ? raw : `/${raw}`, rootUrl);
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return "";
  }
}

/**
 * Best-effort fetch of up to 5 <loc> URLs from ${rootUrl}sitemap.xml (3-second timeout).
 */
async function fetchSitemapUrls(rootUrl, maxCount = 5) {
  if (!rootUrl) return [];
  const sitemapUrl = `${rootUrl.replace(/\/$/, "")}/sitemap.xml`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(sitemapUrl, { signal: controller.signal });
    if (!res.ok) return [];
    const xml = await res.text();
    const matches = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)];
    const urls = [];
    for (const m of matches) {
      if (m[1] && !m[1].endsWith(".xml")) {
        urls.push(m[1].trim());
        if (urls.length >= maxCount) break;
      }
    }
    return urls;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Selects up to 10 URLs in priority order:
 * 1) Site root URL (1)
 * 2) userProfile.importantPages (up to 3)
 * 3) Top pages from currentDimensionsPages sorted by clicks desc, impressions desc
 * 4) Fallback to sitemap.xml (up to 5) if < 10 URLs and 0-impression site
 */
async function selectUrlsToInspect(propertyRef, userProfile = {}, currentDimensionsPages = []) {
  let rootUrl = "";

  // 1. Check currentDimensionsPages first: extract the origin (protocol + host) from the most common domain
  // among real pages Google serves in search results — trust them over the raw connected property string.
  if (Array.isArray(currentDimensionsPages) && currentDimensionsPages.length > 0) {
    const originCounts = new Map();
    for (const p of currentDimensionsPages) {
      const raw = p?.page || p?.url || "";
      if (typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://"))) {
        try {
          const u = new URL(raw);
          const orig = `${u.origin}/`;
          originCounts.set(orig, (originCounts.get(orig) || 0) + 1);
        } catch {}
      }
    }
    if (originCounts.size > 0) {
      let topOrigin = "";
      let maxCount = -1;
      for (const [orig, count] of originCounts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          topOrigin = orig;
        }
      }
      rootUrl = topOrigin;
    }
  }

  // 2. Fall back to resolveRootUrl(propertyRef, userProfile) only when currentDimensionsPages yielded no origin
  if (!rootUrl) {
    rootUrl = resolveRootUrl(propertyRef, userProfile);
  }
  if (!rootUrl) return [];

  const selected = [];
  const seen = new Set();

  function addUrl(rawUrl, source) {
    if (selected.length >= MAX_URLS_PER_RUN) return;
    const norm = normalizeCandidateUrl(rawUrl, rootUrl);
    if (!norm) return;
    const key = norm.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    selected.push({ url: norm, source });
  }

  // a) Site root URL (1)
  addUrl(rootUrl, "root");

  // b) userProfile.importantPages (up to 3)
  const importantPages = Array.isArray(userProfile?.importantPages) ? userProfile.importantPages : [];
  for (const p of importantPages.slice(0, 3)) {
    const raw = typeof p === "string" ? p : (p?.url || p?.path || "");
    addUrl(raw, "important_page");
  }

  // c) Remaining slots from currentDimensionsPages sorted by clicks desc then impressions desc
  const pages = Array.isArray(currentDimensionsPages) ? [...currentDimensionsPages] : [];
  pages.sort((a, b) => (b.clicks || 0) - (a.clicks || 0) || (b.impressions || 0) - (a.impressions || 0));
  for (const p of pages) {
    if (selected.length >= MAX_URLS_PER_RUN) break;
    addUrl(p.page || p.url, "top_page");
  }

  // d) If fewer than 10 URLs found and 0-impression site, try sitemap.xml (up to 5 <loc> entries)
  const totalPageImpressions = pages.reduce((sum, p) => sum + (p.impressions || 0), 0);
  if (selected.length < MAX_URLS_PER_RUN && totalPageImpressions === 0) {
    const sitemapUrls = await fetchSitemapUrls(rootUrl, 5);
    for (const loc of sitemapUrls) {
      if (selected.length >= MAX_URLS_PER_RUN) break;
      addUrl(loc, "sitemap");
    }
  }

  return selected;
}

/**
 * Calls Google URL Inspection API for a single URL and normalizes the response.
 */
async function inspectSingleUrl(accessToken, propertyRef, inspectionUrl, source) {
  const res = await fetch(URL_INSPECTION_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inspectionUrl,
      siteUrl: propertyRef,
      languageCode: "en-US",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`URL Inspection HTTP ${res.status} for ${inspectionUrl}: ${errText.slice(0, 140)}`);
  }

  const data = await res.json();
  const result = data.inspectionResult || {};
  const indexStatus = result.indexStatusResult || {};
  const mobileUsability = result.mobileUsabilityResult || {};

  const rawMobileIssues = Array.isArray(mobileUsability.issues) ? mobileUsability.issues : [];
  const mobileUsabilityIssues = rawMobileIssues.map((iss) =>
    typeof iss === "string" ? iss : (iss.issueType || iss.message || "MOBILE_USABILITY_ISSUE")
  );

  return {
    inspectionUrl,
    source,
    verdict: indexStatus.verdict || "VERDICT_UNSPECIFIED",
    coverageState: indexStatus.coverageState || "",
    robotsTxtState: indexStatus.robotsTxtState || "ROBOTS_TXT_STATE_UNSPECIFIED",
    indexingState: indexStatus.indexingState || "INDEXING_STATE_UNSPECIFIED",
    pageFetchState: indexStatus.pageFetchState || "PAGE_FETCH_STATE_UNSPECIFIED",
    lastCrawlTime: indexStatus.lastCrawlTime || null,
    googleCanonical: indexStatus.googleCanonical || "",
    userCanonical: indexStatus.userCanonical || "",
    crawledAs: indexStatus.crawledAs || "CRAWLING_USER_AGENT_UNSPECIFIED",
    mobileUsabilityVerdict: mobileUsability.verdict || "VERDICT_UNSPECIFIED",
    mobileUsabilityIssues,
  };
}

/**
 * Inspects up to 10 priority URLs for a property with max concurrency of 3.
 */
async function inspectPropertyUrls(userEmail, propertyRef, userProfile = {}, currentDimensionsPages = []) {
  if (!userEmail || !propertyRef) {
    throw new Error("userEmail and propertyRef are required for inspectPropertyUrls.");
  }

  const { accessToken } = await getGoogleAccessToken(userEmail);
  const targets = await selectUrlsToInspect(propertyRef, userProfile, currentDimensionsPages);
  const results = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY_LIMIT) {
    const batch = targets.slice(i, i + CONCURRENCY_LIMIT);
    const settled = await Promise.allSettled(
      batch.map((t) => inspectSingleUrl(accessToken, propertyRef, t.url, t.source))
    );
    for (const item of settled) {
      if (item.status === "fulfilled" && item.value) {
        results.push(item.value);
      } else if (item.status === "rejected") {
        console.warn("[UrlInspection] Single URL check warning:", item.reason?.message);
      }
    }
  }

  return results;
}

/**
 * Upserts the latest inspection document per { userEmail, propertyRef } in url_inspections.
 */
async function saveUrlInspection(userId, userEmail, propertyRef, results = []) {
  await ensureIndexes();
  const db = await getDb();
  const col = db.collection(COLLECTION_NAME);
  const now = new Date();
  const inspectionDate = now.toISOString().split("T")[0];

  const doc = {
    userId: userId ? String(userId) : null,
    userEmail,
    propertyRef,
    inspectionDate,
    inspectedAt: now,
    urlCount: Array.isArray(results) ? results.length : 0,
    results: Array.isArray(results) ? results : [],
  };

  await col.updateOne(
    { userEmail, propertyRef },
    { $set: doc },
    { upsert: true }
  );

  return col.findOne({ userEmail, propertyRef });
}

/**
 * Loads the latest URL inspection document for { userEmail, propertyRef } or null.
 */
async function loadLatestUrlInspection(userEmail, propertyRef) {
  if (!userEmail) return null;
  const db = await getDb();
  const query = propertyRef ? { userEmail, propertyRef } : { userEmail };
  return db.collection(COLLECTION_NAME).findOne(query, { sort: { inspectedAt: -1 } });
}

/**
 * Returns true if no inspection document exists or inspectedAt is older than 7 days.
 */
function isInspectionDue(latestDoc) {
  if (!latestDoc || !latestDoc.inspectedAt) return true;
  const inspectedTime = new Date(latestDoc.inspectedAt).getTime();
  if (isNaN(inspectedTime)) return true;
  return (Date.now() - inspectedTime) > SEVEN_DAYS_MS;
}

module.exports = {
  inspectPropertyUrls,
  saveUrlInspection,
  loadLatestUrlInspection,
  isInspectionDue,
  selectUrlsToInspect,
};
