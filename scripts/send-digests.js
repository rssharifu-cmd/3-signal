/**
 * Sharflow — Standalone Digest Sender Script
 * Intended to be executed as a daily cron job via GitHub Actions.
 * 
 * Flow:
 * 1. Loads environment variables (locally via dotenv, or directly in CI).
 * 2. Connects to the real MongoDB database.
 * 3. Fetches all users with valid email and profiles.
 * 4. Processes users in parallel batches of 5.
 * 5. Uses the atomic digests collection lock to prevent duplicate sends.
 * 6. Generates highly personalized daily news digests via Gemini / Groq.
 * 7. Dispatches the emails via Resend.
 * 8. Logs detailed results and exits with non-zero code on failure.
 */

require("dotenv").config();
const { getDb } = require("../api/db");
const { formatMemoryForPrompt, ensureMemory, buildDigestPrompt } = require("../api/memory");

const GROK_URL    = "https://api.groq.com/openai/v1/chat/completions";
const RESEND_URL  = "https://api.resend.com/emails";
const TAVILY_URL  = "https://api.tavily.com/search";
const YOUTUBE_URL = "https://www.googleapis.com/youtube/v3/search";
const MODEL       = "llama-3.3-70b-versatile";
const TIMEOUT_MS  = 30000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms)),
  ]);
}

// ── TIER CONFIGURATION ────────────────────────────────────────────────────────
const TIER_CONFIG = {
  free: {
    queryModel: "gemini-3.5-flash-lite",
    queryCountMin: 3,
    queryCountMax: 4,
    scoringMode: "code",
    finalArticleCount: 6,
  },
  pro: {
    queryModel: "gemini-3.6-flash",
    queryCountMin: 5,
    queryCountMax: 7,
    scoringMode: "code",
    finalArticleCount: 8,
  },
  premium: {
    queryModel: "gemini-3.6-flash",
    queryCountMin: 7,
    queryCountMax: 10,
    scoringMode: "ai",
    finalArticleCount: 10,
  },
};

// ── STAGE 1 — QUERY GENERATION ───────────────────────────────────────────────
function buildFallbackQueries(topics, profession, goals, plan) {
  const tier = TIER_CONFIG[plan] || TIER_CONFIG.free;
  const topicList = (topics || "technology, AI")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const primaryTopic = topicList[0] || "technology";
  const secondaryTopic = topicList[1] || primaryTopic;
  const profRole = (profession || "").split(/[,/]/)[0].trim();
  const currentYear = new Date().getFullYear();

  const queries = [
    { query: `Latest ${primaryTopic} breakthroughs developments`, source: "web", intent: "Primary topic high-conviction news" },
    { query: profRole ? `${profRole} ${primaryTopic} strategies tools` : `${primaryTopic} industry trends`, source: "web", intent: "Role-specific industry developments" },
    { query: `${primaryTopic} best tools recommendations`, source: "reddit", intent: "Community discussions & peer insights" },
    { query: `${primaryTopic} guide breakdown ${currentYear}`, source: "youtube", intent: "Video analysis & breakdowns" },
  ];

  if (tier.queryCountMax > 4) {
    if (goals) {
      queries.push({ query: `${goals} ${primaryTopic} actionable guide`, source: "web", intent: "Goal-adjacent opportunities" });
    }
    if (secondaryTopic !== primaryTopic) {
      queries.push({ query: `Latest ${secondaryTopic} innovations`, source: "web", intent: "Secondary topic updates" });
      queries.push({ query: `${secondaryTopic} founder experience advice`, source: "reddit", intent: "Secondary community insights" });
    }
  }

  return queries.slice(0, tier.queryCountMax);
}

