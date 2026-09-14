/**
 * Sharflow — OAuth Token and Property Management
 *
 * Handles server-side token refreshes and property discovery for:
 * - Google Search Console
 * - Google Analytics 4
 * - Bing Webmaster Tools
 *
 * SENSITIVE DATA POLICY:
 * - Refresh tokens are decrypted only in memory when exchanging for access tokens.
 * - Refresh tokens are NEVER logged and NEVER returned to the client.
 */

const { getDb } = require("./db");
const { decryptToken, encryptToken, hasEncryptionKey } = require("./cryptoUtils");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const BING_TOKEN_URL = "https://www.bing.com/webmasters/oauth/token";

/**
 * Retrieves a valid Google access token using the stored encrypted refresh token.
 * @param {string} userEmail
 * @returns {Promise<{ accessToken: string, accountEmail: string }>}
 */
async function getGoogleAccessToken(userEmail) {
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured.");
  }
  if (!hasEncryptionKey()) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is not configured.");
  }

  const db = await getDb();
  const conn = await db.collection("datasources").findOne({
    userEmail,
    provider: { $in: ["google_search_console", "google_analytics", "google"] },
    encryptedRefreshToken: { $exists: true, $ne: "" },
  });

  if (!conn || !conn.encryptedRefreshToken) {
    throw new Error("No Google account connected for this user.");
  }

  const refreshToken = decryptToken(conn.encryptedRefreshToken);
  if (!refreshToken) {
    throw new Error("Failed to decrypt Google refresh token.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    const errMsg = data.error_description || data.error || "Failed to refresh Google token";
    console.warn(`[OAuth] Google token refresh failed for ${userEmail}: ${errMsg}`);
    throw new Error(`Google authorization expired or revoked. Please reconnect Google.`);
  }

  // If Google issued a new refresh token, persist it safely
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    const newEncrypted = encryptToken(data.refresh_token);
    await db.collection("datasources").updateMany(
      { userEmail, provider: { $in: ["google_search_console", "google_analytics", "google"] } },
      { $set: { encryptedRefreshToken: newEncrypted, updatedAt: new Date() } }
    );
  }

  return {
    accessToken: data.access_token,
    accountEmail: conn.providerAccountId || "",
  };
}

/**
 * Retrieves a valid Bing access token using the stored encrypted refresh token.
 * @param {string} userEmail
 * @returns {Promise<{ accessToken: string }>}
 */
async function getBingAccessToken(userEmail) {
  const clientId = (process.env.BING_CLIENT_ID || "").trim();
  const clientSecret = (process.env.BING_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) {
    throw new Error("BING_CLIENT_ID and BING_CLIENT_SECRET must be configured.");
  }
  if (!hasEncryptionKey()) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is not configured.");
  }

  const db = await getDb();
  const conn = await db.collection("datasources").findOne({
    userEmail,
    provider: "bing_webmaster",
    encryptedRefreshToken: { $exists: true, $ne: "" },
  });

  if (!conn || !conn.encryptedRefreshToken) {
    throw new Error("No Bing Webmaster account connected for this user.");
  }

  const refreshToken = decryptToken(conn.encryptedRefreshToken);
  if (!refreshToken) {
    throw new Error("Failed to decrypt Bing refresh token.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(BING_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    const errMsg = data.error_description || data.error || "Failed to refresh Bing token";
    console.warn(`[OAuth] Bing token refresh failed for ${userEmail}: ${errMsg}`);
    throw new Error(`Bing Webmaster authorization expired or revoked. Please reconnect Bing.`);
  }

  // If Bing issued a new refresh token, persist it safely
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    const newEncrypted = encryptToken(data.refresh_token);
    await db.collection("datasources").updateOne(
      { userEmail, provider: "bing_webmaster" },
      { $set: { encryptedRefreshToken: newEncrypted, updatedAt: new Date() } }
    );
  }

  return { accessToken: data.access_token };
}

/**
 * Discovers accessible Google Search Console verified properties.
 * @param {string} accessToken
 * @returns {Promise<Array<{ id: string, name: string, url: string, permissionLevel: string }>>}
 */
async function discoverSearchConsoleProperties(accessToken) {
  const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    let errJson = {};
    try { errJson = JSON.parse(errText); } catch {}
    throw new Error(errJson.error?.message || `Search Console API returned status ${res.status}`);
  }

  const data = await res.json();
  const entries = data.siteEntry || [];

  return entries.map((entry) => ({
    id: entry.siteUrl,
    name: entry.siteUrl,
    url: entry.siteUrl.startsWith("sc-domain:") 
      ? `https://${entry.siteUrl.replace("sc-domain:", "")}` 
      : entry.siteUrl,
    permissionLevel: entry.permissionLevel || "siteOwner",
  }));
}

/**
 * Discovers accessible Google Analytics 4 properties.
 * @param {string} accessToken
 * @returns {Promise<Array<{ id: string, name: string, accountName: string }>>}
 */
async function discoverAnalyticsProperties(accessToken) {
  // Use GA4 Admin API v1beta accountSummaries
  const res = await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    let errJson = {};
    try { errJson = JSON.parse(errText); } catch {}
    throw new Error(errJson.error?.message || `Google Analytics Admin API returned status ${res.status}`);
  }

  const data = await res.json();
  const summaries = data.accountSummaries || [];
  const properties = [];

  for (const acc of summaries) {
    const accountName = acc.displayName || "Account";
    const propList = acc.propertySummaries || [];
    for (const p of propList) {
      properties.push({
        id: p.property, // Format: "properties/12345678"
        name: `${p.displayName} (${p.property.replace("properties/", "ID: ")})`,
        accountName,
        propertyId: p.property.replace("properties/", ""),
      });
    }
  }

  return properties;
}

/**
 * Discovers accessible verified sites in Bing Webmaster Tools.
 * Supports individual OAuth access token, with optional fallback to BING_WEBMASTER_API_KEY if testing.
 * @param {string} [accessToken]
 * @returns {Promise<Array<{ id: string, name: string, url: string, isVerified: boolean }>>}
 */
async function discoverBingSites(accessToken) {
  let url = "https://ssl.bing.com/webmaster/api.svc/json/GetUserSites";
  const headers = {};

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else if (process.env.BING_WEBMASTER_API_KEY) {
    // Administrative fallback for testing
    url += `?apikey=${encodeURIComponent(process.env.BING_WEBMASTER_API_KEY.trim())}`;
  } else {
    throw new Error("No Bing OAuth access token or API key available.");
  }

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Bing Webmaster API returned status ${res.status}: ${errText.slice(0, 150)}`);
  }

  const data = await res.json();
  // Bing returns { d: [ { Url, IsVerified, Role } ] }
  const sites = data.d || [];

  return sites.map((site) => ({
    id: site.Url,
    name: site.Url,
    url: site.Url,
    isVerified: Boolean(site.IsVerified),
    role: site.Role || "Administrator",
  }));
}

module.exports = {
  getGoogleAccessToken,
  getBingAccessToken,
  discoverSearchConsoleProperties,
  discoverAnalyticsProperties,
  discoverBingSites,
};
