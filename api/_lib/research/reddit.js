/**
 * Sharflow — External Research Layer: Reddit Community Research Provider
 *
 * Provides targeted, best-effort search across relevant professional communities
 * (e.g., r/SEO, r/bigseo) to check for community reports of search engine turbulence,
 * algorithm volatility, or tracking platform issues.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * - Reddit is strictly OPTIONAL and BEST-EFFORT.
 * - HTTP 429 (rate-limit), timeouts, or network blocks MUST NEVER crash reports.
 * - Returns [] on any failure with concise diagnostic logging.
 * - Never retries aggressively.
 * - External research is contextual evidence only; never replaces analytics truth.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT_CAP = 15;
const REDDIT_USER_AGENT = "Sharflow/1.0";

/**
 * Executes a Promise with a strict timeout limit.
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise}
 */
function withTimeout(promise, ms, label = "Reddit request") {
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
 * Cleans a subreddit name (stripping leading r/ or /r/ if present).
 * @param {string} sub
 * @returns {string}
 */
function sanitizeSubreddit(sub) {
  if (!sub || typeof sub !== "string") return "";
  return sub.trim().replace(/^\/?r\//i, "").replace(/[^a-zA-Z0-9_]/g, "");
}

/**
 * Searches Reddit communities or a specific subreddit for relevant discussions.
 *
 * @param {object} params
 * @param {string} [params.query] - Search term (e.g., "algorithm update march 2026")
 * @param {string} [params.subreddit] - Target subreddit (e.g., "SEO", "bigseo")
 * @param {number} [params.limit] - Max items to return (clamped 1-15, default 5)
 * @param {string} [params.sort] - "relevance" | "hot" | "new" | "top" (default "relevance")
 * @param {string} [params.time] - "day" | "week" | "month" | "year" | "all" (default "all")
 * @param {number} [params.timeoutMs] - Request timeout in milliseconds (default 10000)
 * @returns {Promise<Array<object>>} Normalized evidence array
 */
async function searchReddit({
  query,
  subreddit,
  limit = DEFAULT_LIMIT,
  sort = "relevance",
  time = "all",
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const cleanSub = sanitizeSubreddit(subreddit);
  const cleanQuery = typeof query === "string" ? query.trim() : "";

  // Require either a query or a target subreddit
  if (!cleanSub && !cleanQuery) {
    return [];
  }

  const clampedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT_CAP));

  // Determine endpoint URL based on query & subreddit
  let endpointUrl = "";
  if (cleanSub && cleanQuery) {
    // Restricted search inside target subreddit
    const params = new URLSearchParams({
      q: cleanQuery,
      restrict_sr: "1",
      sort,
      limit: String(clampedLimit),
      t: time,
    });
    endpointUrl = `https://www.reddit.com/r/${encodeURIComponent(cleanSub)}/search.json?${params}`;
  } else if (cleanSub) {
    // Hot posts from target subreddit
    const params = new URLSearchParams({
      limit: String(clampedLimit),
    });
    endpointUrl = `https://www.reddit.com/r/${encodeURIComponent(cleanSub)}/hot.json?${params}`;
  } else {
    // Global search across Reddit
    const params = new URLSearchParams({
      q: cleanQuery,
      sort,
      limit: String(clampedLimit),
      t: time,
    });
    endpointUrl = `https://www.reddit.com/search.json?${params}`;
  }

  try {
    const res = await withTimeout(
      fetch(endpointUrl, {
        headers: {
          "User-Agent": REDDIT_USER_AGENT,
          Accept: "application/json",
        },
      }),
      timeoutMs,
      "Reddit search"
    );

    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`[Research/Reddit] HTTP 429 (Rate Limited) for r/${cleanSub || "all"}. Skipping Reddit evidence gracefully.`);
      } else {
        console.warn(`[Research/Reddit] HTTP ${res.status} returned for r/${cleanSub || "all"}`);
      }
      return [];
    }

    const data = await res.json();
    const children = Array.isArray(data?.data?.children) ? data.data.children : [];

    // Filter out stickied, NSFW, or deleted items
    const validPosts = children.filter((p) => {
      const d = p?.data;
      return d && !d.stickied && !d.over_18 && d.title;
    });

    return validPosts.slice(0, clampedLimit).map((p) => {
      const d = p.data;
      const permalink = d.permalink ? `https://reddit.com${d.permalink}` : (d.url || "");
      const upvotes = typeof d.ups === "number" ? d.ups : null;
      const postSub = d.subreddit || cleanSub || null;

      let snippetText = "";
      if (d.selftext && d.selftext.trim()) {
        snippetText = d.selftext.trim().slice(0, 300);
      } else {
        snippetText = `${upvotes || 0} upvotes · r/${postSub || "community"}`;
      }

      let publishedDate = null;
      if (typeof d.created_utc === "number") {
        try {
          publishedDate = new Date(d.created_utc * 1000).toISOString();
        } catch {}
      }

      return {
        source: "reddit",
        title: (d.title || "").trim(),
        url: permalink,
        snippet: snippetText || null,
        publishedDate,
        relevance: null, // No fabricated scores for Reddit
        subreddit: postSub,
        upvotes,
        // Backward-compatibility alias:
        published: publishedDate || "",
      };
    });
  } catch (err) {
    // Failure isolation: never throw, return empty evidence
    console.warn(`[Research/Reddit] Request failed for r/${cleanSub || "all"} (${err.message}). Returning empty evidence.`);
    return [];
  }
}

module.exports = {
  searchReddit,
  sanitizeSubreddit,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_LIMIT,
};
