/**
 * Sharflow — Watchdog Daily Intelligence Review & Debug API
 *
 * Route: /api/watchdog
 *
 * Allows reviewing and testing the Watchdog intelligence pipeline independently
 * without triggering emails or altering existing news digest features:
 *
 * GET  /api/watchdog?email=user@example.com&skipFetch=true
 * POST /api/watchdog { action: "run", userId: "...", targetDate: "YYYY-MM-DD" }
 */

const { generateDailyIntelligence } = require("./_lib/generateDailyIntelligence");
const { getDb } = require("./_lib/db");
const { cors, extractEmail } = require("./_lib/authMiddleware");

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;

  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // 1. Require a valid authenticated session
  const authedEmail = extractEmail(req);
  if (!authedEmail) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized: Missing or invalid JWT session token.",
    });
  }

  // 2. Authorize admin check
  const rawAdminEmails = process.env.ADMIN_EMAILS || "";
  const adminList = rawAdminEmails
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const isUserAdmin = adminList.length > 0 && adminList.includes(authedEmail.toLowerCase());

  // 3. Determine requested target user (if an explicit query or body param was provided)
  const requestedEmail =
    req.query?.email ||
    urlObj.searchParams.get("email") ||
    (req.body && req.body.email);
  const requestedUserId =
    req.query?.userId ||
    urlObj.searchParams.get("userId") ||
    (req.body && req.body.userId);

  let targetUser = authedEmail;

  if (requestedEmail) {
    const isSelf = requestedEmail.trim().toLowerCase() === authedEmail.trim().toLowerCase();
    if (!isSelf && !isUserAdmin) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden: You do not have permission to access another user's watchdog data.",
      });
    }
    targetUser = isUserAdmin ? requestedEmail.trim() : authedEmail;
  } else if (requestedUserId) {
    if (!isUserAdmin) {
      const db = await getDb();
      const currentUser = await db.collection("users").findOne({ email: authedEmail.toLowerCase() });
      const currentUserIdStr = currentUser?._id ? currentUser._id.toString() : null;
      if (!currentUserIdStr || currentUserIdStr !== String(requestedUserId).trim()) {
        return res.status(403).json({
          ok: false,
          error: "Forbidden: You do not have permission to access another user's watchdog data.",
        });
      }
    }
    targetUser = String(requestedUserId).trim();
  }

  const targetDate = req.query?.targetDate || urlObj.searchParams.get("targetDate") || undefined;
  const skipFetch =
    req.query?.skipFetch === "true" ||
    urlObj.searchParams.get("skipFetch") === "true";
  const dryRun =
    req.query?.dryRun === "true" ||
    urlObj.searchParams.get("dryRun") === "true";
  const viewLatestOnly =
    req.query?.viewLatest === "true" ||
    urlObj.searchParams.get("viewLatest") === "true";

  try {
    const db = await getDb();

    // ── 1. GET: Retrieve latest report OR run pipeline ──────────────────────
    if (req.method === "GET") {
      if (viewLatestOnly) {
        const report = await db
          .collection("intelligence_reports")
          .findOne(
            { $or: [{ userEmail: targetUser }, { userId: targetUser }] },
            { sort: { targetDate: -1, generatedAt: -1 } }
          );
        if (report) {
          return res.status(200).json({ ok: true, report });
        }
      }

      // Execute intelligence pipeline
      const report = await generateDailyIntelligence(targetUser, {
        targetDate,
        skipFetch,
        dryRun,
      });

      return res.status(200).json({
        ok: true,
        message: "Watchdog intelligence generated successfully.",
        report,
      });
    }

    // ── 2. POST: Trigger pipeline run on-demand ─────────────────────────────
    if (req.method === "POST") {
      const body = req.body || {};
      const action = body.action || "run";

      if (action !== "run") {
        return res.status(400).json({ ok: false, error: `Invalid action: ${action}. Use 'run'.` });
      }

      const postTargetUser = body.userId || body.email || targetUser;
      const report = await generateDailyIntelligence(postTargetUser, {
        targetDate: body.targetDate || targetDate,
        skipFetch: Boolean(body.skipFetch ?? skipFetch),
        dryRun: Boolean(body.dryRun ?? dryRun),
      });

      return res.status(200).json({
        ok: true,
        message: "Watchdog intelligence report generated.",
        report,
      });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed." });
  } catch (err) {
    console.error("[Watchdog API Handler Error]", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to execute watchdog intelligence pipeline.",
    });
  }
};
