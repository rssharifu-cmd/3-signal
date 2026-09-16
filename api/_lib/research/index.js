/**
 * Sharflow — External Research Layer
 *
 * Central export for external research providers (Tavily, RSS, Reddit).
 * Provides clean, isolated, reusable, and failure-tolerant research primitives
 * for external verification and future Watchdog investigations.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * - External research must NEVER replace first-party analytics (GSC, GA4, Bing).
 * - Contextual evidence only.
 * - Always returns normalized evidence arrays.
 * - All providers feature strict timeouts and failure isolation (never crash callers).
 */

const { searchWeb, TAVILY_SEARCH_URL } = require("./tavily");
const { fetchRssFeed, GOOGLE_SEARCH_CENTRAL_FEED } = require("./rss");
const { searchReddit } = require("./reddit");

module.exports = {
  searchWeb,
  fetchRssFeed,
  searchReddit,
  GOOGLE_SEARCH_CENTRAL_FEED,
  TAVILY_SEARCH_URL,
};