async function generateSearchQueries(user, profile, memory, plan) {
  const tier = TIER_CONFIG[plan] || TIER_CONFIG.free;
  const apiGeminiKey = (process.env.GEMINI_API_KEY || "").trim();
  const apiGrokKey   = (process.env.GROK_API_KEY   || "").trim();
  const topics = profile.topics || "technology, AI";
  const profession = profile.profession || memory?.role || "";
  const goals = profile.goals || memory?.goals || "";
  const avoid = profile.avoid || (memory?.dislikedTopics || []).join(", ");
  const memoryText = formatMemoryForPrompt(memory);

  const fallbackQueries = buildFallbackQueries(topics, profession, goals, plan);

  if (!apiGeminiKey && !apiGrokKey) {
    return fallbackQueries;
  }

  const queryPrompt = `You are a search intelligence engine generating highly targeted research queries for a personalized daily news digest.

USER PROFILE & MEMORY:
${memoryText || `Role: ${profession}\nGoals: ${goals}\nTopics: ${topics}`}
${avoid ? `AVOID TOPICS / OUTLETS: ${avoid}` : ""}

DIRECTIVES:
1. Generate between ${tier.queryCountMin} and ${tier.queryCountMax} queries.
2. Cover distinct strategic angles:
   - Deep-dive into primary learned topic interests
   - Goal-adjacent opportunities and execution moves
   - Role/profession specific developments and competitive shifts
   - Follow-up on recently engaged topics
3. NEVER generate generic queries (e.g. "AI news" or "tech updates"). Formulate specific, high-intent phrases (e.g., "open source agent workflows for solo founders", "b2b pricing strategies enterprise 2026").
4. NEVER touch anything in the avoid/disliked list.
5. Assign a source tag to each query: "web" (for Tavily news search), "reddit" (for authentic community sentiment), or "youtube" (for high-signal video tutorials/breakdowns). Ensure at least 1 "youtube" and 1 "reddit" query; the remainder should be "web".
6. Output ONLY a valid JSON array of objects with the exact schema:
[
  { "query": "string", "source": "web" | "reddit" | "youtube", "intent": "string" }
]`;

  try {
    let rawText = "";
    if (apiGeminiKey) {
      const { GoogleGenAI } = require("@google/genai");
      const ai = new GoogleGenAI({ apiKey: apiGeminiKey });
      const res = await ai.models.generateContent({
        model: tier.queryModel,
        contents: [{ role: "user", parts: [{ text: queryPrompt }] }],
        config: {
          temperature: 0.3,
          responseMimeType: "application/json",
        },
      });
      rawText = res.text || "";
    } else if (apiGrokKey) {
      const res = await withTimeout(
        fetch(GROK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiGrokKey}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: queryPrompt }],
            temperature: 0.3,
          }),
        }),
        TIMEOUT_MS
      );
      if (res.ok) {
        const data = await res.json();
        rawText = data.choices?.[0]?.message?.content || "";
      }
    }

    if (rawText) {
      const cleaned = rawText.replace(/```json\n?|\n?```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const valid = parsed
          .filter((q) => q && typeof q.query === "string" && q.query.trim().length > 3)
          .map((q) => ({
            query: q.query.trim(),
            source: ["web", "reddit", "youtube"].includes(q.source) ? q.source : "web",
            intent: q.intent || "",
          }));
        if (valid.length >= tier.queryCountMin) {
          return valid.slice(0, tier.queryCountMax);
        }
      }
    }
  } catch (err) {
    console.warn(`[QUERY-GEN] AI query generation error for ${user.email} (${err.message}). Using fallback queries.`);
  }

  return fallbackQueries;
}

// Helper to validate syntactically plausible domain names (no spaces, contains dot, valid TLD)
function isValidDomain(str) {
  if (!str || typeof str !== "string") return false;
  const s = str.trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(s);
}

