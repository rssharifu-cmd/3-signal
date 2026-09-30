/**
 * Vercel Node.js Serverless — /api/auth
 *
 * GET ?action=config
 *   → returns public { ok: true, googleClientId }
 *
 * GET (Authorization: Bearer <token>)
 *   → verify JWT → return user
 *
 * POST { action: "google", credential }
 *   → verify Google ID token server-side → find-or-create/link user by email → return JWT
 *
 * POST { action: "signup", email, password, name }
 *   → hash password → save user (or set password on passwordless Google account) → return JWT
 *
 * POST { action: "login", email, password }
 *   → verify password → return JWT
 *
 * Required env vars:
 *   MONGODB_URI       — MongoDB Atlas connection string
 *   JWT_SECRET        — any long random string (e.g. openssl rand -hex 32)
 *   GOOGLE_CLIENT_ID  — Google OAuth 2.0 Web Client ID (for Sign in with Google)
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { getDb } = require("./_lib/db");

const SALT_ROUNDS = 10;
const JWT_EXPIRES = "7d";

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

function signToken(payload, secret) {
  return jwt.sign(payload, secret, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token, secret) {
  return jwt.verify(token, secret);
}

function extractToken(req) {
  const header = req.headers?.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

// Strip sensitive fields before returning user to client
function safeUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const urlObj = new URL(req.url || "/api/auth", `http://${req.headers?.host || "localhost"}`);
  const queryAction = req.query?.action || urlObj.searchParams.get("action") || "";

  // ── GET /api/auth?action=config — public Google Client ID for GIS button ──
  if (req.method === "GET" && queryAction === "config") {
    const googleClientId = (process.env.GOOGLE_CLIENT_ID || "").trim() || null;
    return res.status(200).json({ ok: true, googleClientId });
  }

  const jwtSecret = (process.env.JWT_SECRET || "").trim();
  if (!jwtSecret) {
    return res.status(500).json({ error: "JWT_SECRET env var not set. Add it in Vercel project settings." });
  }

  // ── GET /api/auth — verify token + return current user ───────────────────
  if (req.method === "GET") {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: "No token provided" });

    try {
      const decoded = verifyToken(token, jwtSecret);
      const db = await getDb();
      let user = await db.collection("users").findOne({ email: decoded.email });
      if (!user) {
        const now = new Date();
        user = {
          email: decoded.email,
          name: decoded.name || decoded.email.split("@")[0] || "User",
          passwordHash: "",
          plan: "starter",
          active: true,
          profile: null,
          createdAt: now,
          updatedAt: now,
        };
        await db.collection("users").insertOne(user);
      }
      return res.status(200).json({ ok: true, user: safeUser(user) });
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = parseBody(req);
    const action = (body.action || "").trim();

    const db = await getDb();
    const users = db.collection("users");

    // ── GOOGLE SIGN-IN (GIS ID TOKEN VERIFICATION) ─────────────────────────
    if (action === "google") {
      const credential = (body.credential || "").trim();
      if (!credential) {
        return res.status(400).json({ error: "Missing Google credential token." });
      }

      const googleClientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
      if (!googleClientId) {
        return res.status(500).json({ error: "GOOGLE_CLIENT_ID is not configured on the server." });
      }

      let payload;
      try {
        const googleClient = new OAuth2Client(googleClientId);
        const ticket = await googleClient.verifyIdToken({
          idToken: credential,
          audience: googleClientId,
        });
        payload = ticket.getPayload();
      } catch (verifyErr) {
        console.error("[Auth] Google ID token verification failed:", verifyErr.message);
        return res.status(401).json({ error: "Invalid or expired Google sign-in token." });
      }

      if (!payload || !payload.email || payload.email_verified !== true) {
        return res.status(401).json({ error: "Google account email is not verified." });
      }

      const email = payload.email.trim().toLowerCase();
      const googleName = (payload.name || email.split("@")[0] || "User").trim();
      const googleSub = payload.sub || "";
      const now = new Date();

      let user = await users.findOne({ email });

      if (user) {
        // Link Google sign-in to the existing user document without overwriting profile/passwordHash
        const updatedFields = {
          googleSub,
          authProvider: user.passwordHash ? "both" : "google",
          lastLoginAt: now,
          updatedAt: now,
        };
        if (!user.name && googleName) {
          updatedFields.name = googleName;
        }
        await users.updateOne({ email }, { $set: updatedFields });
        user = { ...user, ...updatedFields };
      } else {
        // Create new user document
        user = {
          email,
          name: googleName,
          passwordHash: "",
          googleSub,
          authProvider: "google",
          plan: "starter",
          active: true,
          profile: null,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
        };
        await users.insertOne(user);
      }

      const token = signToken({ email, name: user.name }, jwtSecret);
      return res.status(200).json({
        ok: true,
        token,
        user: safeUser(user),
      });
    }

    // ── EMAIL / PASSWORD VALIDATION (for signup & login) ────────────────────
    const email = (body.email || "").trim().toLowerCase();
    const password = (body.password || "").trim();

    if (!email) return res.status(400).json({ error: "email is required" });
    if (!password) return res.status(400).json({ error: "password is required" });
    if (password.length < 6) return res.status(400).json({ error: "password must be at least 6 characters" });

    // ── SIGNUP ──────────────────────────────────────────────────────────────
    if (action === "signup") {
      const name = (body.name || "").trim();

      // Check if email already exists
      const existing = await users.findOne({ email });
      if (existing) {
        // If this is a Google-created or legacy passwordless account, allow setting a password on the same document
        if (!existing.passwordHash) {
          const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
          const now = new Date();
          const updatedName = existing.name || name || email.split("@")[0] || "User";
          const updatedFields = {
            passwordHash,
            name: updatedName,
            authProvider: existing.googleSub ? "both" : "password",
            lastLoginAt: now,
            updatedAt: now,
          };
          await users.updateOne({ email }, { $set: updatedFields });
          const updatedUser = { ...existing, ...updatedFields };
          const token = signToken({ email, name: updatedName }, jwtSecret);
          return res.status(200).json({
            ok: true,
            token,
            user: safeUser(updatedUser),
          });
        }
        return res.status(409).json({ error: "An account with this email already exists. Please sign in." });
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      const now = new Date();

      const newUser = {
        email,
        name,
        passwordHash,
        plan: "starter",
        active: true,         // default active status for 3-day trial
        profile: null,
        createdAt: now,
        updatedAt: now,
      };

      await users.insertOne(newUser);

      const token = signToken({ email, name }, jwtSecret);

      return res.status(201).json({
        ok: true,
        token,
        user: safeUser(newUser),
      });
    }

    // ── LOGIN ────────────────────────────────────────────────────────────────
    if (action === "login") {
      const user = await users.findOne({ email });

      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Google-only or legacy passwordless users
      if (!user.passwordHash) {
        return res.status(401).json({
          error: user.googleSub
            ? "This account uses Google Sign-In. Please click 'Sign in with Google' above, or use the 'Create account' tab to set a password."
            : "No password is set for this account yet. Please click 'Sign in with Google' above, or use the 'Create account' tab to set a password.",
        });
      }

      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Update last login
      await users.updateOne({ email }, { $set: { lastLoginAt: new Date() } });

      const token = signToken({ email, name: user.name }, jwtSecret);

      return res.status(200).json({
        ok: true,
        token,
        user: safeUser(user),
      });
    }

    return res.status(400).json({ error: "Unknown action. Use 'signup', 'login', or 'google'." });

  } catch (err) {
    console.error("auth route error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

module.exports = handler;
