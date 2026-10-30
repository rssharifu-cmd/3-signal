/**
 * Sharflow — OAuth Authorization & Callback Endpoint
 *
 * Implements server-side OAuth flow for:
 * 1. Google Search Console & Google Analytics 4
 * 2. Bing Webmaster Tools
 *
 * ARCHITECTURAL SAFETY:
 * - Minimum required read-only scopes.
 * - Exact validated origin postMessage (no wildcard '*').
 * - Open redirect prevention on all callback return destinations.
 * - Target-specific Google authorization status (never falsely marks other services).
 * - Refresh tokens are encrypted with AES-256-GCM before database storage.
 * - Never returns tokens or client secrets to frontend or logs.
 */

const jwt = require("jsonwebtoken");
const { randomBytes } = require("crypto");
const { getDb } = require("./_lib/db");
const { cors, extractEmail, isTrustedOrigin, getValidatedOrigin, getSafeReturnUrl, PRODUCTION_ORIGIN } = require("./_lib/authMiddleware");
const { encryptToken, hasEncryptionKey } = require("./_lib/cryptoUtils");

const jwtSecret = (process.env.JWT_SECRET || "").trim();

// Google OAuth Constants
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const GOOGLE_GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GOOGLE_GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GOOGLE_BASE_SCOPES = ["openid", "email", "profile"];

// Bing Webmaster Constants (Official Read-Only Scope)
const BING_AUTH_URL = "https://www.bing.com/webmasters/oauth/authorize";
const BING_TOKEN_URL = "https://www.bing.com/webmasters/oauth/token";
const BING_SCOPE = "webmaster.manage";

/**
 * Parses HTTP Cookie header into key-value map.
 */
function parseCookies(req) {
  const list = {};
  const rc = req.headers?.cookie;
  if (rc) {
    rc.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      const key = parts[0] ? parts[0].trim() : "";
      if (key) {
        const val = parts.slice(1).join("=").trim();
        try {
          list[key] = decodeURIComponent(val);
        } catch {
          list[key] = val;
        }
      }
    });
  }
  return list;
}

