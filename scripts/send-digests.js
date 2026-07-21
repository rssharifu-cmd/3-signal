/**
 * Signal — Standalone Digest Sender Script
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

// ── FETCH NEWS — direct live fetch ───────────────────────────────────────────
async function fetchNews(db, user, topics, profession, avoid, lastDigest) {
  console.log(`[NEWS] ${user.email} — running live fetch`);

  const tavilyKey  = (process.env.TAVILY_API_KEY  || "").trim();
  const youtubeKey = (process.env.YOUTUBE_API_KEY || "").trim();

  let startTimeWindow;
  if (lastDigest && lastDigest.sentAt) {
    startTimeWindow = new Date(lastDigest.sentAt);
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

  async function tavily() {
    if (!tavilyKey) return [];
    try {
      const res = await withTimeout(fetch(TAVILY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: `Latest news: ${topics || "technology AI business"}`,
          search_depth: "advanced",
          include_answer: false,
          include_raw_content: false,
          max_results: 10,
          exclude_domains: avoid ? avoid.split(",").map(s => s.trim()).filter(Boolean) : [],
          publishedAfter: publishedAfterStr,
        }),
      }), TIMEOUT_MS);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.results || []).map(r => ({ source: "tavily", title: r.title || "", url: r.url || "", snippet: (r.content || r.snippet || "").slice(0, 400) }));
    } catch (err) { return []; }
  }

  async function reddit() {
    const subredditMap = { "money": "Entrepreneur", "online": "Entrepreneur", "youtube": "NewTubers", "ai": "artificial", "startup": "startups", "finance": "finance", "tech": "technology", "crypto": "CryptoCurrency", "marketing": "marketing", "business": "business" };
    const topicsLower = (topics || "").toLowerCase();
    let subreddit = "Entrepreneur";
    for (const [key, sub] of Object.entries(subredditMap)) { if (topicsLower.includes(key)) { subreddit = sub; break; } }
    try {
      const res = await withTimeout(fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=10`, { headers: { "User-Agent": "Signal-NewsDigest/1.0" } }), TIMEOUT_MS);
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.data?.children || []).filter(p => !p.data?.stickied && !p.data?.over_18).slice(0, 5).map(p => ({ source: "reddit", title: p.data?.title || "", url: `https://reddit.com${p.data?.permalink || ""}`, snippet: `${p.data?.ups || 0} upvotes · r/${p.data?.subreddit}` }));
    } catch (err) { return []; }
  }

  async function rss() {
    const topicsLower = (topics || "").toLowerCase();
    const feedMap = [
      { keys: ["money", "online", "business", "entrepreneur"], url: "https://feeds.feedburner.com/entrepreneur/latest" },
      { keys: ["youtube", "creator"], url: "https://techcrunch.com/feed/" },
      { keys: ["ai", "ml"], url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
      { keys: ["startup"], url: "https://techcrunch.com/category/startups/feed/" },
      { keys: ["finance", "market"], url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
      { keys: ["crypto"], url: "https://cointelegraph.com/rss" },
      { keys: ["tech", "engineering"], url: "https://feeds.feedburner.com/TechCrunch" },
    ];
    let feedUrl = "https://techcrunch.com/feed/";
    for (const { keys, url } of feedMap) { if (keys.some(k => topicsLower.includes(k))) { feedUrl = url; break; } }
    try {
      const res = await withTimeout(fetch(feedUrl, { headers: { "User-Agent": "Signal-NewsDigest/1.0" } }), TIMEOUT_MS);
      if (!res.ok) return [];
      const xml = await res.text();
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && items.length < 8) {
        const block = match[1];
        const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block) || [])[1] || "";
        const link  = (/<link>(.*?)<\/link>/.exec(block)  || [])[1] || "";
        const desc  = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(block) || /<description>(.*?)<\/description>/.exec(block) || [])[1] || "";
        if (title && link) items.push({ source: "rss", title: title.replace(/&amp;/g, "&").trim(), url: link.trim(), snippet: desc.replace(/<[^>]+>/g, "").slice(0, 300).trim() });
      }
      return items;
    } catch (err) { return []; }
  }

  async function youtube() {
    if (!youtubeKey) return [];
    const query = `${(topics || "technology").split(",")[0].trim()} ${profession ? profession.split(" ")[0] : ""} ${new Date().getFullYear()}`.trim();
    try {
      const params = new URLSearchParams({ part: "snippet", q: query, type: "video", order: "relevance", maxResults: "5", videoDuration: "medium", relevanceLanguage: "en", publishedAfter: publishedAfterStr, key: youtubeKey });
      const res = await withTimeout(fetch(`${YOUTUBE_URL}?${params}`), TIMEOUT_MS);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.items || []).filter(i => i.snippet?.title?.length > 10).map(item => ({ source: "youtube", title: item.snippet.title, url: `https://youtube.com/watch?v=${item.id.videoId}`, snippet: `${item.snippet.channelTitle} · ${item.snippet.description || ""}` }));
    } catch (err) { return []; }
  }

  const [tavilyArticles, rssItems, redditPosts, youtubeVideos] = await Promise.all([tavily(), rss(), reddit(), youtube()]);
  let pool = [...(tavilyArticles || []), ...(rssItems || []), ...(redditPosts || []), ...(youtubeVideos || [])];

  pool = pool.filter(art => {
    if (!art.url) return true;
    const urlLower = art.url.trim().toLowerCase();
    for (const sentUrl of sentUrls) { if (urlLower.includes(sentUrl) || sentUrl.includes(urlLower)) return false; }
    return true;
  });

  const topicKeywords = (topics || "").toLowerCase().split(/[\s,]+/).map(k => k.trim()).filter(k => k.length > 2);
  const profKeywords  = (profession || "").toLowerCase().split(/[\s,]+/).map(k => k.trim()).filter(k => k.length > 2);

  const ranked = pool.map(art => {
    let score = 0;
    const tl = (art.title || "").toLowerCase(), sl = (art.snippet || "").toLowerCase();
    topicKeywords.forEach(kw => { if (tl.includes(kw)) score += 15; if (sl.includes(kw)) score += 5; });
    profKeywords.forEach(kw  => { if (tl.includes(kw)) score += 10; if (sl.includes(kw)) score += 3; });
    if (art.source === "tavily")  score += 3;
    if (art.source === "youtube") score += 2;
    if (art.source === "reddit")  score += 1;
    return { ...art, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return { articles: ranked.slice(0, 6) };
}

// ── DIGEST GENERATION ─────────────────────────────────────────────────────────
async function generateDigest(user, news) {
  const apiGrokKey   = (process.env.GROK_API_KEY   || "").trim();
  const apiGeminiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiGrokKey && !apiGeminiKey) throw new Error("Neither GEMINI_API_KEY nor GROK_API_KEY is configured.");

  const profile = user.profile || {};
  const memory  = ensureMemory(user, profile);
  const today   = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const articleText = news.articles.length
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

  const systemInstruction = `You are Signal — a ruthlessly precise personal intelligence system.

MANDATORY RULES — violating any is a critical failure:
1. EXACTLY 2 sentences per story. Not 1. Not 3. Count them. Stop at 2.
2. Sentence 1: what happened — sharp, specific, no fluff.
3. Sentence 2: what changes next, who wins, or what opportunity opens.
4. NEVER use: "WHAT:", "WHY YOU:", "ACTION:", "WHY IT MATTERS:", "IMPLICATION:"
5. NEVER use: "may have implications", "could impact", "important to understand", "as a professional in", "consider exploring", "monitor the situation", "significant development", "it is critical to"
6. 📊 THIS WEEK = pure trend observations only. No advice. No actions. No recommendations.
7. Never say "as a YouTuber" or "as a [profession]" — just deliver the insight.
8. Write like a sharp analyst, not a corporate AI.`;

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
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { systemInstruction, temperature: 0.25 },
    });
    return response.text || "";
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
  const fromEmail = (process.env.FROM_EMAIL || "Signal <onboarding@resend.dev>").trim();
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
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Your Signal — ${date}</title></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1A1A18;">
<div style="padding:24px 16px;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border:1px solid #E8E6E0;border-radius:12px;overflow:hidden;">
    <div style="background:#1A1A18;padding:18px 28px;display:flex;justify-content:space-between;align-items:center;">
      <div style="font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.02em;">Signal.</div>
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
    body: JSON.stringify({ from: fromEmail, to: [user.email], subject: `Your Signal — ${date}`, html, headers: { "List-Unsubscribe": "<https://sharflow.com/unsubscribe>" } }),
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
