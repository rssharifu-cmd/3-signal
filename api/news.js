/**
 * Vercel Node.js Serverless — /api/news
 *
 * Fetches personalized news for a user profile.
 *
 * POST { topics, profession, avoid, plan }
 *   → Tavily API    — AI-powered news search
 *   → RSS Feeds     — trusted sources (BBC, TechCrunch, etc.)
 *   → Reddit JSON   — community buzz (free, no key)
 *   → YouTube API   — 1 relevant video
 *
 * GET → health check
 *
 * Required env vars:
 *   TAVILY_API_KEY
 *   YOUTUBE_API_KEY
 */

const { searchWeb, fetchRssFeed, searchReddit } = require("./_lib/research");

const YOUTUBE_URL = "https://www.googleapis.com/youtube/v3/search";
const TIMEOUT_MS  = 20000;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = typeof req.body === "string" ? req.body : "";
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms)),
  ]);
}

// ── TAVILY — AI-powered news search (delegated to research layer) ─────────────
async function fetchTavilyNews(topics, avoid, apiKey) {
  const query = topics
    ? `Latest news: ${topics}`
    : "Top news today technology business";

  const excludeDomains = avoid
    ? avoid.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  return searchWeb({
    query,
    topic: "news",
    maxResults: 6,
    excludeDomains,
    apiKey,
    timeoutMs: TIMEOUT_MS,
  });
}