// ── STAGE 2 — CANDIDATE POOL FETCH ───────────────────────────────────────────
async function fetchCandidates(queries, avoid, publishedAfterStr, sentUrls) {
  const tavilyKey  = (process.env.TAVILY_API_KEY  || "").trim();
  const youtubeKey = (process.env.YOUTUBE_API_KEY || "").trim();
  const avoidList  = (avoid || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const excludeDomains = avoidList.filter(isValidDomain);

  const fetchTasks = queries.map(async (qObj) => {
    const { query, source } = qObj;
    if (source === "web") {
      if (!tavilyKey) return [];
      try {
        const res = await withTimeout(
          fetch(TAVILY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: tavilyKey,
              query: query,
              search_depth: "advanced",
              include_answer: false,
              include_raw_content: false,
              max_results: 6,
              ...(excludeDomains.length > 0 ? { exclude_domains: excludeDomains } : {}),
              publishedAfter: publishedAfterStr,
            }),
          }),
          TIMEOUT_MS
        );
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          console.error(`[fetchCandidates] [Tavily] HTTP ${res.status} error for query "${query}": ${errBody.slice(0, 200)}`);
          return [];
        }
        const data = await res.json();
        const rawCount = (data.results || []).length;
        console.log(`[fetchCandidates] [Tavily] Query "${query}" returned ${rawCount} raw results`);
        return (data.results || []).map((r) => ({
          source: "tavily",
          title: r.title || "",
          url: r.url || "",
          snippet: (r.content || r.snippet || "").slice(0, 400),
          queryIntent: qObj.intent,
        }));
      } catch (err) {
        console.error(`[fetchCandidates] [Tavily] Error fetching query "${query}": ${err.message}`);
        return [];
      }
    } else if (source === "reddit") {
      try {
        const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=week&limit=5`;
        const res = await withTimeout(
          fetch(url, { headers: { "User-Agent": "Signal-NewsDigest/1.0 (by /u/sharflow)" } }),
          TIMEOUT_MS
        );
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          console.error(`[fetchCandidates] [Reddit] HTTP ${res.status} error for query "${query}": ${errBody.slice(0, 200)}`);
          return [];
        }
        const data = await res.json();
        const rawCount = (data?.data?.children || []).length;
        console.log(`[fetchCandidates] [Reddit] Query "${query}" returned ${rawCount} raw results`);
        return (data?.data?.children || [])
          .filter((p) => !p.data?.stickied && !p.data?.over_18 && p.data?.title)
          .map((p) => ({
            source: "reddit",
            title: p.data.title,
            url: `https://reddit.com${p.data.permalink || ""}`,
            snippet: `${p.data.ups || 0} upvotes · r/${p.data.subreddit || ""} · ${(p.data.selftext || "").slice(0, 300)}`,
            queryIntent: qObj.intent,
          }));
      } catch (err) {
        console.error(`[fetchCandidates] [Reddit] Error fetching query "${query}": ${err.message}`);
        return [];
      }
    } else if (source === "youtube") {
      if (!youtubeKey) return [];
      try {
        const params = new URLSearchParams({
          part: "snippet",
          q: query,
          type: "video",
          order: "relevance",
          maxResults: "5",
          videoDuration: "medium",
          relevanceLanguage: "en",
          publishedAfter: publishedAfterStr,
          key: youtubeKey,
        });
        const res = await withTimeout(fetch(`${YOUTUBE_URL}?${params}`), TIMEOUT_MS);
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          console.error(`[fetchCandidates] [YouTube] HTTP ${res.status} error for query "${query}": ${errBody.slice(0, 200)}`);
          return [];
        }
        const data = await res.json();
        const rawCount = (data.items || []).length;
        console.log(`[fetchCandidates] [YouTube] Query "${query}" returned ${rawCount} raw results`);
        return (data.items || [])
          .filter((i) => i.snippet?.title?.length > 10)
          .map((item) => ({
            source: "youtube",
            title: item.snippet.title,
            url: `https://youtube.com/watch?v=${item.id.videoId}`,
            snippet: `${item.snippet.channelTitle} · ${item.snippet.description || ""}`.slice(0, 400),
            queryIntent: qObj.intent,
          }));
      } catch (err) {
        console.error(`[fetchCandidates] [YouTube] Error fetching query "${query}": ${err.message}`);
        return [];
      }
    }
    return [];
  });

  const resultsNested = await Promise.all(fetchTasks);
  const flattened = resultsNested.flat();

  // Deduplication by normalized URL and avoid filtering
  const seenUrls = new Set();
  const candidates = [];

  for (const art of flattened) {
    if (!art.url || !art.title) continue;
    const cleanUrl = art.url.trim().toLowerCase().split("?")[0].replace(/\/+$/, "");
    if (seenUrls.has(cleanUrl)) continue;
    seenUrls.add(cleanUrl);

    // Filter against sentUrls from previous digests
    let alreadySent = false;
    for (const sent of sentUrls) {
      if (cleanUrl.includes(sent) || sent.includes(cleanUrl)) {
        alreadySent = true;
        break;
      }
    }
    if (alreadySent) continue;

    // Filter against avoid list
    const combinedText = `${art.title} ${art.snippet} ${art.url}`.toLowerCase();
    const hitAvoid = avoidList.some((avoidTerm) => avoidTerm.length > 2 && combinedText.includes(avoidTerm));
    if (hitAvoid) continue;

    candidates.push(art);
  }

  return candidates;
}

