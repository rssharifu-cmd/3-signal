/**
 * Vercel Node.js Serverless — /api/user
 *
 * All routes require Authorization: Bearer <token>
 *
 * POST { profile, plan, lockedUntil } — save profile + memory
 * POST { action: "feedback", topic, sentiment, storyTitle } — update memory
 *
 * GET — returns authenticated user + profile + memory
 */

const jwt = require("jsonwebtoken");
const { getDb } = require("./db");
const {
  buildMemoryFromOnboarding,
  applyFeedback,
  applyClick,
  ensureMemory,
} = require("./memory");

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

function extractEmail(req) {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (!secret) return null;
  const header = req.headers?.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  try {
    const decoded = jwt.verify(token, secret);
    return decoded.email || null;
  } catch {
    return null;
  }
}

function safeUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const email = extractEmail(req);
  if (!email) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }

  try {
    const db = await getDb();
    const users = db.collection("users");

    if (req.method === "GET") {
      let user = await users.findOne({ email });
      if (!user) {
        const now = new Date();
        user = {
          email,
          name: email.split("@")[0] || "User",
          passwordHash: "",
          plan: "starter",
          active: true,
          profile: null,
          createdAt: now,
          updatedAt: now,
        };
        await users.insertOne(user);
      }
      return res.status(200).json({ ok: true, user: safeUser(user) });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const now = new Date();
      const action = (body.action || "save").trim();

      let user = await users.findOne({ email });
      if (!user) {
        const now = new Date();
        user = {
          email,
          name: email.split("@")[0] || "User",
          passwordHash: "",
          plan: "starter",
          active: true,
          profile: null,
          createdAt: now,
          updatedAt: now,
        };
        await users.insertOne(user);
      }

      // ── FEEDBACK — update memory from dashboard 👍/👎 ─────────────────────
      if (action === "feedback") {
        if (!user) return res.status(404).json({ error: "User not found" });

        const sentiment = (body.sentiment || "").trim();
        if (!["like", "dislike"].includes(sentiment)) {
          return res.status(400).json({ error: "sentiment must be 'like' or 'dislike'" });
        }

        const currentMemory = ensureMemory(user, user.profile);
        const updatedMemory = applyFeedback(currentMemory, {
          topic: body.topic,
          sentiment,
          storyTitle: body.storyTitle,
        });

        await users.updateOne(
          { email },
          { $set: { memory: updatedMemory, updatedAt: now } }
        );

        return res.status(200).json({ ok: true, memory: updatedMemory });
      }

      // ── CLICK / ENGAGEMENT — update memory from click activity ─────────────────────
      if (action === "click") {
        if (!user) return res.status(404).json({ error: "User not found" });

        const currentMemory = ensureMemory(user, user.profile);
        const updatedMemory = applyClick(currentMemory, {
          topic: body.topic,
          storyTitle: body.storyTitle,
          url: body.url,
        });

        await users.updateOne(
          { email },
          { $set: { memory: updatedMemory, updatedAt: now } }
        );

        return res.status(200).json({ ok: true, memory: updatedMemory });
      }

      // ── SAVE profile + memory ─────────────────────────────────────────────
      const update = { $set: { updatedAt: now } };

      if (body.name && typeof body.name === "string" && body.name.trim()) {
        update.$set.name = body.name.trim();
      }
      if (body.plan) update.$set.plan = body.plan;

      if (body.profile) {
        const existingProfile = (user && user.profile) ? user.profile : {};
        const isWatchdog = body.profile.profileMode === "website-watchdog-onboarding" || Boolean(body.profile.websiteUrl);

        const profileMode = body.profile.profileMode || (isWatchdog ? "website-watchdog-onboarding" : (existingProfile.profileMode || "standard"));

        // Watchdog fields
        const websiteUrl = (body.profile.websiteUrl !== undefined && body.profile.websiteUrl !== "")
          ? body.profile.websiteUrl
          : (existingProfile.websiteUrl || "");

        const websiteType = (body.profile.websiteType !== undefined && body.profile.websiteType !== "")
          ? body.profile.websiteType
          : (existingProfile.websiteType || "");

        const websitePurpose = (body.profile.websitePurpose !== undefined && body.profile.websitePurpose !== "")
          ? body.profile.websitePurpose
          : (existingProfile.websitePurpose || "");

        const monitoringPriorities = Array.isArray(body.profile.monitoringPriorities) && body.profile.monitoringPriorities.length > 0
          ? body.profile.monitoringPriorities
          : (Array.isArray(existingProfile.monitoringPriorities) ? existingProfile.monitoringPriorities : []);

        const importantPages = Array.isArray(body.profile.importantPages)
          ? body.profile.importantPages
          : (Array.isArray(existingProfile.importantPages) ? existingProfile.importantPages : []);

        const summary = body.profile.summary || existingProfile.summary || "";

        // Legacy fields to strictly preserve:
        // profession, goals, topics, avoid, customSources, language, country, newsScope, digestLength, tone, digestTime, timezone, lockedUntil
        const profession = isWatchdog
          ? (existingProfile.profession || body.profile.profession || (websiteType ? `${websiteType} Owner` : "Website Owner"))
          : (body.profile.profession !== undefined ? body.profile.profession : (existingProfile.profession || ""));

        const goals = isWatchdog
          ? (existingProfile.goals || body.profile.goals || websitePurpose || "Monitor website performance")
          : (body.profile.goals !== undefined ? body.profile.goals : (existingProfile.goals || ""));

        const topics = isWatchdog
          ? (existingProfile.topics || body.profile.topics || (monitoringPriorities.length > 0 ? monitoringPriorities.join(", ") : "Website performance, SEO, search traffic"))
          : (body.profile.topics !== undefined ? body.profile.topics : (existingProfile.topics || ""));

        const avoid = isWatchdog
          ? (existingProfile.avoid !== undefined ? existingProfile.avoid : (body.profile.avoid !== undefined ? body.profile.avoid : "Broken tracking, vanity metrics without impact"))
          : (body.profile.avoid !== undefined ? body.profile.avoid : (existingProfile.avoid || ""));

        const customSources = isWatchdog
          ? (existingProfile.customSources || body.profile.customSources || websiteUrl || "")
          : (body.profile.customSources !== undefined ? body.profile.customSources : (existingProfile.customSources || ""));

        const language = isWatchdog
          ? (existingProfile.language || body.profile.language || "English")
          : (body.profile.language || existingProfile.language || "English");

        const country = isWatchdog
          ? (existingProfile.country !== undefined ? existingProfile.country : (body.profile.country || "United States"))
          : (body.profile.country !== undefined ? body.profile.country : (existingProfile.country || "United States"));

        const newsScope = isWatchdog
          ? (existingProfile.newsScope || body.profile.newsScope || "Website Performance")
          : (body.profile.newsScope || existingProfile.newsScope || "Mixed");

        const digestLength = isWatchdog
          ? (existingProfile.digestLength || body.profile.digestLength || "Standard")
          : (body.profile.digestLength || existingProfile.digestLength || "Standard");

        const tone = isWatchdog
          ? (existingProfile.tone || body.profile.tone || "concise")
          : (body.profile.tone || existingProfile.tone || "balanced");

        const digestTime = isWatchdog
          ? (existingProfile.digestTime || body.profile.digestTime || "08:00")
          : (body.profile.digestTime || existingProfile.digestTime || "08:00");

        const timezone = isWatchdog
          ? (existingProfile.timezone || body.profile.timezone || "UTC")
          : (body.profile.timezone || existingProfile.timezone || "UTC");

        const lockedUntil = body.lockedUntil
          ? new Date(body.lockedUntil)
          : (body.profile.lockedUntil
              ? new Date(body.profile.lockedUntil)
              : (existingProfile.lockedUntil ? new Date(existingProfile.lockedUntil) : null));

        const profile = {
          profileMode,
          websiteUrl,
          websiteType,
          websitePurpose,
          monitoringPriorities,
          importantPages,
          summary,
          profession,
          goals,
          topics,
          avoid,
          customSources,
          language,
          country,
          newsScope,
          digestLength,
          tone,
          digestTime,
          timezone,
          lockedUntil,
          savedAt: now,
        };
        update.$set.profile = profile;

        const memory = buildMemoryFromOnboarding({
          profession: profile.profession,
          goals: profile.goals,
          topics: profile.topics,
          avoid: profile.avoid,
          customSources: profile.customSources,
          summary: profile.summary,
          language: profile.language,
          country: profile.country,
          newsScope: profile.newsScope,
          digestLength: profile.digestLength,
        });
        update.$set.memory = memory;
      }

      await users.updateOne({ email }, update);

      return res.status(200).json({ ok: true, email });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    console.error("user route error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

module.exports = handler;
