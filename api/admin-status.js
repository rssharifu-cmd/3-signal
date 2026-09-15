/**
 * Sharflow — Admin API Status Endpoint (/api/admin-status)
 *
 * Checks health, connectivity, latency, and status across all external service dependencies:
 * - MongoDB Atlas
 * - Gemini API
 * - Tavily Search API
 * - YouTube Data API v3
 * - Reddit Public Search API
 * - Resend Email API
 * - Last Cron Run / Digest Activity Summary
 *
 * Requires valid JWT via Authorization: Bearer <token>
 * and email present in ADMIN_EMAILS environment variable.
 */

const { cors, extractEmail } = require("./_lib/authMiddleware");
const { getDb } = require("./_lib/db");

const TIMEOUT_MS = 8000;

function withTimeout(promise, ms, serviceName) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${serviceName || "Service"} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ── HEALTH CHECK HELPERS ──────────────────────────────────────────────────────

async function checkMongo() {
  const start = Date.now();
  try {
    const db = await withTimeout(getDb(), TIMEOUT_MS, "MongoDB connection");
    await withTimeout(db.command({ ping: 1 }), TIMEOUT_MS, "MongoDB ping");
    const responseTimeMs = Date.now() - start;
    return {
      service: "MongoDB Atlas",
      status: "ok",
      responseTimeMs,
      message: "Database ping succeeded. Atlas cluster is active and responsive.",
    };
  } catch (err) {
    return {
      service: "MongoDB Atlas",
      status: "error",
      responseTimeMs: Date.now() - start,
      message: `Database error: ${err.message || "Failed to reach MongoDB cluster"}`,
    };
  }
}

async function checkGemini() {
  const start = Date.now();
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return {
      service: "Gemini AI",
      status: "error",
      responseTimeMs: 0,
      message: "GEMINI_API_KEY is not configured in environment variables.",
    };
  }

  try {
    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const res = await withTimeout(
      ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        config: { maxOutputTokens: 5 },
      }),
      TIMEOUT_MS,
      "Gemini API"
    );

    const responseTimeMs = Date.now() - start;
    return {
      service: "Gemini AI",
      status: "ok",
      responseTimeMs,
      message: `Gemini 3.5 Flash-Lite responded successfully (${(res.text || "").trim().slice(0, 30)}).`,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    const errMsg = String(err?.message || err || "");
    const status = err?.status || err?.statusCode || err?.code;

    if (status === 401 || /API_KEY_INVALID|invalid api key|unauthenticated/i.test(errMsg)) {
      return {
        service: "Gemini AI",
        status: "error",
        responseTimeMs,
        message: `Authentication failed: Invalid GEMINI_API_KEY (${errMsg}).`,
      };
    }
    if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(errMsg)) {
      return {
        service: "Gemini AI",
        status: "error",
        responseTimeMs,
        message: `Quota or rate limit reached: ${errMsg}`,
      };
    }
    if (status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(errMsg)) {
      return {
        service: "Gemini AI",
        status: "error",
        responseTimeMs,
        message: `Service temporarily unavailable (503): High demand.`,
      };
    }
    return {
      service: "Gemini AI",
      status: "error",
      responseTimeMs,
      message: `Gemini error: ${errMsg}`,
    };
  }
}

async function checkTavily() {
  const start = Date.now();
  const apiKey = (process.env.TAVILY_API_KEY || "").trim();
  if (!apiKey) {
    return {
      service: "Tavily Search",
      status: "error",
      responseTimeMs: 0,
      message: "TAVILY_API_KEY is not configured in environment variables.",
    };
  }

  try {
    const res = await withTimeout(
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: "ping",
          max_results: 1,
        }),
      }),
      TIMEOUT_MS,
      "Tavily Search"
    );

    const responseTimeMs = Date.now() - start;
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const errDetail = errBody.detail?.error || errBody.message || res.statusText;
      if (res.status === 401 || res.status === 403) {
        return {
          service: "Tavily Search",
          status: "error",
          responseTimeMs,
          message: `Authentication failed (HTTP ${res.status}): ${errDetail}. Check TAVILY_API_KEY.`,
        };
      }
      if (res.status === 429) {
        return {
          service: "Tavily Search",
          status: "error",
          responseTimeMs,
          message: `Rate limit or monthly credit quota exceeded: ${errDetail}`,
        };
      }
      return {
        service: "Tavily Search",
        status: "error",
        responseTimeMs,
        message: `Tavily returned HTTP ${res.status}: ${errDetail}`,
      };
    }

    const data = await res.json();
    const resultCount = (data.results || []).length;
    return {
      service: "Tavily Search",
      status: "ok",
      responseTimeMs,
      message: `Search query executed successfully (${resultCount} result returned). Note: Live remaining monthly credits must be verified directly on Tavily's dashboard.`,
      extra: {
        apiResponseTime: data.response_time || null,
        resultsReturned: resultCount,
      },
    };
  } catch (err) {
    return {
      service: "Tavily Search",
      status: "error",
      responseTimeMs: Date.now() - start,
      message: `Tavily check failed: ${err.message}`,
    };
  }
}

