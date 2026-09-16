/**
 * Sharflow — External Research Layer Test Suite
 *
 * Validates:
 * 1. Tavily web search module (safe limits, normalization, error isolation)
 * 2. Generic RSS / Atom feed module (XML parsing, URL validation, timeout tolerance)
 * 3. Reddit community search module (targeted subreddits, optional/best-effort handling)
 * 4. Index exports & evidence format standardization
 */

const { searchWeb, fetchRssFeed, searchReddit, GOOGLE_SEARCH_CENTRAL_FEED } = require("../api/_lib/research");
const { parseFeedXml, isValidUrl } = require("../api/_lib/research/rss");
const { sanitizeSubreddit } = require("../api/_lib/research/reddit");

async function runSuite() {
  console.log("════════════════════════════════════════════════════════════════");
  console.log("   SHARFLOW — EXTERNAL RESEARCH LAYER TEST SUITE (PHASE 1)      ");
  console.log("════════════════════════════════════════════════════════════════\n");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // ── TEST 1: Module Exports ───────────────────────────────────────────────
  console.log("📋 [Test 1] Testing index module exports...");
  assert(typeof searchWeb === "function", "searchWeb is exported as a function");
  assert(typeof fetchRssFeed === "function", "fetchRssFeed is exported as a function");
  assert(typeof searchReddit === "function", "searchReddit is exported as a function");
  assert(typeof GOOGLE_SEARCH_CENTRAL_FEED === "string" && GOOGLE_SEARCH_CENTRAL_FEED.startsWith("https://"), "GOOGLE_SEARCH_CENTRAL_FEED constant is exported");

  // ── TEST 2: Tavily Provider Resilience & Limits ──────────────────────────
  console.log("\n📋 [Test 2] Testing Tavily web search failure isolation...");
  
  // Empty query
  const emptyRes = await searchWeb({ query: "" });
  assert(Array.isArray(emptyRes) && emptyRes.length === 0, "Empty query returns empty array without throwing");

  // Invalid query types
  const nullQueryRes = await searchWeb({ query: null });
  assert(Array.isArray(nullQueryRes) && nullQueryRes.length === 0, "Null query returns empty array");

  // Missing API key when env var is cleared
  const noKeyRes = await searchWeb({ query: "Google Search Central updates", apiKey: " " });
  assert(Array.isArray(noKeyRes) && noKeyRes.length === 0, "Missing API key returns empty array safely");

  // Invalid key handling (graceful error isolation)
  const invalidKeyRes = await searchWeb({ query: "Google Search Central updates", apiKey: "tvly-invalid-key-test" });
  assert(Array.isArray(invalidKeyRes) && invalidKeyRes.length === 0, "Invalid API key fails gracefully and returns empty array");

  // ── TEST 3: RSS Feed Module XML Parsing & Resilience ─────────────────────
  console.log("\n📋 [Test 3] Testing RSS / Atom feed parsing & error isolation...");

  assert(isValidUrl("https://developers.google.com/search/blog/rss.xml"), "isValidUrl accepts valid HTTPS URL");
  assert(!isValidUrl("not-a-url"), "isValidUrl rejects invalid URL string");
  assert(!isValidUrl("javascript:alert(1)"), "isValidUrl rejects javascript: scheme");

  // Test RSS 2.0 XML parsing
  const sampleRssXml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Search Central Blog</title>
        <item>
          <title><![CDATA[March 2026 Core Update Status]]></title>
          <link>https://developers.google.com/search/blog/2026/03/core-update</link>
          <description><![CDATA[The March 2026 core update rollout is now complete. &amp; Details inside.]]></description>
          <pubDate>Mon, 09 Mar 2026 12:00:00 GMT</pubDate>
        </item>
      </channel>
    </rss>
  `;

  const parsedRss = parseFeedXml(sampleRssXml, "https://test.com/feed.xml", 5);
  assert(parsedRss.length === 1, "parseFeedXml parses RSS item successfully");
  assert(parsedRss[0].source === "rss", "Parsed item has source='rss'");
  assert(parsedRss[0].title === "March 2026 Core Update Status", "Title extracted correctly with CDATA decoded");
  assert(parsedRss[0].url === "https://developers.google.com/search/blog/2026/03/core-update", "URL extracted correctly");
  assert(parsedRss[0].snippet.includes("& Details inside."), "Description entities decoded and tags stripped");
  assert(parsedRss[0].relevance === null, "Relevance is null (not fabricated)");

  // Test Atom XML parsing
  const sampleAtomXml = `
    <?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Feed</title>
      <entry>
        <title>Helpful Content Documentation Update</title>
        <link href="https://developers.google.com/search/docs/helpful-content" />
        <summary>Guidance updated for webmasters.</summary>
        <updated>2026-03-10T10:00:00Z</updated>
      </entry>
    </feed>
  `;

  const parsedAtom = parseFeedXml(sampleAtomXml, "https://test.com/atom.xml", 5);
  assert(parsedAtom.length === 1, "parseFeedXml parses Atom entry successfully");
  assert(parsedAtom[0].title === "Helpful Content Documentation Update", "Atom title parsed");
  assert(parsedAtom[0].url === "https://developers.google.com/search/docs/helpful-content", "Atom link href parsed");
  assert(parsedAtom[0].publishedDate === "2026-03-10T10:00:00Z", "Atom updated date parsed");

  // Invalid feed URL failure isolation
  const invalidRss = await fetchRssFeed({ url: "https://invalid-domain-does-not-exist-12345.com/rss.xml", timeoutMs: 2000 });
  assert(Array.isArray(invalidRss) && invalidRss.length === 0, "Network error returns empty array without throwing");

  // ── TEST 4: Reddit Community Search Module ───────────────────────────────
  console.log("\n📋 [Test 4] Testing Reddit research module...");

  assert(sanitizeSubreddit("r/SEO") === "SEO", "sanitizeSubreddit strips leading r/");
  assert(sanitizeSubreddit("/r/bigseo") === "bigseo", "sanitizeSubreddit strips leading /r/");
  assert(sanitizeSubreddit("tech-news!") === "technews", "sanitizeSubreddit strips special characters");

  // Empty query & empty subreddit
  const emptyReddit = await searchReddit({});
  assert(Array.isArray(emptyReddit) && emptyReddit.length === 0, "Empty Reddit call returns empty array");

  // Best-effort test call
  const redditResults = await searchReddit({
    query: "Google core update",
    subreddit: "SEO",
    limit: 2,
    timeoutMs: 5000,
  });
  assert(Array.isArray(redditResults), "searchReddit returns an array");
  if (redditResults.length > 0) {
    const first = redditResults[0];
    assert(first.source === "reddit", "Reddit item has source='reddit'");
    assert(typeof first.title === "string" && first.title.length > 0, "Reddit item has title");
    assert(first.relevance === null, "Reddit item does not fabricate relevance score");
    assert(first.subreddit === "SEO" || typeof first.subreddit === "string", "Reddit item contains subreddit context");
    console.log(`  ℹ️ Live Reddit sample post: "${first.title.slice(0, 60)}..."`);
  } else {
    console.log("  ℹ️ Reddit public endpoint returned 0 items or rate-limited (gracefully handled as empty array)");
  }

  // ── TEST 5: Evidence Format Normalization Contract ─────────────────────────
  console.log("\n📋 [Test 5] Validating unified evidence schema contract...");
  const sampleEvidenceItems = [
    ...parsedRss,
    ...parsedAtom,
    ...(redditResults.length > 0 ? redditResults : [
      {
        source: "reddit",
        title: "Mock check",
        url: "https://reddit.com/r/SEO",
        snippet: "50 upvotes · r/SEO",
        publishedDate: "2026-03-10T00:00:00Z",
        relevance: null,
      }
    ]),
  ];

  for (const item of sampleEvidenceItems) {
    assert(
      ["tavily", "rss", "reddit"].includes(item.source),
      `Item source "${item.source}" is valid enum`
    );
    assert(typeof item.title === "string", `Item title is string`);
    assert(typeof item.url === "string", `Item url is string`);
    assert(item.snippet === null || typeof item.snippet === "string", `Item snippet is string or null`);
    assert(item.publishedDate === null || typeof item.publishedDate === "string", `Item publishedDate is string or null`);
    assert(item.relevance === null || typeof item.relevance === "number", `Item relevance is number or null`);
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED               `);
  console.log("════════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Unhandled error running research test suite:", err);
  process.exit(1);
});