// ── STAGE 3 — RELEVANCE SCORING ──────────────────────────────────────────────
function scoreCandidatesCodeBased(candidates, profile, memory) {
  const interests = memory?.interests || {};
  const disliked = memory?.dislikedTopics || [];
  const favoriteSources = memory?.favoriteSources || [];
  const clicked = memory?.clickedTopics || [];

  const profKeywords = (profile?.profession || memory?.role || "")
    .toLowerCase()
    .split(/[\s,/]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 2);

  const goalKeywords = (profile?.goals || memory?.goals || "")
    .toLowerCase()
    .split(/[\s,/]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 2);

  return candidates.map((art) => {
    let score = 20;
    const tl = (art.title || "").toLowerCase();
    const sl = (art.snippet || "").toLowerCase();
    const combined = `${tl} ${sl}`;

    // 1. Learned topic interest scores from user.memory.interests
    for (const [topic, topicScore] of Object.entries(interests)) {
      const topicLower = topic.toLowerCase();
      if (tl.includes(topicLower)) {
        score += (topicScore / 100) * 25;
      } else if (sl.includes(topicLower)) {
        score += (topicScore / 100) * 10;
      }
    }

    // 2. Profession & role alignment
    profKeywords.forEach((kw) => {
      if (tl.includes(kw)) score += 15;
      else if (sl.includes(kw)) score += 6;
    });

    // 3. Goal alignment
    goalKeywords.forEach((kw) => {
      if (tl.includes(kw)) score += 15;
      else if (sl.includes(kw)) score += 6;
    });

    // 4. Recently clicked / engaged topics
    clicked.forEach((c) => {
      const cTopic = (c.topic || "").toLowerCase();
      if (cTopic && combined.includes(cTopic)) {
        score += 15;
      }
    });

    // 5. Favorite sources bonus
    favoriteSources.forEach((src) => {
      const srcLower = src.toLowerCase();
      if (art.url.toLowerCase().includes(srcLower) || combined.includes(srcLower)) {
        score += 20;
      }
    });

    // 6. Source type baseline weighting
    if (art.source === "tavily") score += 5;
    if (art.source === "youtube") score += 4;
    if (art.source === "reddit") score += 3;

    // 7. Disliked topics penalty
    disliked.forEach((dt) => {
      const dtLower = dt.toLowerCase();
      if (dtLower && combined.includes(dtLower)) {
        score -= 80;
      }
    });

    return { ...art, score: Math.max(0, Math.round(score)) };
  });
}

