/**
 * Sharflow — OAuth Authorization & Callback Endpoint
 *
 * Implements server-side OAuth flow for:
 * 1. Google Search Console & Google Analytics 4
 * 2. Bing Webmaster Tools
 *
 * ARCHITECTURAL SAFETY:
 * - Minimum required read-only scopes.
 * - Refresh tokens are encrypted with AES-256-GCM before database storage.
 * - Never returns tokens or client secrets to frontend or logs.
 */

const jwt = require("jsonwebtoken");
const { getDb } = require("./db");
const { cors, extractEmail } = require("./authMiddleware");
const { encryptToken, hasEncryptionKey } = require("./cryptoUtils");

const jwtSecret = (process.env.JWT_SECRET || "").trim();

// Google OAuth Constants
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
  "openid",
  "email",
  "profile",
];

// Bing Webmaster Constants
const BING_AUTH_URL = "https://www.bing.com/webmasters/oauth/authorize";
const BING_TOKEN_URL = "https://www.bing.com/webmasters/oauth/token";
const BING_SCOPE = "https://webmaster.bing.com/api/webmaster.manage";

/**
 * Derives the exact OAuth callback URL based on request context.
 * Prioritizes production domain https://sharflow.online, but supports dev/preview origin if specified.
 */
function resolveRedirectUri(req, clientOrigin) {
  const isProd = process.env.NODE_ENV === "production";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  
  if (clientOrigin && (clientOrigin.includes("run.app") || clientOrigin.includes("localhost"))) {
    return `${clientOrigin.replace(/\/+$/, "")}/api/oauth-callback`;
  }
  if (host.includes("sharflow.online") || isProd) {
    return "https://sharflow.online/api/oauth-callback";
  }
  if (host) {
    const proto = req.headers["x-forwarded-proto"] || "http";
    return `${proto}://${host}/api/oauth-callback`;
  }
  return "https://sharflow.online/api/oauth-callback";
}

/**
 * Returns HTML to inform user and postMessage to opener window.
 */
function renderCallbackHtml(options) {
  const { success, provider, error, returnUrl } = options;
  const safeReturn = returnUrl || "/";
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
          window.opener.postMessage({
            type: "${success ? "OAUTH_AUTH_SUCCESS" : "OAUTH_AUTH_ERROR"}",
            provider: "${safeProvider}",
            error: "${safeError}"
          }, "*");
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
  if (cors(req, res)) return;

  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const action = req.query.action || urlObj.searchParams.get("action");
  const isCallback = Boolean(req.query.code || urlObj.searchParams.get("code") || action === "callback");

  // ── 1. GENERATE OAUTH AUTHORIZATION URL ──────────────────────────────────
  if (!isCallback && (action === "url" || req.method === "GET")) {
    const userEmail = extractEmail(req);
    if (!userEmail) {
      return res.status(401).json({ ok: false, error: "Unauthorized. Please sign in to connect data sources." });
    }

    const provider = req.query.provider || urlObj.searchParams.get("provider") || "google";
    const clientOrigin = req.query.origin || urlObj.searchParams.get("origin") || "";
    const redirectUri = resolveRedirectUri(req, clientOrigin);

    if (!jwtSecret) {
      return res.status(500).json({ ok: false, error: "JWT_SECRET is missing from server configuration." });
    }

    // Sign state parameter containing authenticated email and provider
    const stateToken = jwt.sign(
      {
        email: userEmail,
        provider,
        redirectUri,
        clientOrigin,
        nonce: Math.random().toString(36).substring(2),
      },
      jwtSecret,
      { expiresIn: "20m" }
    );

    if (provider === "google" || provider === "google_search_console" || provider === "google_analytics") {
      const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
      if (!clientId) {
        return res.status(400).json({
          ok: false,
          error: "GOOGLE_CLIENT_ID is not configured. Please add GOOGLE_CLIENT_ID in your environment variables.",
        });
      }

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state: stateToken,
      });

      const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;
      return res.status(200).json({ ok: true, url: authUrl, redirectUri });
    }

    if (provider === "bing" || provider === "bing_webmaster") {
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

    return res.status(400).json({ ok: false, error: `Unsupported provider: ${provider}` });
  }

  // ── 2. HANDLE OAUTH CALLBACK ─────────────────────────────────────────────
  if (isCallback) {
    const code = req.query.code || urlObj.searchParams.get("code");
    const state = req.query.state || urlObj.searchParams.get("state");
    const providerError = req.query.error || urlObj.searchParams.get("error");
    const errorDescription = req.query.error_description || urlObj.searchParams.get("error_description");

    if (providerError) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(
        renderCallbackHtml({
          success: false,
          error: errorDescription || providerError,
          returnUrl: "/",
        })
      );
    }

    if (!code || !state) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(
        renderCallbackHtml({
          success: false,
          error: "Missing authorization code or state token.",
          returnUrl: "/",
        })
      );
    }

    // Verify state token
    let statePayload;
    try {
      statePayload = jwt.verify(state, jwtSecret);
    } catch (err) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(400).send(
        renderCallbackHtml({
          success: false,
          error: "Invalid or expired authorization session. Please try connecting again.",
          returnUrl: "/",
        })
      );
    }

    const { email: userEmail, provider, redirectUri, clientOrigin } = statePayload;
    const returnUrl = clientOrigin || "/";

    if (!hasEncryptionKey()) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(500).send(
        renderCallbackHtml({
          success: false,
          error: "Server configuration error: OAUTH_TOKEN_ENCRYPTION_KEY is missing. Tokens cannot be securely encrypted.",
          returnUrl,
        })
      );
    }

    try {
      const db = await getDb();
      const usersCol = db.collection("users");
      const datasourcesCol = db.collection("datasources");

      const user = await usersCol.findOne({ email: userEmail });
      const userId = user ? user._id : userEmail;

      // ── Handle Google Token Exchange ──────────────────────────────────
      if (provider === "google" || provider === "google_search_console" || provider === "google_analytics") {
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
            provider: { $in: ["google_search_console", "google_analytics"] },
          });
          if (existing && existing.encryptedRefreshToken) {
            encryptedRefreshToken = existing.encryptedRefreshToken;
          }
        }

        const grantedScopes = tokenData.scope ? tokenData.scope.split(" ") : GOOGLE_SCOPES;
        const now = new Date();

        // Save Google Search Console connection record
        await datasourcesCol.updateOne(
          { userEmail, provider: "google_search_console" },
          {
            $set: {
              userId,
              userEmail,
              provider: "google_search_console",
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

        // Save Google Analytics 4 connection record
        await datasourcesCol.updateOne(
          { userEmail, provider: "google_analytics" },
          {
            $set: {
              userId,
              userEmail,
              provider: "google_analytics",
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

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(
          renderCallbackHtml({
            success: true,
            provider: "google",
            returnUrl,
          })
        );
      }

      // ── Handle Bing Webmaster Token Exchange ─────────────────────────
      if (provider === "bing" || provider === "bing_webmaster") {
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
            returnUrl,
          })
        );
      }

      throw new Error(`Unrecognized OAuth provider: ${provider}`);
    } catch (err) {
      console.error("[OAuth Callback Error]", err.message);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(500).send(
        renderCallbackHtml({
          success: false,
          error: err.message || "Failed to complete data source authorization.",
          returnUrl,
        })
      );
    }
  }

  return res.status(404).json({ ok: false, error: "Not found" });
};
