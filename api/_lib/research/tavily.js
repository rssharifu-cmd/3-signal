/**
 * Sharflow — External Research Layer: Tavily Web Search Provider
 *
 * Provides generic, reusable web research capabilities for external verification
 * and contextual evidence.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * - External research is CONTEXTUAL EVIDENCE ONLY.
 * - Never replaces first-party analytics (GSC, GA4, Bing).
 * - Never invents traffic numbers, rankings, revenue, or analytics data.
 * - TAVILY_API_KEY must never leak to frontend, logs, or error responses.
 * - Safe limits, timeouts, and failure isolation: errors return [] and never crash callers.
 */

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 20;

/**
 * Executes a Promise with a strict timeout limit.
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise}
 */
function withTimeout(promise, ms, label = "Tavily request") {
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
 * Searches the web via Tavily API and returns normalized evidence objects.
 *
 * @param {object} params
 * @param {string} params.query - Search query string
 * @param {string} [params.topic] - Search topic ("general" | "news", defaults to "general")
 * @param {number} [params.maxResults] - Max items to return (clamped between 1 and 20)
 * @param {number} [params.days] - Limit results to past N days (optional)
 * @param {Array<string>} [params.excludeDomains] - Domains to exclude from results
 * @param {string} [params.searchDepth] - "basic" or "advanced" (defaults to "advanced")
 * @param {string} [params.apiKey] - Optional explicit API key override
 * @param {number} [params.timeoutMs] - Request timeout in milliseconds (defaults to 15000)
 * @returns {Promise<Array<object>>} Normalized evidence array
 */
async function searchWeb({
  query,
  topic = "general",
  maxResults = DEFAULT_MAX_RESULTS,
  days,
  excludeDomains = [],
  searchDepth = "advanced",
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  // 1. Validate query input
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return [];
  }
  const cleanQuery = query.trim();

  // 2. Resolve API key securely (server-side only, never leak in logs)
  const resolvedKey = (apiKey || process.env.TAVILY_API_KEY || "").trim();
  if (!resolvedKey) {
    console.warn("[Research/Tavily] TAVILY_API_KEY is not configured. Returning empty evidence.");
    return [];
  }

  // 3. Clamp results to safe bounds
  const clampedLimit = Math.max(1, Math.min(Number(maxResults) || DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP));

  // 4. Build request payload
  const payload = {
    api_key: resolvedKey,
    query: cleanQuery,
    topic: topic === "news" ? "news" : "general",
    search_depth: searchDepth === "basic" ? "basic" : "advanced",
    max_results: clampedLimit,
    include_answer: false,
    include_raw_content: false,
  };

  if (typeof days === "number" && days > 0) {
    payload.days = Math.round(days);
  }

  if (Array.isArray(excludeDomains) && excludeDomains.length > 0) {
    const validDomains = excludeDomains
      .map((d) => (typeof d === "string" ? d.trim().toLowerCase() : ""))
      .filter(Boolean);
    if (validDomains.length > 0) {
      payload.exclude_domains = validDomains;
    }
  }

  // 5. Execute request with strict timeout and failure isolation
  try {
    const res = await withTimeout(
      fetch(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
      timeoutMs,
      "Tavily searchWeb"
    );

    if (!res.ok) {
      // Log HTTP error status without logging the payload or secrets
      console.warn(`[Research/Tavily] HTTP ${res.status} error for query "${cleanQuery.slice(0, 60)}"`);
      return [];
    }

    const data = await res.json();
    const rawResults = Array.isArray(data?.results) ? data.results : [];

    // 6. Return strictly normalized evidence objects
    return rawResults.map((item) => {
      const publishedDate = item.published_date || item.published || null;
      const relevance =
        typeof item.score === "number" && !isNaN(item.score)
          ? Number(item.score.toFixed(3))
          : null;

      const rawSnippet = item.content || item.snippet || "";
      const snippet = rawSnippet ? String(rawSnippet).slice(0, 500).trim() : null;

      return {
        source: "tavily",
        title: (item.title || "").trim(),
        url: (item.url || "").trim(),
        snippet,
        publishedDate: publishedDate ? String(publishedDate).trim() : null,
        relevance,
        // Backward-compatibility alias:
        published: publishedDate ? String(publishedDate).trim() : "",
      };
    });
  } catch (err) {
    // Graceful failure: log concise message, never throw, never leak keys
    console.warn(`[Research/Tavily] Search failed for query "${cleanQuery.slice(0, 60)}": ${err.message}`);
    return [];
  }
}

module.exports = {
  searchWeb,
  TAVILY_SEARCH_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESULTS,
};