async function checkYouTube() {
  const start = Date.now();
  const apiKey = (process.env.YOUTUBE_API_KEY || "").trim();
  if (!apiKey) {
    return {
      service: "YouTube Data API",
      status: "error",
      responseTimeMs: 0,
      message: "YOUTUBE_API_KEY is not configured in environment variables.",
    };
  }

  try {
    const params = new URLSearchParams({
      part: "snippet",
      q: "news",
      type: "video",
      maxResults: "1",
      key: apiKey,
    });
    const res = await withTimeout(
      fetch(`https://www.googleapis.com/youtube/v3/search?${params}`),
      TIMEOUT_MS,
      "YouTube Data API"
    );

    const responseTimeMs = Date.now() - start;
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const reason = errData.error?.errors?.[0]?.reason || "";
      const msg = errData.error?.message || res.statusText;

      if (reason === "quotaExceeded" || /quotaExceeded|quota/i.test(msg)) {
        return {
          service: "YouTube Data API",
          status: "error",
          responseTimeMs,
          message: "Daily quota exceeded (10,000 units/day limit reached). Daily quota resets at midnight Pacific Time (PT).",
        };
      }
      if (res.status === 400 || res.status === 401 || /key/i.test(msg)) {
        return {
          service: "YouTube Data API",
          status: "error",
          responseTimeMs,
          message: `API Key invalid or restricted: ${msg}`,
        };
      }
      return {
        service: "YouTube Data API",
        status: "error",
        responseTimeMs,
        message: `YouTube API returned HTTP ${res.status}: ${msg}`,
      };
    }

    const data = await res.json();
    return {
      service: "YouTube Data API",
      status: "ok",
      responseTimeMs,
      message: "Search query executed successfully. Note: Real-time remaining quota points are not queryable via API; check Google Cloud Console for daily quota metrics.",
      extra: {
        totalResultsSample: data.pageInfo?.totalResults || null,
      },
    };
  } catch (err) {
    return {
      service: "YouTube Data API",
      status: "error",
      responseTimeMs: Date.now() - start,
      message: `YouTube check failed: ${err.message}`,
    };
  }
}