// Cookie creation and clearing must use the same scope.
function stateCookie(req, token, maxAge) {
  const host = String(req.headers?.host || "").split(":")[0].toLowerCase();
  // New name avoids ambiguity with legacy host-only cookies during rollout.
  const flags = ["sharflow_oauth_attempt=" + encodeURIComponent(token), "Path=/", "Max-Age=" + maxAge, "SameSite=Lax", "HttpOnly"];
  // The production callback uses apex even when authorization starts on www.
  if (host === "sharflow.online" || host === "www.sharflow.online") flags.push("Domain=sharflow.online");
  if (req.headers?.["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production" || host === "sharflow.online" || host === "www.sharflow.online") flags.push("Secure");
  return flags.join("; ");
}

// Production callbacks use apex; non-production callbacks retain the trusted origin.
function resolveRedirectUri(req, clientOrigin) {
  const isProd = process.env.NODE_ENV === "production";
  const validatedOrigin = getValidatedOrigin(clientOrigin, req);

  // In non-production, allow validated local dev or preview container callback
  if (!isProd && (validatedOrigin.includes("localhost") || validatedOrigin.includes("127.0.0.1") || validatedOrigin.includes("run.app") || validatedOrigin.includes("vercel.app"))) {
    return `${validatedOrigin}/api/oauth-callback`;
  }

  const prodBase = PRODUCTION_ORIGIN || "https://sharflow.online";
  return `${prodBase}/api/oauth-callback`;
}

/**
 * Returns HTML to inform user and postMessage to opener window.
 * STRICT SECURITY:
 * - postMessage targetOrigin is strictly validated (never "*").
 * - safeReturn URL is strictly sanitized against open redirects.
 */
function renderCallbackHtml(options) {
  const { success, provider, error, targetOrigin, returnUrl } = options;
  const safeOrigin = getValidatedOrigin(targetOrigin);
  const safeReturn = getSafeReturnUrl(returnUrl, safeOrigin);
  const safeProvider = provider ? String(provider).replace(/[^a-zA-Z0-9_-]/g, "") : "";
  const safeError = error ? String(error).replace(/[<>&"]/g, "") : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${success ? "Connected · Sharflow" : "Connection Failed · Sharflow"}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 40px 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #FAF9F5;
      color: #1E1E1C;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 80vh;
    }
    .card {
      max-width: 440px;
      width: 100%;
      background: #FFFFFF;
      border: 1px solid #E8E6E0;
      border-radius: 14px;
      padding: 36px 28px;
      text-align: center;
      box-shadow: 0 8px 30px rgba(0,0,0,0.06);
    }
    .icon {
      font-size: 38px;
      margin-bottom: 14px;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 20px;
      font-weight: 700;
    }
    p {
      margin: 0 0 20px;
      font-size: 14px;
      color: #66645E;
      line-height: 1.5;
    }
    .btn {
      display: inline-block;
      padding: 10px 20px;
      background: #1E1E1C;
      color: #FFFFFF;
      text-decoration: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
    }
    .error-box {
      background: #FEF2F2;
      border: 1px solid #FCA5A5;
      color: #991B1B;
      padding: 12px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 20px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? "✅" : "⚠️"}</div>
    <h2>${success ? "Connection Successful" : "Connection Unsuccessful"}</h2>
    ${!success && safeError ? `<div class="error-box">${safeError}</div>` : ""}
    <p>${
      success
        ? "Your data source has been connected. Returning to your Sharflow dashboard…"
        : "Could not complete data source authorization. You may close this window and try again."
    }</p>
    <a href="${safeReturn}" class="btn">Return to Dashboard</a>
  </div>

  <script>
    (function() {
      try {
        if (window.opener && !window.opener.closed) {
          var targetOrigin = ${JSON.stringify(safeOrigin)};
          window.opener.postMessage({
            type: "${success ? "OAUTH_AUTH_SUCCESS" : "OAUTH_AUTH_ERROR"}",
            provider: "${safeProvider}",
            error: "${safeError}"
          }, targetOrigin);
          ${success ? 'setTimeout(function() { window.close(); }, 1000);' : ''}
        }
      } catch (e) {
        console.warn("Could not postMessage to opener:", e);
      }
    })();
  </script>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });

  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const action = req.query?.action || urlObj.searchParams.get("action");
  const isCallback = Boolean(req.query?.code || urlObj.searchParams.get("code") || req.query?.error || urlObj.searchParams.get("error") || action === "callback");

  // ── 1. GENERATE OAUTH AUTHORIZATION URL ──────────────────────────────────
  if (!isCallback && (action === "url" || req.method === "GET")) {
    const userEmail = extractEmail(req);
    if (!userEmail) {
      return res.status(401).json({ ok: false, error: "Unauthorized. Please sign in to connect data sources." });
    }

    const rawProvider = req.query?.provider || urlObj.searchParams.get("provider") || "google_search_console";
    let targetProvider = rawProvider;
    if (rawProvider === "google") targetProvider = "google_search_console";
    if (rawProvider === "bing") targetProvider = "bing_webmaster";

    if (!["google_search_console", "google_analytics", "bing_webmaster"].includes(targetProvider)) {
      return res.status(400).json({ error: "Unsupported provider." });
    }

    const clientOrigin = req.query?.origin || urlObj.searchParams.get("origin") || "";
    const clientReturnUrl = req.query?.returnUrl || urlObj.searchParams.get("returnUrl") || "";
    const validatedOrigin = getValidatedOrigin(clientOrigin, req);
    const redirectUri = resolveRedirectUri(req, clientOrigin);
    const safeReturnUrl = getSafeReturnUrl(clientReturnUrl || `${validatedOrigin}/#sources`, validatedOrigin);

    if (!jwtSecret) {
      return res.status(500).json({ ok: false, error: "JWT_SECRET is missing from server configuration." });
    }

    // Connect via existing stored Google token if it already has the required scope
    if (targetProvider === "google_search_console" || targetProvider === "google_analytics") {
      try {
        const db = await getDb();
        const datasourcesCol = db.collection("datasources");
        const requiredScopeKeyword = targetProvider === "google_search_console" ? "webmasters" : "analytics";

        // Check if there is an existing stored Google token for this user
        const existingGoogle = await datasourcesCol.findOne({
          userEmail,
          provider: { $in: ["google_search_console", "google_analytics", "google"] },
          encryptedRefreshToken: { $exists: true, $ne: "" },
        });

        if (existingGoogle && existingGoogle.encryptedRefreshToken) {
          const existingScopes = Array.isArray(existingGoogle.scopes) ? existingGoogle.scopes : [];
          const hasRequiredScope = existingScopes.some((s) => s.toLowerCase().includes(requiredScopeKeyword));

          if (hasRequiredScope) {
            // Already authorized with this scope! Connect this specific provider without prompting user again.
            const now = new Date();
            await datasourcesCol.updateOne(
              { userEmail, provider: targetProvider },
              {
                $set: {
                  userId: existingGoogle.userId || userEmail,
                  userEmail,
                  provider: targetProvider,
                  providerAccountId: existingGoogle.providerAccountId || "",
                  scopes: existingScopes,
                  status: "connected",
                  encryptedRefreshToken: existingGoogle.encryptedRefreshToken,
                  updatedAt: now,
                },
                $setOnInsert: {
                  createdAt: now,
                  selectedProperty: null,
                  lastSuccessfulSync: null,
                },
              },
              { upsert: true }
            );

            return res.status(200).json({
              ok: true,
              connectedDirectly: true,
              provider: targetProvider,
              message: `Connected ${targetProvider === "google_analytics" ? "Google Analytics" : "Google Search Console"} using your existing Google authorization.`,
            });
          }
        }
      } catch (checkErr) {
        console.warn("[OAuth] Error checking existing token:", checkErr.message);
      }
    }

    // Sign state parameter containing authenticated email and specific target provider
    const stateToken = jwt.sign(
      {
        email: userEmail,
        provider: targetProvider,
        redirectUri,
        clientOrigin: validatedOrigin,
        returnUrl: safeReturnUrl,
        purpose: "oauth_state",
        nonce: randomBytes(32).toString("hex"),
      },
      jwtSecret,
      { expiresIn: "20m" }
    );

    // Persist this exact one-use attempt before returning an authorization URL.
    const statePayload = jwt.verify(stateToken, jwtSecret, { algorithms: ["HS256"] });
    try {
      const db = await getDb();
      await db.collection("oauth_pending").insertOne({
        _id: statePayload.nonce, email: userEmail, provider: targetProvider,
        stateToken, expiresAt: new Date(statePayload.exp * 1000), createdAt: new Date(),
      });
    } catch (_) {
      return res.status(503).json({ error: "Could not start authorization. Please try again." });
    }
    res.setHeader("Set-Cookie", stateCookie(req, stateToken, 1200));

    if (targetProvider === "google_search_console" || targetProvider === "google_analytics") {
      const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
      if (!clientId) {
        return res.status(400).json({
          ok: false,
          error: "GOOGLE_CLIENT_ID is not configured. Please add GOOGLE_CLIENT_ID in your environment variables.",
        });
      }

      const targetScopes = targetProvider === "google_analytics"
        ? [GOOGLE_GA4_SCOPE, ...GOOGLE_BASE_SCOPES]
        : [GOOGLE_GSC_SCOPE, ...GOOGLE_BASE_SCOPES];

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: targetScopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state: stateToken,
      });

      const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;
      return res.status(200).json({ ok: true, url: authUrl, redirectUri });
    }

    if (targetProvider === "bing_webmaster") {
      const clientId = (process.env.BING_CLIENT_ID || "").trim();
      if (!clientId) {
        return res.status(400).json({
          ok: false,
          error: "BING_CLIENT_ID is not configured. Please add BING_CLIENT_ID in your environment variables.",
        });
      }

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: BING_SCOPE,
        state: stateToken,
      });

      const authUrl = `${BING_AUTH_URL}?${params.toString()}`;
      return res.status(200).json({ ok: true, url: authUrl, redirectUri });
    }

    return res.status(400).json({ ok: false, error: `Unsupported provider: ${targetProvider}` });
  }

  // ── 2. HANDLE OAUTH CALLBACK ─────────────────────────────────────────────
  if (isCallback) {
    const fallbackOrigin = getValidatedOrigin(null, req);
    const defaultReturnUrl = "/#sources";
    let statePayload;
    let callbackDb;
    function fail(status, error) {
      res.setHeader("Set-Cookie", stateCookie(req, "", 0));
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(status).send(renderCallbackHtml({
        success: false, error,
        targetOrigin: statePayload?.clientOrigin || fallbackOrigin,
        returnUrl: statePayload?.returnUrl || defaultReturnUrl,
      }));
    }
    function callbackValue(key) {
      const values = urlObj.searchParams.getAll(key);
      if (req.query && Object.prototype.hasOwnProperty.call(req.query, key)) values.push(req.query[key]);
      if (values.some((v) => typeof v !== "string" || !v || v.length > 8192) || new Set(values).size > 1) {
        throw new Error("Invalid callback parameters");
      }
      return values[0];
    }
    let code, returnedState, providerError;
    try {
      code = callbackValue("code");
      returnedState = callbackValue("state");
      providerError = callbackValue("error");
    } catch (_) {
      return fail(400, "Invalid authorization callback. Please start connection again.");
    }
    const cookieState = parseCookies(req).sharflow_oauth_attempt;
    if (!cookieState || (returnedState && returnedState !== cookieState)) {
      return fail(400, "Authorization does not match this browser. Please start connection again.");
    }
    try {
      const decoded = jwt.verify(cookieState, jwtSecret, { algorithms: ["HS256"] });
      if (decoded.purpose !== "oauth_state" ||
          !["google_search_console", "google_analytics", "bing_webmaster"].includes(decoded.provider) ||
          typeof decoded.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(decoded.email) ||
          typeof decoded.nonce !== "string" || !/^[a-f0-9]{64}$/.test(decoded.nonce) ||
          !Number.isInteger(decoded.exp) || !Number.isInteger(decoded.iat) ||
          decoded.exp - decoded.iat > 1200 || decoded.iat > Math.floor(Date.now() / 1000) + 30 ||
          typeof decoded.clientOrigin !== "string" || !isTrustedOrigin(decoded.clientOrigin) ||
          typeof decoded.redirectUri !== "string" || decoded.redirectUri !== resolveRedirectUri(req, decoded.clientOrigin) ||
          typeof decoded.returnUrl !== "string" ||
          (!returnedState && decoded.provider !== "bing_webmaster")) {
        throw new Error("Invalid OAuth state");
      }
      statePayload = decoded;
    } catch (_) {
      return fail(400, "Invalid or expired authorization session. Please start connection again.");
    }
    if (!code && !providerError) return fail(400, "Missing authorization code. Please start connection again.");
    try {
      callbackDb = await getDb();
      // Atomic deletion is the one-use claim; never select a user by pending count.
      const claimed = await callbackDb.collection("oauth_pending").findOneAndDelete({
        _id: statePayload.nonce, stateToken: cookieState,
        email: statePayload.email, provider: statePayload.provider,
        expiresAt: { $gt: new Date() },
      });
      if (!claimed) return fail(400, "Authorization was already used or replaced. Please start connection again.");
    } catch (_) {
      return fail(503, "Could not verify authorization. Please start connection again.");
    }
    res.setHeader("Set-Cookie", stateCookie(req, "", 0));
    if (providerError) return fail(400, "Provider authorization was cancelled or denied. Please start connection again.");

    const { email: userEmail, provider: requestedProvider, redirectUri, clientOrigin, returnUrl: storedReturnUrl } = statePayload;
    const validatedOrigin = getValidatedOrigin(clientOrigin, req);
    const returnUrl = getSafeReturnUrl(storedReturnUrl, validatedOrigin);

    if (!hasEncryptionKey()) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(500).send(
        renderCallbackHtml({
          success: false,
          error: "Server configuration error: OAUTH_TOKEN_ENCRYPTION_KEY is missing. Tokens cannot be securely encrypted.",
          targetOrigin: validatedOrigin,
          returnUrl,
        })
      );
    }

    try {
      const db = callbackDb;
      const usersCol = db.collection("users");
      const datasourcesCol = db.collection("datasources");

      const user = await usersCol.findOne({ email: userEmail });
      if (!user || user.active === false) return fail(403, "Account unavailable. Please sign in again.");
      const userId = user._id;

      // ── Handle Google Token Exchange ──────────────────────────────────
      if (requestedProvider === "google_search_console" || requestedProvider === "google_analytics") {
        const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
        const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();

        if (!clientId || !clientSecret) {
          throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured.");
        }

        const tokenParams = new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        });

        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
        });

        const tokenData = await tokenRes.json();
        if (!tokenRes.ok) {
          throw new Error(tokenData.error_description || tokenData.error || "Google token exchange failed.");
        }

        // Fetch Google account identity info (read-only email & profile)
        let googleAccountEmail = "";
        try {
          if (tokenData.access_token) {
            const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
              headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (userinfoRes.ok) {
              const uinfo = await userinfoRes.json();
              googleAccountEmail = uinfo.email || "";
            }
          }
        } catch (e) {
          console.warn("[OAuth] Could not fetch Google userinfo:", e.message);
        }

        // Encrypt refresh token
        let encryptedRefreshToken = "";
        if (tokenData.refresh_token) {
          encryptedRefreshToken = encryptToken(tokenData.refresh_token);
        } else {
          // If prompt was skipped or user already authorized, check existing stored token
          const existing = await datasourcesCol.findOne({
            userEmail,
            provider: { $in: ["google_search_console", "google_analytics", "google"] },
            encryptedRefreshToken: { $exists: true, $ne: "" },
          });
          if (existing && existing.encryptedRefreshToken) {
            encryptedRefreshToken = existing.encryptedRefreshToken;
          }
        }

        const grantedScopes = tokenData.scope ? tokenData.scope.split(" ") : [];
        const now = new Date();

        const targetProvider = requestedProvider;
        const otherProvider = targetProvider === "google_search_console" ? "google_analytics" : "google_search_console";

        // 1. Mark ONLY the explicitly requested provider as connected
        await datasourcesCol.updateOne(
          { userEmail, provider: targetProvider },
          {
            $set: {
              userId,
              userEmail,
              provider: targetProvider,
              providerAccountId: googleAccountEmail,
              scopes: grantedScopes,
              status: "connected",
              updatedAt: now,
              ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
            },
            $setOnInsert: {
              createdAt: now,
              selectedProperty: null,
              lastSuccessfulSync: null,
            },
          },
          { upsert: true }
        );

        // 2. Handle the other Google provider:
        // Do NOT mark other provider connected unless it was ALREADY connected before.
        const existingOther = await datasourcesCol.findOne({ userEmail, provider: otherProvider });
        if (existingOther && existingOther.status === "connected") {
          // Keep it connected and update its refresh credentials
          await datasourcesCol.updateOne(
            { userEmail, provider: otherProvider },
            {
              $set: {
                providerAccountId: googleAccountEmail,
                scopes: grantedScopes,
                updatedAt: now,
                ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
              },
            }
          );
        } else if (encryptedRefreshToken) {
          // Keep credentials available without marking the other provider as connected
          await datasourcesCol.updateOne(
            { userEmail, provider: otherProvider },
            {
              $set: {
                userId,
                userEmail,
                provider: otherProvider,
                providerAccountId: googleAccountEmail,
                scopes: grantedScopes,
                status: existingOther?.status || "not_connected",
                encryptedRefreshToken,
                updatedAt: now,
              },
              $setOnInsert: {
                createdAt: now,
                selectedProperty: null,
                lastSuccessfulSync: null,
              },
            },
            { upsert: true }
          );
        }

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(
          renderCallbackHtml({
            success: true,
            provider: targetProvider,
            targetOrigin: validatedOrigin,
            returnUrl,
          })
        );
      }

      // ── Handle Bing Webmaster Token Exchange ─────────────────────────
      if (requestedProvider === "bing_webmaster") {
        const clientId = (process.env.BING_CLIENT_ID || "").trim();
        const clientSecret = (process.env.BING_CLIENT_SECRET || "").trim();

        if (!clientId || !clientSecret) {
          throw new Error("BING_CLIENT_ID and BING_CLIENT_SECRET must be configured.");
        }

        const tokenParams = new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        });

        const tokenRes = await fetch(BING_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
        });

        const tokenData = await tokenRes.json();
        if (!tokenRes.ok) {
          throw new Error(tokenData.error_description || tokenData.error || "Bing token exchange failed.");
        }

        const encryptedRefreshToken = tokenData.refresh_token
          ? encryptToken(tokenData.refresh_token)
          : "";

        const now = new Date();
        await datasourcesCol.updateOne(
          { userEmail, provider: "bing_webmaster" },
          {
            $set: {
              userId,
              userEmail,
              provider: "bing_webmaster",
              scopes: [BING_SCOPE],
              status: "connected",
              updatedAt: now,
              ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
            },
            $setOnInsert: {
              createdAt: now,
              selectedProperty: null,
              lastSuccessfulSync: null,
            },
          },
          { upsert: true }
        );

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(
          renderCallbackHtml({
            success: true,
            provider: "bing_webmaster",
            targetOrigin: validatedOrigin,
            returnUrl,
          })
        );
      }

      throw new Error(`Unrecognized OAuth provider: ${requestedProvider}`);
    } catch (err) {
      console.error("[OAuth Callback Error]", err.message);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(500).send(
        renderCallbackHtml({
          success: false,
          error: err.message || "Failed to complete data source authorization.",
          targetOrigin: validatedOrigin,
          returnUrl,
        })
      );
    }
  }

  return res.status(404).json({ ok: false, error: "Not found" });
};
