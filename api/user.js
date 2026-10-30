/**
 * Vercel Node.js Serverless — /api/user
 *
 * All routes require Authorization: Bearer <token>
 *
 * POST { profile, settings, name } — save website watchdog profile & settings (plan is read-only)
 * GET — returns authenticated user + profile + settings
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { getDb } = require("./_lib/db");
const { extractEmail } = require("./_lib/authMiddleware");
const { getEntitlements, ensureTrial, TRIAL_DAYS } = require("./_lib/plans");

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

function safeUser(user) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  const entitlements = getEntitlements(user);
  return { ...rest, entitlements };
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

    const urlObj = new URL(req.url || "/api/user", "http://localhost");
    const queryAction = req.query?.action || urlObj.searchParams.get("action");

    const now = new Date();

    if (req.method === "GET") {
      let user = await users.findOne({ email });
      if (!user) {
        const trialStartedAt = now;
        const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
        user = {
          email,
          name: email.split("@")[0] || "User",
          passwordHash: "",
          plan: "starter",
          trialStartedAt,
          trialEndsAt,
          active: true,
          profile: null,
          settings: {
            notifications: true,
            digestTime: "08:00",
            timezone: "UTC",
            digestFrequency: "daily",
            alertThreshold: "all",
          },
          createdAt: now,
          updatedAt: now,
        };
        await users.insertOne(user);
      } else if (!user.trialEndsAt) {
        user = await ensureTrial(db, user, now);
      }

      if (queryAction === "checkout_token") {
        const secret = (process.env.JWT_SECRET || "").trim();
        if (!secret) {
          return res.status(500).json({ error: "Server misconfiguration: JWT_SECRET missing." });
        }
        const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        const checkoutToken = jwt.sign(
          {
            userId: user._id.toString(),
            email: user.email,
            purpose: "paddle_checkout_link",
            nonce: crypto.randomBytes(16).toString("hex"),
          },
          secret,
          { expiresIn: "2h" }
        );
        const checkoutTokenDoc = {
          token: checkoutToken,
          userId: user._id.toString(),
          email: user.email,
          createdAt: now,
          expiresAt,
          consumed: false,
          consumedAt: null,
          boundSubscriptionId: null,
        };
        await users.updateOne({ email }, { $set: { pendingPaddleCheckoutToken: checkoutTokenDoc, updatedAt: now } });
        return res.status(200).json({ ok: true, checkoutToken });
      }

      const entitlements = getEntitlements(user);
      return res.status(200).json({ ok: true, user: safeUser(user), entitlements });
    }

    if (req.method === "POST") {
      const body = parseBody(req);

      let user = await users.findOne({ email });
      if (!user) {
        user = {
          email,
          name: email.split("@")[0] || "User",
          passwordHash: "",
          plan: "starter",
          active: true,
          profile: null,
          settings: {
            notifications: true,
            digestTime: "08:00",
            timezone: "UTC",
            digestFrequency: "daily",
            alertThreshold: "all",
          },
          createdAt: now,
          updatedAt: now,
        };
        await users.insertOne(user);
      }

      if (body.action === "checkout_token") {
        const secret = (process.env.JWT_SECRET || "").trim();
        if (!secret) {
          return res.status(500).json({ error: "Server misconfiguration: JWT_SECRET missing." });
        }
        const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        const checkoutToken = jwt.sign(
          {
            userId: user._id.toString(),
            email: user.email,
            purpose: "paddle_checkout_link",
            nonce: crypto.randomBytes(16).toString("hex"),
          },
          secret,
          { expiresIn: "2h" }
        );
        const checkoutTokenDoc = {
          token: checkoutToken,
          userId: user._id.toString(),
          email: user.email,
          createdAt: now,
          expiresAt,
          consumed: false,
          consumedAt: null,
          boundSubscriptionId: null,
        };
        await users.updateOne({ email }, { $set: { pendingPaddleCheckoutToken: checkoutTokenDoc, updatedAt: now } });
        return res.status(200).json({ ok: true, checkoutToken });
      }

      const update = { $set: { updatedAt: now } };

      if (body.name && typeof body.name === "string" && body.name.trim()) {
        update.$set.name = body.name.trim();
      }
      // SECURITY: Disallow self-assigned plans. Plan changes can only be granted
      // via verified Paddle server-side webhook events or administrative action.
      if (body.plan !== undefined && body.plan !== user.plan) {
        console.warn(`[Security Alert] User ${email} attempted unauthorized plan modification to '${body.plan}'. Ignored.`);
      }

      // ── SAVE Watchdog Profile ───────────────────────────────────────────────
      if (body.profile && typeof body.profile === "object") {
        const existingProfile = (user && user.profile) ? user.profile : {};

        const websiteUrl = (body.profile.websiteUrl !== undefined && body.profile.websiteUrl !== "")
          ? body.profile.websiteUrl.trim()
          : (existingProfile.websiteUrl || "");

        const websiteType = (body.profile.websiteType !== undefined && body.profile.websiteType !== "")
          ? body.profile.websiteType.trim()
          : (existingProfile.websiteType || "");

        const websitePurpose = (body.profile.websitePurpose !== undefined && body.profile.websitePurpose !== "")
          ? body.profile.websitePurpose.trim()
          : (existingProfile.websitePurpose || "");

        const { normalizeMonitoringPreferences } = require("./_lib/preferences");
        const rawPriorities = Array.isArray(body.profile.monitoringPriorities)
          ? body.profile.monitoringPriorities
          : (Array.isArray(existingProfile.monitoringPriorities) ? existingProfile.monitoringPriorities : []);
        const monitoringPriorities = normalizeMonitoringPreferences(rawPriorities, websiteType);

        const importantPages = Array.isArray(body.profile.importantPages)
          ? body.profile.importantPages
          : (Array.isArray(existingProfile.importantPages) ? existingProfile.importantPages : []);

        const competitorUrls = Array.isArray(body.profile.competitorUrls)
          ? body.profile.competitorUrls
          : (Array.isArray(existingProfile.competitorUrls) ? existingProfile.competitorUrls : []);

        const summary = body.profile.summary || existingProfile.summary || "";

        const profile = {
          profileMode: "website-watchdog-onboarding",
          websiteUrl,
          websiteType,
          websitePurpose,
          monitoringPriorities,
          importantPages,
          competitorUrls,
          summary,
          savedAt: now,
        };
        update.$set.profile = profile;
      }

      // ── SAVE Watchdog Settings ──────────────────────────────────────────────
      if (body.settings && typeof body.settings === "object") {
        const existingSettings = user.settings || {};
        const settings = {
          notifications: typeof body.settings.notifications === "boolean"
            ? body.settings.notifications
            : (existingSettings.notifications !== undefined ? existingSettings.notifications : true),
          digestTime: (body.settings.digestTime || existingSettings.digestTime || "08:00").trim(),
          timezone: (body.settings.timezone || existingSettings.timezone || "UTC").trim(),
          digestFrequency: (body.settings.digestFrequency || existingSettings.digestFrequency || "daily").trim(),
          alertThreshold: (body.settings.alertThreshold || existingSettings.alertThreshold || "all").trim(),
          updatedAt: now,
        };
        update.$set.settings = settings;
      }

      await users.updateOne({ email }, update);

      const updatedUser = await users.findOne({ email });
      const entitlements = getEntitlements(updatedUser);
      return res.status(200).json({ ok: true, user: safeUser(updatedUser), entitlements });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    console.error("user route error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

module.exports = handler;