async function scoreCandidatesAi(candidates, user, profile, memory) {
  const apiGeminiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiGeminiKey || candidates.length <= 1) {
    return scoreCandidatesCodeBased(candidates, profile, memory);
  }

  const memoryText = formatMemoryForPrompt(memory);
  const candidatesSummary = candidates
    .map((c, i) => `[${i + 1}] Title: ${c.title}\nSource: ${c.source}\nSnippet: ${c.snippet}`)
    .join("\n\n");

  const prompt = `You are an elite intelligence analyst scoring news and discussion candidates for a personalized daily digest.

USER PROFILE & MEMORY:
${memoryText || `Role: ${profile.profession}\nGoals: ${profile.goals}\nTopics: ${profile.topics}`}

CANDIDATE ARTICLES:
${candidatesSummary}

TASK:
Score each candidate from 0 to 100 based on its strategic value, specificity, and relevance to this user's role, goals, and learned interests. Heavily penalize clickbait or any disliked topics.

Return ONLY a JSON array of objects with "index" (1-based integer matching candidate list) and "score" (integer 0-100):
[
  { "index": 1, "score": 92 },
  { "index": 2, "score": 45 }
]`;

  try {
    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey: apiGeminiKey });
    const res = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });
    const rawText = res.text || "";
    const parsed = JSON.parse(rawText.replace(/```json\n?|\n?```/g, "").trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
      const scoreMap = new Map();
      parsed.forEach((p) => {
        if (p && typeof p.index === "number") {
          scoreMap.set(p.index, Number(p.score) || 0);
        }
      });
      return candidates.map((c, i) => ({
        ...c,
        score: scoreMap.has(i + 1) ? scoreMap.get(i + 1) : 50,
      }));
    }
  } catch (err) {
    console.warn(`[AI-SCORING] AI scoring failed for ${user.email} (${err.message}). Falling back to code-based scoring.`);
  }

  return scoreCandidatesCodeBased(candidates, profile, memory);
}

// ── FETCH NEWS — 4-Stage Personalization Pipeline ───────────────────────────
async function fetchNews(db, user, topics, profession, avoid, lastDigest) {
  const profile = user.profile || {};
  const plan    = profile.plan || "free";
  const tier    = TIER_CONFIG[plan] || TIER_CONFIG.free;
  const memory  = ensureMemory(user, profile);

  console.log(`[NEWS] ${user.email} (Tier: ${plan}) — starting 4-stage personalization pipeline`);

  let startTimeWindow;
  const minWindowMs = 24 * 60 * 60 * 1000; // never search a window narrower than 24h
  if (lastDigest && lastDigest.sentAt) {
    const sinceLastDigest = Date.now() - new Date(lastDigest.sentAt).getTime();
    startTimeWindow = new Date(Date.now() - Math.max(sinceLastDigest, minWindowMs));
  } else {
    startTimeWindow = new Date(Date.now() - 48 * 60 * 60 * 1000);
  }
  const publishedAfterStr = startTimeWindow.toISOString();

  const sentUrls = new Set();
  if (lastDigest && lastDigest.content) {
    const urlRegex = /https?:\/\/[^\s(">)\*,;]+/g;
    let m;
    while ((m = urlRegex.exec(lastDigest.content)) !== null) {
      sentUrls.add(m[0].trim().replace(/[\.,\);]+$/, "").toLowerCase());
    }
  }

  // Stage 1: Query Generation
  const queries = await generateSearchQueries(user, profile, memory, plan);
  console.log(`[NEWS] ${user.email} — generated ${queries.length} targeted queries [${queries.map((q) => `${q.source}: "${q.query}"`).join("; ")}]`);

  // Stage 2: Candidate Pool Fetch (aiming for 20-30 candidates)
  const candidates = await fetchCandidates(queries, avoid || (memory.dislikedTopics || []).join(", "), publishedAfterStr, sentUrls);
  console.log(`[NEWS] ${user.email} — fetched ${candidates.length} unique candidates`);

  if (candidates.length === 0) {
    return { articles: [] };
  }

  // Stage 3: Relevance Scoring
  let ranked = [];
  if (tier.scoringMode === "ai") {
    ranked = await scoreCandidatesAi(candidates, user, profile, memory);
  } else {
    ranked = scoreCandidatesCodeBased(candidates, profile, memory);
  }

  ranked.sort((a, b) => (b.score || 0) - (a.score || 0));
  const topArticles = ranked.slice(0, tier.finalArticleCount);

  console.log(`[NEWS] ${user.email} — selected top ${topArticles.length} articles (top score: ${topArticles[0]?.score || 0})`);
  return { articles: topArticles };
}

// ── STAGE 4 — DIGEST GENERATION ─────────────────────────────────────────────
async function generateDigest(user, news) {
  const apiGrokKey   = (process.env.GROK_API_KEY   || "").trim();
  const apiGeminiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiGrokKey && !apiGeminiKey) throw new Error("Neither GEMINI_API_KEY nor GROK_API_KEY is configured.");

  const profile = user.profile || {};
  const memory  = ensureMemory(user, profile);
  const today   = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const articleText = (news.articles && news.articles.length)
    ? news.articles.map((a, i) => `[${i + 1}] ${a.title}\nSource: ${a.source} | ${a.url}\n${a.snippet}`).join("\n\n")
    : "No articles available.";

  const memoryText  = formatMemoryForPrompt(memory);
  const profileText = [
    user.name          && `Name: ${user.name}`,
    profile.profession && `Role: ${profile.profession}`,
    profile.goals      && `Goals: ${profile.goals}`,
    profile.topics     && `Topics: ${profile.topics}`,
    profile.avoid      && `Avoid: ${profile.avoid}`,
    profile.summary    && `Summary: ${profile.summary.slice(0, 400)}`,
    profile.tone       && `Tone: ${profile.tone}`,
  ].filter(Boolean).join("\n");

  const systemInstruction = "You are Sharflow — a precise personal intelligence system.";

  const prompt = buildDigestPrompt({
    memoryText,
    profileText,
    newsContext: articleText,
    plan: profile.plan || "free",
    today
  });

  if (apiGeminiKey) {
    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey: apiGeminiKey });
    const maxAttempts = 3;
    const delays = [5000, 10000];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { systemInstruction, temperature: 0.25 },
        });
        return response.text || "";
      } catch (err) {
        const errMsg = String(err?.message || err || "");
        const status = err?.status || err?.statusCode || err?.code;
        const isUnavailable =
          status === 503 ||
          status === "UNAVAILABLE" ||
          /503|unavailable|high demand|overloaded/i.test(errMsg);

        if (attempt < maxAttempts && isUnavailable) {
          const delay = delays[attempt - 1];
          console.warn(`[GEMINI] Attempt ${attempt} failed (${errMsg}). Retrying in ${delay / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          throw err;
        }
      }
    }
  } else {
    const res = await withTimeout(fetch(GROK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiGrokKey}` },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1400,
        messages: [{ role: "system", content: systemInstruction }, { role: "user", content: prompt }],
      }),
    }), TIMEOUT_MS);
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || "Groq error"); }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }
}