async function checkReddit() {
  const start = Date.now();
  try {
    const res = await withTimeout(
      fetch("https://www.reddit.com/search.json?q=technology&sort=relevance&limit=1", {
        headers: { "User-Agent": "Signal-NewsDigest/1.0 (by /u/sharflow)" },
      }),
      TIMEOUT_MS,
      "Reddit Public API"
    );

    const responseTimeMs = Date.now() - start;
    if (!res.ok) {
      if (res.status === 429) {
        return {
          service: "Reddit Search",
          status: "error",
          responseTimeMs,
          message: "Reddit public API rate limit reached (HTTP 429 Too Many Requests).",
        };
      }
      return {
        service: "Reddit Search",
        status: "error",
        responseTimeMs,
        message: `Reddit returned HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const data = await res.json();
    const children = data?.data?.children || [];
    return {
      service: "Reddit Search",
      status: "ok",
      responseTimeMs,
      message: `Public search endpoint reachable (HTTP 200, returned ${children.length} sample post).`,
    };
  } catch (err) {
    return {
      service: "Reddit Search",
      status: "error",
      responseTimeMs: Date.now() - start,
      message: `Reddit check failed: ${err.message}`,
    };
  }
}

async function checkResend() {
  const start = Date.now();
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    return {
      service: "Resend Email",
      status: "error",
      responseTimeMs: 0,
      message: "RESEND_API_KEY is not configured in environment variables.",
    };
  }

  try {
    // Read-only endpoint to validate key without sending any email
    const res = await withTimeout(
      fetch("https://api.resend.com/domains", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }),
      TIMEOUT_MS,
      "Resend API"
    );

    const responseTimeMs = Date.now() - start;
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody.message || res.statusText;
      if (res.status === 401 || res.status === 403) {
        return {
          service: "Resend Email",
          status: "error",
          responseTimeMs,
          message: `Authentication failed (HTTP ${res.status}): ${msg}. Check RESEND_API_KEY.`,
        };
      }
      if (res.status === 429) {
        return {
          service: "Resend Email",
          status: "error",
          responseTimeMs,
          message: `Resend rate limit exceeded (HTTP 429): ${msg}`,
        };
      }
      return {
        service: "Resend Email",
        status: "error",
        responseTimeMs,
        message: `Resend returned HTTP ${res.status}: ${msg}`,
      };
    }

    const data = await res.json();
    const domains = (data.data || []).map((d) => d.name || d.id);
    return {
      service: "Resend Email",
      status: "ok",
      responseTimeMs,
      message: `API Key verified via read-only domains endpoint (${domains.length} domain(s) configured).`,
      extra: {
        configuredDomains: domains,
        senderFrom: process.env.FROM_EMAIL || "Sharflow <onboarding@resend.dev>",
      },
    };
  } catch (err) {
    return {
      service: "Resend Email",
      status: "error",
      responseTimeMs: Date.now() - start,
      message: `Resend check failed: ${err.message}`,
    };
  }
}

async function checkCronSummary() {
  const start = Date.now();
  try {
    const db = await withTimeout(getDb(), TIMEOUT_MS, "MongoDB");
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [sentCount, lockedCount, latestDigest, recentLogs] = await Promise.all([
      db.collection("digests").countDocuments({ sentAt: { $gte: last24h } }),
      db.collection("digests").countDocuments({ locked: true, lockedAt: { $gte: last24h } }),
      db.collection("digests").findOne({ sentAt: { $exists: true } }, { sort: { sentAt: -1 } }),
      db.collection("delivery_logs").find({ timestamp: { $gte: last24h } }).sort({ timestamp: -1 }).limit(10).toArray().catch(() => []),
    ]);

    const failedLogsCount = recentLogs.filter((l) => l.status === "failed").length;
    const skippedLogsCount = recentLogs.filter((l) => l.status === "skipped").length;

    let status = "ok";
    if (lockedCount > 0 && sentCount === 0) {
      status = "unknown";
    }

    const responseTimeMs = Date.now() - start;
    const lastSentFormatted = latestDigest?.sentAt ? new Date(latestDigest.sentAt).toISOString() : "None";

    return {
      service: "Cron Activity (Last 24h)",
      status,
      responseTimeMs,
      message: `${sentCount} digest(s) successfully delivered in last 24h. Last sent: ${lastSentFormatted}.`,
      extra: {
        sentLast24h: sentCount,
        lockedOrInProgress: lockedCount,
        recentFailedDeliveries: failedLogsCount,
        recentSkippedDeliveries: skippedLogsCount,
        latestSentAt: latestDigest?.sentAt || null,
        note: "Derived from MongoDB digests and delivery_logs collections (best available persisted cron telemetry).",
      },
    };
  } catch (err) {
    return {
      service: "Cron Activity (Last 24h)",
      status: "error",
      responseTimeMs: Date.now() - start,
      message: `Could not retrieve cron activity summary: ${err.message}`,
    };
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  // 1. Authenticate JWT token
  const email = extractEmail(req);
  if (!email) {
    return res.status(401).json({ error: "Unauthorized: Missing or invalid JWT session token." });
  }

  // 2. Authorize email against ADMIN_EMAILS allowlist
  const rawAdminEmails = process.env.ADMIN_EMAILS || "";
  const adminList = rawAdminEmails
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const userEmailLower = email.toLowerCase();
  const isAuthorized = adminList.length > 0 && adminList.includes(userEmailLower);

  if (!isAuthorized) {
    return res.status(403).json({
      error: "Access denied: Your account is not on the admin allowlist.",
      user: email,
    });
  }

  // 3. Execute all health checks in parallel with individual timeouts
  const checkPromises = [
    checkMongo(),
    checkGemini(),
    checkTavily(),
    checkYouTube(),
    checkReddit(),
    checkResend(),
    checkCronSummary(),
  ];

  const resultsSettled = await Promise.allSettled(checkPromises);

  const services = resultsSettled.map((r, i) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return {
      service: `Check #${i + 1}`,
      status: "error",
      responseTimeMs: TIMEOUT_MS,
      message: `Check threw unhandled exception: ${r.reason?.message || "Unknown error"}`,
    };
  });

  const okCount = services.filter((s) => s.status === "ok").length;
  const errorCount = services.filter((s) => s.status === "error").length;

  return res.status(200).json({
    authenticatedAs: email,
    checkedAt: new Date().toISOString(),
    summary: {
      totalServices: services.length,
      healthy: okCount,
      failing: errorCount,
    },
    services,
  });
}

module.exports = handler;
