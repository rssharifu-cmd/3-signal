/**
 * Vercel Node.js Serverless — POST /api/send
 *
 * Actions:
 *   welcome         — sends a welcome / website profile confirmed email
 *   watchdog_report — sends the Watchdog daily intelligence report email
 *   digest          — alias for watchdog_report (frontend compatibility)
 *
 * Required env vars:
 *   RESEND_API_KEY   — from resend.com dashboard
 *   EMAIL_FROM       — e.g. "Sharflow <hello@sharflow.online>" (fallback: FROM_EMAIL or "Sharflow <hello@sharflow.online>")
 */

const RESEND_URL = "https://api.resend.com/emails";

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

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── WELCOME EMAIL TEMPLATE ────────────────────────────────────────────────────
function welcomeHtml({ name, websiteUrl, profileSummary, email }) {
  const firstName = name ? name.split(" ")[0] : "there";
  const safeSite = escapeHtml(websiteUrl || "Your Website");
  const safeSummary = escapeHtml(profileSummary || "Website profile configured.");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Welcome to Sharflow — AI Website Watchdog</title>
<style>
  body { margin:0; padding:0; background:#F8FAFC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#0F172A; }
  .wrap { max-width:580px; margin:24px auto; background:#FFFFFF; border:1px solid #E2E8F0; border-radius:12px; overflow:hidden; }
  .header { background:#0F172A; padding:24px 32px; display:flex; align-items:center; justify-content:space-between; }
  .header-logo { font-size:20px; font-weight:700; color:#FFFFFF; letter-spacing:-0.02em; }
  .header-tag { font-size:11px; font-weight:600; color:#94A3B8; text-transform:uppercase; letter-spacing:0.08em; }
  .body { padding:32px; }
  .greeting { font-size:22px; font-weight:700; margin-bottom:8px; color:#0F172A; letter-spacing:-0.01em; }
  .sub { font-size:15px; color:#475569; line-height:1.6; margin-bottom:24px; }
  .site-card { background:#F8FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:16px 20px; margin-bottom:24px; }
  .site-card-label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:#64748B; margin-bottom:6px; }
  .site-card-val { font-size:15px; font-weight:600; color:#0F172A; word-break:break-all; }
  .cta { display:block; width:100%; text-align:center; padding:13px 20px; background:#1D4ED8; color:#FFFFFF; font-size:14px; font-weight:600; text-decoration:none; border-radius:8px; box-sizing:border-box; }
  .footer { padding:20px 32px; text-align:center; font-size:12px; color:#94A3B8; border-top:1px solid #E2E8F0; }
  .footer a { color:#64748B; text-decoration:none; }
</style>
</head>
<body>
<div style="padding:16px;">
  <div class="wrap">
    <div class="header">
      <div class="header-logo">Sharflow<span style="color:#2563EB;">.</span></div>
      <div class="header-tag">AI Website Watchdog</div>
    </div>
    <div class="body">
      <div class="greeting">Welcome, ${escapeHtml(firstName)}!</div>
      <p class="sub">
        You run your business. Sharflow watches your website. Your monitoring profile is now configured and ready.
      </p>

      <div class="site-card">
        <div class="site-card-label">Monitored Website</div>
        <div class="site-card-val">${safeSite}</div>
        <p style="margin:10px 0 0;font-size:13px;color:#64748B;line-height:1.5;">${safeSummary}</p>
      </div>

      <p style="font-size:14px;color:#334155;line-height:1.6;margin-bottom:24px;">
        To activate daily automated anomaly detection, head to your dashboard and connect your first-party data sources (Google Search Console, Google Analytics 4, or Bing Webmaster).
      </p>

      <a class="cta" href="https://sharflow.online">Open your Watchdog Dashboard →</a>
    </div>
    <div class="footer">
      <p>You received this email because you signed up for Sharflow with ${escapeHtml(email)}</p>
      <p style="margin-top:6px;"><a href="https://sharflow.online">Sharflow</a> · AI Website Watchdog</p>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── WATCHDOG EMAIL SUBJECT HELPER ─────────────────────────────────────────────
function getWatchdogEmailSubject(report = {}) {
  const status = report.status || report.intelligence?.status || "stable";
  const monitoringStatus = report.monitoringStatus || (
    status === "no_sources" ? "no_sources" : (status === "insufficient_data" ? "insufficient_data" : "active")
  );
  const website = report.websiteUrl || "your website";

  if (status === "no_sources" || monitoringStatus === "no_sources") {
    return "Sharflow Watchdog: Monitoring not active · Connect a data source";
  }
  if (status === "insufficient_data" || monitoringStatus === "insufficient_data") {
    return `Sharflow Watchdog: Gathering baseline data for ${website}`;
  }
  const hasFindings = Array.isArray(report.findings) && report.findings.length > 0;
  if (!hasFindings && status === "stable") {
    return `Sharflow Watchdog: All systems normal on ${website}`;
  }
  return `Sharflow Alert: Website changes detected on ${website}`;
}

// ── WATCHDOG INTELLIGENCE REPORT EMAIL TEMPLATE ───────────────────────────────
function watchdogReportHtml({ name, report = {}, dateStr = "" }) {
  const firstName = name ? name.split(" ")[0] : "there";
  const displayDate = dateStr || report.targetDate || new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const websiteUrl = report.websiteUrl || "Your Monitored Website";

  const status = report.status || report.intelligence?.status || "stable";
  const monitoringStatus = report.monitoringStatus || (
    status === "no_sources" ? "no_sources" : (status === "insufficient_data" ? "insufficient_data" : "active")
  );
  const isNoSources = status === "no_sources" || monitoringStatus === "no_sources";
  const isInsufficientData = status === "insufficient_data" || monitoringStatus === "insufficient_data";
  const hasFindings = Array.isArray(report.findings) && report.findings.length > 0;
  const isStable = !isNoSources && !isInsufficientData && !hasFindings;

  let statusColor = "#16A34A";
  let statusBg = "#DCFCE7";
  let statusLabel = "ALL SYSTEMS NORMAL";

  if (isNoSources) {
    statusColor = "#D97706";
    statusBg = "#FEF3C7";
    statusLabel = "MONITORING NOT ACTIVE";
  } else if (isInsufficientData) {
    statusColor = "#D97706";
    statusBg = "#FEF3C7";
    statusLabel = "INSUFFICIENT DATA";
  } else if (report.status === "critical_attention" || status === "critical") {
    statusColor = "#DC2626";
    statusBg = "#FEE2E2";
    statusLabel = "CRITICAL ATTENTION";
  } else if (hasFindings) {
    statusColor = "#D97706";
    statusBg = "#FEF3C7";
    statusLabel = "NEEDS ATTENTION";
  }

  let fallbackHeadline = "Website changes detected requiring attention";
  let fallbackSummary = "Watchdog identified notable changes across your connected website data sources.";
  if (isNoSources) {
    fallbackHeadline = "Monitoring not active · Connect a data source";
    fallbackSummary = "Watchdog cannot determine website health until at least one verified data source is connected.";
  } else if (isInsufficientData) {
    fallbackHeadline = "Insufficient monitoring data · Gathering baseline metrics";
    fallbackSummary = "Connected data sources do not yet have sufficient historical comparison data to evaluate performance.";
  } else if (isStable) {
    fallbackHeadline = "All systems normal · No significant website changes detected";
    fallbackSummary = "No significant organic traffic drops, ranking losses, or conversion anomalies were detected across your connected data sources. Website performance and search visibility remain steady.";
  }

  const headline = escapeHtml(report.intelligence?.headline || fallbackHeadline);
  const summary = escapeHtml(report.intelligence?.summary || fallbackSummary);

  // Recommended action
  const topActions = Array.isArray(report.intelligence?.recommendedActions) && report.intelligence.recommendedActions.length > 0
    ? report.intelligence.recommendedActions
    : (isNoSources
        ? ["Connect Google Search Console or Google Analytics 4 to activate monitoring."]
        : (isInsufficientData
            ? ["Allow Watchdog to accumulate daily snapshots for baseline comparisons."]
            : (isStable
                ? ["Continue regular content updates and standard SEO monitoring.", "Verify tracking scripts remain healthy."]
                : ["Review top ranking displacement in Google Search Console."])));

  // Findings list
  const findingsList = Array.isArray(report.intelligence?.priorityRankedFindings) && report.intelligence.priorityRankedFindings.length > 0
    ? report.intelligence.priorityRankedFindings
    : (Array.isArray(report.findings) ? report.findings : []);

  let findingsHtml = "";
  if (isNoSources) {
    findingsHtml = `
      <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:16px;color:#92400E;font-size:14px;line-height:1.6;">
        ⚠️ No data sources are currently connected. Watchdog requires Google Search Console, Google Analytics 4, or Bing Webmaster Tools to evaluate website health.
      </div>
    `;
  } else if (isInsufficientData) {
    findingsHtml = `
      <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:16px;color:#92400E;font-size:14px;line-height:1.6;">
        ⏳ Baseline metrics are still accumulating. Watchdog requires at least 2 daily snapshots to reliably detect traffic drops, ranking shifts, or conversion anomalies.
      </div>
    `;
  } else if (!isStable && findingsList.length > 0) {
    findingsHtml = findingsList.slice(0, 5).map((f) => {
      const title = escapeHtml(f.title || f.evidence?.context || f.type || "Anomaly detected");
      const badge = escapeHtml(f.priorityBadge || (f.severity === "critical" ? "P1 · Critical" : "P2 · Warning"));
      const cause = escapeHtml(f.primaryCause || (Array.isArray(f.plausibleCauses) ? f.plausibleCauses[0] : ""));
      const evidenceText = f.originalEvidence
        ? escapeHtml(f.originalEvidence.metric ? `${f.originalEvidence.metric}: ${f.originalEvidence.deltaPercent || ""}% change` : f.originalEvidence.context || "")
        : (f.evidence ? escapeHtml(`${f.evidence.metric || ""}: ${f.evidence.deltaPercent || ""}%`) : "");

      const actionItem = Array.isArray(f.recommendedActions) && f.recommendedActions.length > 0
        ? (typeof f.recommendedActions[0] === "string" ? f.recommendedActions[0] : f.recommendedActions[0].action)
        : "";

      return `
        <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <strong style="font-size:14px;color:#0F172A;">${title}</strong>
            <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:100px;background:#FEE2E2;color:#991B1B;">${badge}</span>
          </div>
          ${evidenceText ? `<div style="font-size:12px;font-family:monospace;color:#2563EB;background:#EFF6FF;padding:4px 8px;border-radius:4px;display:inline-block;margin-bottom:8px;">${evidenceText}</div>` : ""}
          ${cause ? `<p style="margin:4px 0 6px;font-size:13px;color:#475569;"><strong>Probable Cause:</strong> ${cause}</p>` : ""}
          ${actionItem ? `<p style="margin:4px 0 0;font-size:13px;color:#0F172A;"><strong>Recommended Action:</strong> ${escapeHtml(actionItem)}</p>` : ""}
        </div>
      `;
    }).join("");
  } else {
    findingsHtml = `
      <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:16px;color:#166534;font-size:14px;line-height:1.6;">
        ✓ Your website had no significant traffic drops, ranking losses, or anomalies detected across your connected data sources. Everything is running smoothly.
      </div>
    `;
  }

  // Active sources list & status formatter
  const activeSources = Array.isArray(report.activeSources) ? report.activeSources : [];
  const gscSource = activeSources.find(s => s.provider === "google_search_console");
  const ga4Source = activeSources.find(s => s.provider === "google_analytics");
  const bingSource = activeSources.find(s => s.provider === "bing_webmaster" || s.provider === "bing");

  function formatProviderStatus(source, provName) {
    if (!source) return "Not connected";
    const provSummary = report.fetchSummary?.providers?.find(p => p.provider === provName) ||
                        report.dataFetchSummary?.providers?.find(p => p.provider === provName);
    if (provSummary) {
      if (provSummary.status === "error" || provSummary.error) {
        return `Connection error · ${escapeHtml(provSummary.error || "Sync failed")}`;
      }
      if (provSummary.status === "unavailable") {
        return `Connected · ${escapeHtml(provSummary.reason || "Awaiting baseline history")}`;
      }
      if (provSummary.available || provSummary.status === "available") {
        return "Connected & Synced ✓";
      }
    }
    if (source.status === "error") return `Connection error · ${escapeHtml(source.error || "Sync failed")}`;
    if (source.status === "insufficient_data") return `Connected · ${escapeHtml(source.reason || "Awaiting baseline data")}`;
    return "Connected & Synced ✓";
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sharflow Website Watchdog Report — ${displayDate}</title>
<style>
  body { margin:0; padding:0; background:#F8FAFC; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#0F172A; }
  .wrap { max-width:600px; margin:24px auto; background:#FFFFFF; border:1px solid #E2E8F0; border-radius:12px; overflow:hidden; }
  .header { background:#0F172A; padding:20px 28px; }
  .header-logo { font-size:18px; font-weight:700; color:#FFFFFF; }
  .header-sub { font-size:11px; font-weight:600; color:#94A3B8; text-transform:uppercase; letter-spacing:0.08em; margin-top:2px; }
  .body { padding:28px; }
  .section-label { font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#64748B; margin-bottom:6px; }
  .status-badge { display:inline-block; font-size:12px; font-weight:700; padding:4px 10px; border-radius:6px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:16px; }
  .cta { display:block; text-align:center; padding:13px 20px; background:#1D4ED8; color:#FFFFFF; font-size:14px; font-weight:600; text-decoration:none; border-radius:8px; margin-top:24px; }
  .footer { padding:20px 28px; text-align:center; font-size:12px; color:#94A3B8; border-top:1px solid #E2E8F0; }
  .footer a { color:#64748B; text-decoration:none; }
</style>
</head>
<body>
<div style="padding:16px;">
  <div class="wrap">
    <div class="header">
      <div class="header-logo">Sharflow<span style="color:#2563EB;">.</span></div>
      <div class="header-sub">AI Website Watchdog · Daily Intelligence Report</div>
    </div>
    <div class="body">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <span style="font-size:13px;color:#64748B;">${displayDate}</span>
        <span class="status-badge" style="background:${statusBg};color:${statusColor};">${statusLabel}</span>
      </div>

      <div style="font-size:18px;font-weight:700;color:#0F172A;margin-bottom:6px;">Good morning, ${escapeHtml(firstName)}.</div>
      <div style="font-size:13px;color:#475569;margin-bottom:20px;">Watching: <strong style="color:#0F172A;">${escapeHtml(websiteUrl)}</strong></div>

      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin-bottom:20px;">
        <div class="section-label">WHAT CHANGED</div>
        <div style="font-size:14px;font-weight:600;color:#0F172A;margin-bottom:6px;">${headline}</div>
        <div style="font-size:13px;color:#475569;line-height:1.5;">${summary}</div>
      </div>

      <div class="section-label" style="margin-top:20px;">WHAT WATCHDOG FOUND</div>
      ${findingsHtml}

      <div class="section-label" style="margin-top:20px;">RECOMMENDED ACTION FOR TODAY</div>
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:14px 16px;margin-bottom:20px;">
        <ul style="margin:0;padding-left:18px;font-size:13px;color:#0F172A;line-height:1.6;">
          ${topActions.map(a => `<li>${escapeHtml(typeof a === "string" ? a : a.action)}</li>`).join("")}
        </ul>
      </div>

      <div class="section-label">DATA SOURCES MONITORED</div>
      <div style="font-size:12px;color:#475569;line-height:1.8;margin-bottom:20px;">
        <div>• <strong>Google Search Console:</strong> ${formatProviderStatus(gscSource, "google_search_console")}</div>
        <div>• <strong>Google Analytics 4:</strong> ${formatProviderStatus(ga4Source, "google_analytics")}</div>
        <div>• <strong>Bing Webmaster:</strong> ${formatProviderStatus(bingSource, "bing_webmaster")}</div>
      </div>

      <a class="cta" href="https://sharflow.online">View Live Watchdog Dashboard →</a>
    </div>
    <div class="footer">
      <p>Sharflow — AI Website Watchdog</p>
      <p style="margin-top:4px;">You run your business. Sharflow watches your website.</p>
    </div>
  </div>
</div>
</body>
</html>`;
}

/**
 * Direct programmatic helper to send a Watchdog intelligence report email.
 * @param {object} params
 * @param {string} params.toEmail
 * @param {string} [params.userName]
 * @param {object} params.report
 * @returns {Promise<object>}
 */
async function sendWatchdogEmail({ toEmail, userName = "", report = {} }) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const fromEmail = (process.env.EMAIL_FROM || process.env.FROM_EMAIL || "Sharflow <hello@sharflow.online>").trim();

  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY env var.");
  }
  if (!toEmail) {
    throw new Error("toEmail is required.");
  }

  const subject = getWatchdogEmailSubject(report);
  const html = watchdogReportHtml({ name: userName, report });

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      reply_to: "hello@sharflow.online",
      subject,
      html,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || data?.name || "Failed to send email via Resend");
  }
  return data;
}

// ── HTTP HANDLER ─────────────────────────────────────────────────────────────
async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/send", product: "Sharflow AI Website Watchdog" });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const fromEmail = (process.env.EMAIL_FROM || process.env.FROM_EMAIL || "Sharflow <hello@sharflow.online>").trim();

  if (!apiKey) {
    return res.status(400).json({ error: "Missing RESEND_API_KEY env var." });
  }

  try {
    const body = parseBody(req);
    const action = body.action || "watchdog_report";
    const toEmail = (body.email || "").trim();

    if (!toEmail) return res.status(400).json({ error: "email is required" });

    let subject, html;

    // ── WELCOME ──────────────────────────────────────────────────────────────
    if (action === "welcome") {
      const name = body.name || "";
      const websiteUrl = body.websiteUrl || body.profile?.websiteUrl || "";
      const profileSummary = body.profileSummary || body.profile?.summary || "";

      subject = `Welcome to Sharflow${name ? `, ${name.split(" ")[0]}` : ""} — your Website Watchdog is ready`;
      html = welcomeHtml({ name, websiteUrl, profileSummary, email: toEmail });

    // ── WATCHDOG INTELLIGENCE REPORT ─────────────────────────────────────────
    } else if (action === "watchdog_report" || action === "digest") {
      const name = body.name || "";
      const report = body.report || {};
      subject = getWatchdogEmailSubject(report);
      html = watchdogReportHtml({ name, report });

    } else {
      return res.status(400).json({ error: "Unknown action. Use 'welcome' or 'watchdog_report'." });
    }

    const sendRes = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        reply_to: "hello@sharflow.online",
        subject,
        html,
      }),
    });

    const data = await sendRes.json();

    if (!sendRes.ok) {
      return res.status(sendRes.status).json({ error: data?.message || data?.name || "Resend API error", details: data });
    }

    return res.status(200).json({ ok: true, id: data.id, action });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

module.exports = handler;
module.exports.sendWatchdogEmail = sendWatchdogEmail;
module.exports.watchdogReportHtml = watchdogReportHtml;
module.exports.welcomeHtml = welcomeHtml;
module.exports.getWatchdogEmailSubject = getWatchdogEmailSubject;