// ── SEND EMAIL ─────────────────────────────────────────────────────────────────
async function sendDigestEmail(user, digestContent) {
  const apiKey    = (process.env.RESEND_API_KEY || "").trim();
  const fromEmail = (process.env.FROM_EMAIL || "Sharflow <onboarding@resend.dev>").trim();
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const profile = user.profile || {};
  let firstName = profile.firstName || profile.name || (user.name || "").split(" ")[0] || "there";
  if (!firstName || firstName.length < 2 || ["undefined", "sh", "sh."].includes(firstName.toLowerCase())) firstName = "there";

  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const bodyHtml = digestContent
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/━+/g, '<hr style="border:none;border-top:1px solid #E8E6E0;margin:18px 0;"/>')
    .replace(/^(🔥|📊|📺|💬)[^\n]+$/gm, m => `<p style="font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#16A34A;margin:20px 0 8px;">${m}</p>`)
    .replace(/^(①|②|③|④|⑤|⑥)/gm, m => `<span style="color:#1B4FD8;font-weight:700;">${m}</span>`)
    .replace(/^→ .+$/gm, m => `<span style="font-size:12px;color:#1B4FD8;">${m}</span>`)
    .replace(/^• .+$/gm, m => `<div style="display:flex;gap:8px;margin-bottom:6px;"><span style="color:#16A34A;">•</span><span>${m.slice(2)}</span></div>`)
    .replace(/\n/g, "<br/>");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Your Sharflow — ${date}</title></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1A1A18;">
