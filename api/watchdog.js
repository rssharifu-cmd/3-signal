/**
 * Sharflow — Watchdog Daily Intelligence Review & Debug API
 *
 * Route: /api/watchdog
 *
 * Allows reviewing and testing the Watchdog intelligence pipeline on demand
 * or viewing the latest generated intelligence report:
 *
 * GET  /api/watchdog?email=user@example.com&skipFetch=true
 * POST /api/watchdog { action: "run", userId: "...", targetDate: "YYYY-MM-DD" }
 */

const { ObjectId } = require("mongodb");
const { generateDailyIntelligence } = require("./_lib/generateDailyIntelligence");
const { getDb } = require("./_lib/db");
const { cors, extractEmail } = require("./_lib/authMiddleware");
const { getEntitlements } = require("./_lib/plans");

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed." });

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

  // Gather every supplied identity; query/body precedence must never select another target.
  const body = req.body || {};
  function identityValue(key, normalize) {
    const values = [...urlObj.searchParams.getAll(key)];
    if (req.query && Object.prototype.hasOwnProperty.call(req.query, key)) values.push(req.query[key]);
    if (Object.prototype.hasOwnProperty.call(body, key)) values.push(body[key]);
    if (values.some((v) => typeof v !== "string" || !v.trim() || v.length > 320)) {
      throw new Error("Invalid target identifier.");
    }
    const normalized = [...new Set(values.map((v) => normalize(v.trim())))];
    if (normalized.length > 1) throw new Error("Conflicting target identifiers.");
    return normalized[0] || null;
  }
  let requestedEmail, requestedUserId;
  try {
    requestedEmail = identityValue("email", (v) => v.toLowerCase());
    requestedUserId = identityValue("userId", (v) => /^[a-f0-9]{24}$/i.test(v) ? v.toLowerCase() : v);
    if (requestedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestedEmail)) throw new Error("Invalid target email.");
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
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

    const users = db.collection("users");
    const callerUser = await users.findOne({ email: authedEmail });
    if (!callerUser || callerUser.active === false) return res.status(403).json({ error: "Account unavailable." });
    let targetAccount = callerUser;
    if (!isUserAdmin) {
      if ((requestedEmail && requestedEmail !== callerUser.email.toLowerCase()) ||
          (requestedUserId && requestedUserId !== String(callerUser._id))) {
        return res.status(403).json({ ok: false, error: "Forbidden: You can only access your own watchdog data." });
      }
    } else {
      if (requestedEmail) targetAccount = await users.findOne({ email: requestedEmail });
      else if (requestedUserId) {
        const ids = ObjectId.isValid(requestedUserId) ? [requestedUserId, new ObjectId(requestedUserId)] : [requestedUserId];
        targetAccount = await users.findOne({ _id: { $in: ids } });
      }
      if (!targetAccount) return res.status(404).json({ error: "Target account not found." });
      if (requestedUserId && requestedUserId !== String(targetAccount._id)) {
        return res.status(400).json({ error: "Conflicting target identifiers." });
      }
    }
    const targetUser = targetAccount.email;
    const entitlements = getEntitlements(targetAccount);

    if (entitlements.enforced && entitlements.status === "expired") {
      return res.status(403).json({
        error: "plan_required",
        message: "Your free trial has ended. Choose a plan to continue.",
      });
    }

    // ── 1. GET: Retrieve latest report OR run pipeline ──────────────────────
    if (req.method === "GET") {
      if (viewLatestOnly) {
        const report = await db
          .collection("intelligence_reports")
          .findOne(
            { userEmail: targetUser },
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

      const report = await generateDailyIntelligence(targetUser, {
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
