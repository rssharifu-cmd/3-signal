/**
 * Sharflow — External Research Layer: Generic RSS / Atom Feed Provider
 *
 * Provides a lightweight, dependency-free RSS and Atom feed parser for external
 * verification, authoritative search status updates, and contextual research.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * - External research is CONTEXTUAL EVIDENCE ONLY.
 * - Never replaces first-party analytics (GSC, GA4, Bing).
 * - Safe limits, timeouts, and failure isolation: errors return [] and never crash callers.
 */

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS = 5;
const MAX_ITEMS_CAP = 25;

// Authoritative industry research feeds
const GOOGLE_SEARCH_CENTRAL_FEED = "https://developers.google.com/search/blog/rss.xml";

/**
 * Validates whether a given string is a valid HTTP/HTTPS URL.
 * @param {string} urlString
 * @returns {boolean}
 */
function isValidUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return false;
  try {
    const parsed = new URL(urlString.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Executes a Promise with a strict timeout limit.
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise}
 */
function withTimeout(promise, ms, label = "RSS request") {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeoutPromise,
  ]);
}

/**
 * Unescapes common XML / HTML entities and removes tags.
 * @param {string} str
 * @returns {string}
 */
function cleanText(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts inner text from a tag using regex, supporting CDATA blocks.
 * @param {string} xmlBlock
 * @param {string} tagName
 * @returns {string}
 */
function extractTag(xmlBlock, tagName) {
  const cdataRegex = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[(.*?)\\]\\]><\\/${tagName}>`, "is");
  const standardRegex = new RegExp(`<${tagName}[^>]*>(.*?)<\\/${tagName}>`, "is");

  const cdataMatch = cdataRegex.exec(xmlBlock);
  if (cdataMatch && cdataMatch[1]) {
    return cleanText(cdataMatch[1]);
  }

  const standardMatch = standardRegex.exec(xmlBlock);
  if (standardMatch && standardMatch[1]) {
    return cleanText(standardMatch[1]);
  }

  return "";
}

/**
 * Parses RSS 2.0 (<item>) or Atom (<entry>) XML blocks into normalized evidence objects.
 * @param {string} xml
 * @param {string} feedUrl
 * @param {number} limit
 * @returns {Array<object>}
 */
function parseFeedXml(xml, feedUrl, limit) {
  if (!xml || typeof xml !== "string") return [];

  const items = [];

  // Check if Atom format (<entry>) or RSS format (<item>)
  const isAtom = xml.includes("<entry") && !xml.includes("<item");
  const blockRegex = isAtom ? /<entry[\s>]([\s\S]*?)<\/entry>/gi : /<item[\s>]([\s\S]*?)<\/item>/gi;

  let match;
  while ((match = blockRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1];

    // 1. Extract Title
    const title = extractTag(block, "title");

    // 2. Extract Link
    let link = "";
    if (isAtom) {
      // Atom link can be <link href="..." /> or <link>...</link>
      const hrefMatch = /<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i.exec(block);
      if (hrefMatch && hrefMatch[1]) {
        link = hrefMatch[1].trim();
      } else {
        link = extractTag(block, "link");
      }
    } else {
      link = extractTag(block, "link");
    }

    // 3. Extract Snippet / Summary
    let snippetRaw = "";
    if (isAtom) {
      snippetRaw = extractTag(block, "summary") || extractTag(block, "content");
    } else {
      snippetRaw = extractTag(block, "description") || extractTag(block, "content:encoded");
    }
    const snippet = snippetRaw ? snippetRaw.slice(0, 400).trim() : null;

    // 4. Extract Published Date
    let pubDate = "";
    if (isAtom) {
      pubDate = extractTag(block, "updated") || extractTag(block, "published");
    } else {
      pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date");
    }

    if (title && link) {
      items.push({
        source: "rss",
        title,
        url: link,
        snippet,
        publishedDate: pubDate ? pubDate.trim() : null,
        relevance: null, // Relevance cannot be fabricated for RSS
        feedUrl,
        // Backward-compatibility alias:
        published: pubDate ? pubDate.trim() : "",
      });
    }
  }

  return items;
}

/**
 * Fetches and parses an arbitrary RSS or Atom feed URL.
 *
 * @param {object} params
 * @param {string} params.url - Feed URL to fetch
 * @param {number} [params.maxItems] - Max items to return (clamped 1-25, default 5)
 * @param {number} [params.timeoutMs] - Request timeout in milliseconds (default 12000)
 * @returns {Promise<Array<object>>} Array of normalized evidence items
 */
async function fetchRssFeed({
  url,
  maxItems = DEFAULT_MAX_ITEMS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  // 1. Validate feed URL
  if (!isValidUrl(url)) {
    console.warn(`[Research/RSS] Invalid feed URL provided: "${url}"`);
    return [];
  }
  const cleanUrl = url.trim();

  // 2. Clamp limit
  const limit = Math.max(1, Math.min(Number(maxItems) || DEFAULT_MAX_ITEMS, MAX_ITEMS_CAP));

  // 3. Fetch feed content with failure isolation
  try {
    const res = await withTimeout(
      fetch(cleanUrl, {
        headers: {
          "User-Agent": "Sharflow-Watchdog/1.0 (RSS Research)",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
      }),
      timeoutMs,
      `RSS fetch ${cleanUrl.slice(0, 60)}`
    );

    if (!res.ok) {
      console.warn(`[Research/RSS] HTTP ${res.status} returned for feed "${cleanUrl.slice(0, 80)}"`);
      return [];
    }

    const xmlText = await res.text();
    return parseFeedXml(xmlText, cleanUrl, limit);
  } catch (err) {
    console.warn(`[Research/RSS] Failed fetching feed "${cleanUrl.slice(0, 80)}": ${err.message}`);
    return [];
  }
}

module.exports = {
  fetchRssFeed,
  isValidUrl,
  cleanText,
  parseFeedXml,
  GOOGLE_SEARCH_CENTRAL_FEED,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ITEMS,
};