<div style="padding:24px 16px;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border:1px solid #E8E6E0;border-radius:12px;overflow:hidden;">
    <div style="background:#1A1A18;padding:18px 28px;display:flex;justify-content:space-between;align-items:center;">
      <div style="font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.02em;">Sharflow.</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.5);">${date}</div>
    </div>
    <div style="padding:28px 32px;font-size:14px;line-height:1.8;color:#1A1A18;">
      <div style="font-size:18px;font-weight:700;margin-bottom:18px;">Good morning, ${firstName}.</div>
      ${bodyHtml}
    </div>
    <div style="padding:18px 28px;text-align:center;font-size:12px;color:#9E9E96;border-top:1px solid #E8E6E0;">
      <p>You're receiving this because you subscribed to Sharflow.</p>
      <p style="margin-top:6px;"><a href="https://sharflow.com/unsubscribe" style="color:#9E9E96;text-decoration:none;">Unsubscribe</a> · <a href="#" style="color:#9E9E96;text-decoration:none;">Update preferences</a></p>
    </div>
  </div>
</div></body></html>`;

  const res = await withTimeout(fetch(RESEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from: fromEmail, to: [user.email], subject: `Your Sharflow — ${date}`, html, headers: { "List-Unsubscribe": "<https://sharflow.com/unsubscribe>" } }),
  }), TIMEOUT_MS);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || "Resend error");
  return data.id;
}

async function logDelivery(db, user, status, error = null, userLocalDateStr = "", userTimeStr = "") {
  try {
    await db.collection("delivery_logs").insertOne({ userId: user._id, email: user.email, status, error, attemptedAt: new Date(), userLocalTime: userTimeStr, userLocalDate: userLocalDateStr, timezone: user.profile?.timezone || "UTC", digestTime: user.profile?.digestTime || "08:00" });
  } catch (e) { console.warn("Log insert failed:", e.message); }
}

// ── INDIVIDUAL USER PROCESSOR ────────────────────────────────────────────────
async function processUser(db, user, now) {
  let userTimeStr = "", userLocalDateStr = "", userTz = user.profile?.timezone || "UTC";
  try {
    if (!user.email || !user.profile?.summary) {
      console.log(`[SKIP] ${user.email || "No Email"} — missing email or profile summary`);
      return { status: "skipped", reason: "Missing email or profile summary" };
    }

    const profile = user.profile;

    try {
      userTimeStr      = now.toLocaleTimeString("en-US", { timeZone: userTz, hour12: false, hour: "2-digit", minute: "2-digit" });
      userLocalDateStr = now.toLocaleDateString("en-US",  { timeZone: userTz, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch (tzErr) {
      userTz = "UTC";
      userTimeStr      = now.toLocaleTimeString("en-US", { timeZone: "UTC", hour12: false, hour: "2-digit", minute: "2-digit" });
      userLocalDateStr = now.toLocaleDateString("en-US",  { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
    }

    // Atomic lock — prevent duplicate sends
    const lockResult = await db.collection("digests").updateOne(
      { email: user.email, date: userLocalDateStr },
      { $setOnInsert: { email: user.email, date: userLocalDateStr, locked: true, lockedAt: new Date() } },
      { upsert: true }
    );
    if (lockResult.upsertedCount === 0) {
      console.log(`[SKIP] ${user.email} — already sent for ${userLocalDateStr}`);
      return { status: "skipped", reason: "Already sent (locked)" };
    }

    const lastDigest = await db.collection("digests").findOne(
      { email: user.email, locked: { $ne: true } },
      { sort: { sentAt: -1 } }
    );

    const topics = profile.topics     || "technology, AI";
    const prof   = profile.profession || "";
    const avoid  = profile.avoid      || "";

    const news = await fetchNews(db, user, topics, prof, avoid, lastDigest);
    console.log(`[NEWS] ${user.email} — ${news.articles.length} articles parsed`);

    if (!news.articles || news.articles.length === 0) {
      await db.collection("digests").deleteOne({ email: user.email, date: userLocalDateStr, locked: true });
      await logDelivery(db, user, "skipped", "No candidate articles found", userLocalDateStr, userTimeStr);
      console.log(`[SKIP] ${user.email} — no candidate articles found`);
      return { status: "skipped", reason: "No candidate articles found" };
    }

    const digestContent = await generateDigest(user, news);
    if (!digestContent) {
      await db.collection("digests").deleteOne({ email: user.email, date: userLocalDateStr, locked: true });
      await logDelivery(db, user, "skipped", "Empty digest", userLocalDateStr, userTimeStr);
      console.log(`[SKIP] ${user.email} — digest content empty`);
      return { status: "skipped", reason: "Empty digest" };
    }

    const emailId = await sendDigestEmail(user, digestContent);
    console.log(`[SENT] ${user.email} — Resend ID: ${emailId}`);

    await db.collection("digests").updateOne(
      { email: user.email, date: userLocalDateStr },
      { $set: { userId: user._id, content: digestContent, sentAt: new Date(), locked: false } }
    );
    await db.collection("users").updateOne({ _id: user._id }, { $set: { lastDigestSentDate: userLocalDateStr, lastDigestSentAt: new Date() } });
    await logDelivery(db, user, "success", null, userLocalDateStr, userTimeStr);
    return { status: "sent" };

  } catch (userErr) {
    console.error(`[FAIL] ${user.email || "Unknown user"}:`, userErr.message);
    try { await db.collection("digests").deleteOne({ email: user.email, date: userLocalDateStr, locked: true }); } catch (_) {}
    try { await logDelivery(db, user, "failed", userErr.message, userLocalDateStr, userTimeStr); } catch (_) {}
    return { status: "failed", error: userErr.message };
  }
}

// ── SCRIPT MAIN ENTRYPOINT ───────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();
  const results   = { sent: 0, failed: 0, skipped: 0, errors: [] };
  const now       = new Date();

  console.log(`\n======================================================`);
  console.log(`[CRON] Standalone Digest Sender Started at ${now.toISOString()}`);
  console.log(`======================================================\n`);

  let db;
  try {
    db = await getDb();
  } catch (dbErr) {
    console.error("FATAL: Failed to connect to MongoDB. Check MONGODB_URI.", dbErr.message);
    process.exit(1);
  }

  try {
    const users = await db.collection("users").find({
      email: { $exists: true, $ne: "" },
      profile: { $exists: true, $ne: null }
    }).toArray();

    console.log(`[CRON] Fetched ${users.length} candidate users for digest`);

    const batchSize = 5;
    let hasFailures = false;

    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      console.log(`\n[BATCH] Processing batch ${Math.floor(i / batchSize) + 1} (${i + 1} to ${Math.min(i + batchSize, users.length)})`);
      
      const batchResults = await Promise.all(batch.map(async (user) => {
        try {
          const res = await processUser(db, user, now);
          return { email: user.email, ...res };
        } catch (err) {
          console.error(`[CRON] Unhandled error for ${user.email || "Unknown"}:`, err.message);
          return { email: user.email, status: "failed", error: err.message };
        }
      }));

      for (const res of batchResults) {
        if (res.status === "sent") {
          results.sent++;
        } else if (res.status === "skipped") {
          results.skipped++;
        } else if (res.status === "failed") {
          results.failed++;
          hasFailures = true;
          results.errors.push({ email: res.email, error: res.error });
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n======================================================`);
    console.log(`[CRON] Done in ${duration}s`);
    console.log(`[STATS] Sent: ${results.sent} | Skipped: ${results.skipped} | Failed: ${results.failed}`);
    if (results.errors.length > 0) {
      console.error(`[ERRORS] Summary of failures:`);
      results.errors.forEach(e => console.error(`  - ${e.email}: ${e.error}`));
    }
    console.log(`======================================================\n`);

    // Exit with code 1 if there were any failure statuses so that GitHub Actions marks the run as failed.
    if (hasFailures) {
      process.exit(1);
    } else {
      process.exit(0);
    }

  } catch (err) {
    console.error("FATAL: Unhandled exception in run loop:", err.message);
    process.exit(1);
  }
}

run();