// ── RSS FEEDS — trusted news sources (delegated to research layer) ────────────
async function fetchRSSFeeds(topics) {
  const topicsLower = (topics || "").toLowerCase();

  const feedMap = [
    { keys: ["ai", "ml", "machine learning"],  url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
    { keys: ["startup"],                        url: "https://techcrunch.com/category/startups/feed/" },
    { keys: ["finance", "market", "economy"],  url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
    { keys: ["tech", "engineering", "software"], url: "https://feeds.feedburner.com/TechCrunch" },
    { keys: ["design", "ux"],                  url: "https://www.smashingmagazine.com/feed/" },
    { keys: ["politics", "world", "geopolitics"], url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { keys: ["climate", "environment"],        url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml" },
    { keys: ["health", "medical"],             url: "https://feeds.bbci.co.uk/news/health/rss.xml" },
    { keys: ["science"],                       url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml" },
  ];

  let feedUrl = "https://feeds.bbci.co.uk/news/rss.xml"; // default
  for (const { keys, url } of feedMap) {
    if (keys.some(k => topicsLower.includes(k))) { feedUrl = url; break; }
  }

  return fetchRssFeed({
    url: feedUrl,
    maxItems: 4,
    timeoutMs: TIMEOUT_MS,
  });
}

// ── REDDIT — community buzz (delegated to research layer) ─────────────────────
async function fetchRedditPosts(topics) {
  const topicsLower = (topics || "").toLowerCase();

  const subredditMap = {
    "ai":          "artificial",
    "ml":          "MachineLearning",
    "machine":     "MachineLearning",
    "startup":     "startups",
    "product":     "ProductManagement",
    "finance":     "finance",
    "market":      "investing",
    "crypto":      "CryptoCurrency",
    "web3":        "web3",
    "marketing":   "marketing",
    "design":      "design",
    "politics":    "worldnews",
    "geopolitics": "geopolitics",
    "climate":     "climate",
    "engineering": "programming",
    "tech":        "technology",
  };

  let subreddit = "technology";
  for (const [key, sub] of Object.entries(subredditMap)) {
    if (topicsLower.includes(key)) { subreddit = sub; break; }
  }

  return searchReddit({
    subreddit,
    limit: 4,
    timeoutMs: TIMEOUT_MS,
  });
}

// ── YOUTUBE — 1 relevant video ────────────────────────────────────────────────
async function fetchYouTubeVideo(topics, profession, apiKey) {
  const primaryTopic = (topics || "technology").split(",")[0].trim();
  const query = `${primaryTopic} ${profession ? profession.split(" ")[0] : ""} 2025`.trim();

  try {
    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      order: "relevance",
      maxResults: "5",
      videoDuration: "medium",
      relevanceLanguage: "en",
      publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      key: apiKey,
    });

    const res = await withTimeout(fetch(`${YOUTUBE_URL}?${params}`), TIMEOUT_MS);

    if (!res.ok) {
      console.warn("YouTube error:", res.status);
      return null;
    }

    const data = await res.json();
    const items = data.items || [];
    if (!items.length) return null;

    const item = items.find(i => i.snippet?.title?.length > 10) || items[0];
    const snippet = item.snippet || {};
    const videoId = item.id?.videoId;
    if (!videoId) return null;

    return {
      source: "youtube",
      title: snippet.title || "",
      channel: snippet.channelTitle || "",
      url: `https://youtube.com/watch?v=${videoId}`,
      videoId,
      published: snippet.publishedAt || "",
      description: (snippet.description || "").slice(0, 300),
    };
  } catch (e) {
    console.warn("YouTube fetch failed:", e.message);
    return null;
  }
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/news", runtime: "nodejs" });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const tavilyKey  = (process.env.TAVILY_API_KEY  || "").trim();
  const youtubeKey = (process.env.YOUTUBE_API_KEY || "").trim();

  try {
    const body       = parseBody(req);
    const topics     = (body.topics     || "technology, AI").trim();
    const profession = (body.profession || "").trim();
    const avoid      = (body.avoid      || "").trim();

    // Fetch all sources in parallel (RSS + Reddit always; Tavily/YouTube when keys exist)
    const [tavilyRes, rssRes, redditRes, youtubeRes] = await Promise.allSettled([
      tavilyKey ? fetchTavilyNews(topics, avoid, tavilyKey) : Promise.resolve([]),
      fetchRSSFeeds(topics),
      fetchRedditPosts(topics),
      youtubeKey ? fetchYouTubeVideo(topics, profession, youtubeKey) : Promise.resolve(null),
    ]);

    const tavilyArticles = tavilyRes.status === "fulfilled" ? tavilyRes.value : [];
    const rssItems       = rssRes.status    === "fulfilled" ? rssRes.value    : [];
    const redditPosts    = redditRes.status === "fulfilled" ? redditRes.value : [];
    const video          = youtubeRes.status === "fulfilled" ? youtubeRes.value : null;

    // Merge articles: Tavily first (most relevant), then RSS
    const articles = [...tavilyArticles, ...rssItems].slice(0, 8);

    // Build text blocks for Groq digest prompt
    const articleText = articles.length
      ? articles.map((a, i) =>
          `[${i + 1}] ${a.title}\nSource: ${a.source.toUpperCase()} | ${a.url}\n${a.snippet}`
        ).join("\n\n")
      : "No articles fetched.";

    const redditText = redditPosts.length
      ? redditPosts.map((r, i) =>
          `[R${i + 1}] ${r.title}\n${r.snippet}\n${r.url}`
        ).join("\n\n")
      : "No Reddit posts fetched.";

    const videoText = video
      ? `"${video.title}" by ${video.channel}\nURL: ${video.url}\n${video.description}`
      : "No video found.";

    return res.status(200).json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      topics,
      profession,
      sources: {
        tavily: Boolean(tavilyKey),
        youtube: Boolean(youtubeKey),
        rss: true,
        reddit: true,
      },
      content: { articles, reddit: redditPosts, video },
      text: { articles: articleText, reddit: redditText, video: videoText },
      counts: {
        tavily: tavilyArticles.length,
        rss:    rssItems.length,
        reddit: redditPosts.length,
        video:  video ? 1 : 0,
        total:  articles.length + redditPosts.length + (video ? 1 : 0),
      },
    });

  } catch (err) {
    console.error("news route error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

module.exports = handler;
