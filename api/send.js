const { requireAccount, verified } = require("./_lib/accountSecurity");
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
const { getDb } = require("./_lib/db");
const { getEntitlements } = require("./_lib/plans");
const { extractEmail } = require("./_lib/authMiddleware");
const { claimEmailSend } = require("./_lib/emailSendGuard");

const { cors } = require("./_lib/authMiddleware");

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
  if (!(report.findings?.length) && (status === "insufficient_data" || monitoringStatus === "insufficient_data" || report.coverageIncomplete === true || monitoringStatus === "partial")) {
    return `Sharflow Watchdog: Gathering baseline data for ${website}`;
  }
  const hasFindings = Array.isArray(report.findings) && report.findings.length > 0;
  if (!hasFindings && status === "stable") {
    return `Sharflow Watchdog: No significant changes in evaluated periods on ${website}`;
  }
  return `Sharflow Alert: Website changes detected on ${website}`;
}

// ── WATCHDOG INTELLIGENCE REPORT EMAIL TEMPLATE (E-COMMERCE BRIEFING) ─────────
function watchdogReportHtml({ name, report = {}, dateStr = "", entitlements = null }) {
  const firstName = name ? name.split(" ")[0] : "there";
  const displayDate = dateStr || report.targetDate || new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const websiteUrl = report.websiteUrl || "Your Online Store";
  const userEntitlements = entitlements || report.entitlements || null;

  const status = report.status || report.intelligence?.status || "stable";
  const monitoringStatus = report.monitoringStatus || (
    status === "no_sources" ? "no_sources" : (status === "insufficient_data" ? "insufficient_data" : "active")
  );
  const isNoSources = status === "no_sources" || monitoringStatus === "no_sources";
  const isInsufficientData = status === "insufficient_data" || monitoringStatus === "insufficient_data" || report.coverageIncomplete === true || monitoringStatus === "partial";
  const hasFindings = Array.isArray(report.findings) && report.findings.length > 0;
  const isStable = !isNoSources && !isInsufficientData && !hasFindings;

  let statusColor = "#16A34A";
  let statusBg = "#DCFCE7";
  let statusLabel = "NO SIGNIFICANT CHANGES IN EVALUATED PERIODS";

  if (isNoSources) {
    statusColor = "#D97706";
    statusBg = "#FEF3C7";
    statusLabel = "MONITORING NOT ACTIVE";
  } else if (isInsufficientData && !hasFindings) {
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

  let fallbackHeadline = "Store metric shifts detected requiring attention";
  let fallbackSummary = "Watchdog identified notable changes across your shopper conversion and traffic metrics.";
  if (isNoSources) {
    fallbackHeadline = "Monitoring not active · Connect your store data";
    fallbackSummary = "Connect Google Analytics 4 to track shopper traffic, checkout drop-offs, and store revenue.";
  } else if (isInsufficientData) {
    fallbackHeadline = "Insufficient baseline data · Gathering metrics";
    fallbackSummary = "Connected data sources do not yet have sufficient historical comparison data to evaluate shopper performance.";
  } else if (isStable) {
    fallbackHeadline = "No significant changes in evaluated periods";
    fallbackSummary = "No deterministic anomaly cleared its threshold in the evaluated evidence. This does not establish overall business or technical health.";
  }

  const headline = escapeHtml(report.intelligence?.headline && !/all systems normal|performance steady/i.test(report.intelligence.headline) ? report.intelligence.headline : fallbackHeadline);
  const summary = escapeHtml(report.intelligence?.summary && !/all systems normal|performance steady/i.test(report.intelligence.summary) ? report.intelligence.summary : fallbackSummary);

  // Store Performance KPI Block
  const sp = report.storePerformance || {};
  const isEcom = sp.configured === true;

  const visitorsVal = Number.isFinite(sp.sessions) ? `${sp.sessions.toLocaleString()} sessions` : "Unknown sessions";
  const visitorsSub = Number.isFinite(sp.users) ? `${sp.users.toLocaleString()} ${sp.userCountUnit === "user_days" ? "user-days" : "visitors"}` : "";
  const engageVal = Number.isFinite(sp.engagementRate)
    ? `${(sp.engagementRate * 100).toFixed(1)}%`
    : (Number.isFinite(sp.averageEngagementTime) ? `${sp.averageEngagementTime}s avg` : "—");
  const cartVal = isEcom && Number.isFinite(sp.addToCartCount) ? sp.addToCartCount.toLocaleString() : "Unknown";
  const checkoutVal = isEcom && Number.isFinite(sp.checkoutCount) ? sp.checkoutCount.toLocaleString() : "Unknown";
  const purchasesVal = isEcom && Number.isFinite(sp.purchaseCount) ? sp.purchaseCount.toLocaleString() : "Unknown";
  const revenueVal = isEcom && Number.isFinite(sp.revenue) && /^[A-Z]{3}$/.test(sp.currencyCode || "") ? `${sp.currencyCode} ${sp.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Unknown";

  // Where Shoppers Dropped Off calculation
  let dropOffHtml = "";
  if (isEcom && Number.isFinite(sp.checkoutToPurchaseRate) && sp.checkoutToPurchaseRate >= 0 && sp.checkoutToPurchaseRate <= 100) {
    dropOffHtml = `<div>Checkout conversion: ${sp.checkoutToPurchaseRate.toFixed(1)}% (reported event rate).</div>`;
  } else {
    dropOffHtml = "<div>Funnel conversion unavailable: compatible evidence is required.</div>";
  }

  // Traffic Sources & Verified AI Referrals
  const topChannels = Array.isArray(sp.topChannels) ? sp.topChannels : [];
  const aiReferrals = Array.isArray(sp.aiReferrals) ? sp.aiReferrals : [];
  const totalSess = Number.isFinite(sp.sessions) && sp.sessions > 0 ? sp.sessions : null;

  let sourcesHtml = "";
  if (topChannels.length > 0) {
    const channelItems = topChannels.map((c) => {
      const pct = totalSess !== null && Number.isFinite(c.sessions) ? Math.round((c.sessions / totalSess) * 100) : null;
      return `<div>• <strong>${escapeHtml(c.channel)}:</strong> ${Number.isFinite(c.sessions) ? c.sessions : "Unknown"} sessions${pct !== null ? ` (${pct}%)` : ""}</div>`;
    }).join("");

    let aiSentence = "";
    if (aiReferrals.length > 0) {
      const aiItems = aiReferrals.map(a => `${a.sessions} session${a.sessions > 1 ? "s" : ""} attributed to ${escapeHtml(a.platform || a.source)}`).join(", ");
      aiSentence = `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #E2E8F0;color:#1E293B;">🤖 <strong>AI Referrals:</strong> ${aiItems}.</div>`;
    }

    sourcesHtml = `
      <div style="font-size:13px;color:#334155;line-height:1.7;">
        ${channelItems}
        ${aiSentence}
      </div>
    `;
  } else {
    sourcesHtml = `<div style="font-size:13px;color:#64748B;">Traffic source evidence unavailable.</div>`;
  }

  const described = new Map((report.intelligence?.priorityRankedFindings || []).map(f => [f.id, f]));
  const displayFindingsList = Array.isArray(report.findings) ? report.findings.map(f => ({...described.get(f.id), ...f})) : (report.intelligence?.priorityRankedFindings || []);

  let findingsHtml = "";
  if (isNoSources) {
    findingsHtml = `
      <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:16px;color:#92400E;font-size:14px;line-height:1.6;">
        ⚠️ No data sources are currently connected. Connect Google Analytics 4 to track shopper funnel metrics and sales.
      </div>
    `;
  } else if (isInsufficientData && !displayFindingsList.length) {
    findingsHtml = `
      <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:16px;color:#92400E;font-size:14px;line-height:1.6;">
        ⏳ Baseline metrics are accumulating. Complete, fresh comparison periods are required to evaluate changes.
      </div>
    `;
  } else if (displayFindingsList.length > 0) {
    const cardsHtml = displayFindingsList.slice(0, 5).map((f) => {
      const title = escapeHtml(f.title || f.evidence?.context || f.type || "Observation");
      const badge = escapeHtml(f.priorityBadge || (f.severity === "critical" ? "P1 · Critical" : "P2 · Warning"));
      const cause = escapeHtml(f.primaryCause || (Array.isArray(f.plausibleCauses) ? f.plausibleCauses[0] : ""));
      const evObj = f.originalEvidence || f.evidence || null;
      const pctVal = evObj ? (evObj.deltaPercent ?? evObj.changePercent ?? null) : null;
      const evidenceText = evObj
        ? escapeHtml(
            pctVal !== null && pctVal !== undefined && pctVal !== ""
              ? `${evObj.metric || "metric"}: ${pctVal}% change`
              : (evObj.context || "")
          )
        : "";

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
          ${cause ? `<p style="margin:4px 0 6px;font-size:13px;color:#475569;"><strong>Possible Explanation (Hypothesis):</strong> ${cause}</p>` : ""}
          ${actionItem ? `<p style="margin:4px 0 0;font-size:13px;color:#0F172A;"><strong>Recommended Action:</strong> ${escapeHtml(actionItem)}</p>` : ""}
        </div>
      `;
    }).join("");

    const overflowDisclosure = displayFindingsList.length > 5
      ? `<div style="font-size:12px;color:#64748B;margin-top:4px;margin-bottom:14px;text-align:center;">Showing the top 5 of ${displayFindingsList.length} signals — view the full list on your dashboard.</div>`
      : "";

    findingsHtml = cardsHtml + overflowDisclosure;
  } else {
    findingsHtml = `
      <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:16px;color:#166534;font-size:14px;line-height:1.6;">
        ✓ No significant changes were established in evaluated periods. Unknown metrics and technical health are not confirmed.
      </div>
    `;
  }

  // Active sources summary
  const activeSources = Array.isArray(report.activeSources) ? report.activeSources : [];
  const ga4Source = activeSources.find(s => s.provider === "google_analytics");
  const gscSource = activeSources.find(s => s.provider === "google_search_console");
  const bingSource = activeSources.find(s => s.provider === "bing_webmaster" || s.provider === "bing");

  function formatProviderStatus(source, provName) {
    if (!source) return "Not connected";
    if (source.status === "not_in_plan" || source.reason === "Not included in your plan" || source.text === "Not included in your plan") {
      return "Not included in your plan";
    }
    const provSummary = report.fetchSummary?.providers?.find(p => p.provider === provName) ||
                        report.dataFetchSummary?.providers?.find(p => p.provider === provName);
    if (provSummary) {
      if (provSummary.status === "not_in_plan" || provSummary.reason === "Not included in your plan") {
        return "Not included in your plan";
      }
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
    return "Connected & Synced ✓";
  }

  let trialFooterHtml = "";
  if (userEntitlements?.status === "trial" && userEntitlements?.trialEndsAt) {
    const daysLeft = userEntitlements.trialDaysLeft ?? 0;
    const trialDateStr = new Date(userEntitlements.trialEndsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    trialFooterHtml = `<p style="margin-top:6px;color:#2563EB;font-weight:600;">Your free trial ends on ${trialDateStr} (${daysLeft} days left).</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sharflow Daily Store Briefing — ${displayDate}</title>
<style>
  body { margin:0; padding:0; background:#F8FAFC; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#0F172A; }
  .wrap { max-width:600px; margin:24px auto; background:#FFFFFF; border:1px solid #E2E8F0; border-radius:12px; overflow:hidden; }
  .header { background:#0F172A; padding:20px 28px; }
  .header-logo { font-size:18px; font-weight:700; color:#FFFFFF; }
  .header-sub { font-size:11px; font-weight:600; color:#94A3B8; text-transform:uppercase; letter-spacing:0.08em; margin-top:2px; }
  .body { padding:28px; }
  .section-label { font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#64748B; margin-bottom:8px; }
  .status-badge { display:inline-block; font-size:12px; font-weight:700; padding:4px 10px; border-radius:6px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:16px; }
  .kpi-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:24px; }
  .kpi-tile { background:#F8FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:12px 14px; }
  .kpi-label { font-size:11px; font-weight:600; color:#64748B; text-transform:uppercase; letter-spacing:0.04em; }
  .kpi-val { font-size:18px; font-weight:700; color:#0F172A; margin-top:4px; }
  .kpi-sub { font-size:11px; color:#64748B; margin-top:2px; }
  .card-box { background:#F8FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:14px 16px; margin-bottom:20px; }
  .cta { display:block; text-align:center; padding:13px 20px; background:#1D4ED8; color:#FFFFFF; font-size:14px; font-weight:600; text-decoration:none; border-radius:8px; margin-top:24px; }
  .footer { padding:20px 28px; text-align:center; font-size:12px; color:#94A3B8; border-top:1px solid #E2E8F0; }
</style>
</head>
<body>
<div style="padding:16px;">
  <div class="wrap">
    <div class="header">
      <div class="header-logo">Sharflow<span style="color:#2563EB;">.</span></div>
      <div class="header-sub">AI Store Watchdog · Daily Briefing</div>
    </div>
    <div class="body">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <span style="font-size:13px;color:#64748B;">${displayDate}</span>
        <span class="status-badge" style="background:${statusBg};color:${statusColor};">${statusLabel}</span>
      </div>

      <div style="font-size:18px;font-weight:700;color:#0F172A;margin-bottom:4px;">Good morning, ${escapeHtml(firstName)}.</div>
      <div style="font-size:13px;color:#475569;margin-bottom:20px;">Watching store: <strong style="color:#0F172A;">${escapeHtml(websiteUrl)}</strong></div>

      <!-- YESTERDAY'S STORE PERFORMANCE -->
      <div class="section-label">YESTERDAY'S STORE PERFORMANCE</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:22px;">
        <tr>
          <td style="width:50%;padding:4px;">
            <div class="kpi-tile">
              <div class="kpi-label">Visitors</div>
              <div class="kpi-val">${visitorsVal}</div>
              ${visitorsSub ? `<div class="kpi-sub">${visitorsSub}</div>` : ""}
            </div>
          </td>
          <td style="width:50%;padding:4px;">
            <div class="kpi-tile">
              <div class="kpi-label">Engagement</div>
              <div class="kpi-val">${engageVal}</div>
              <div class="kpi-sub">Session quality</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="width:50%;padding:4px;">
            <div class="kpi-tile">
              <div class="kpi-label">Add to Cart</div>
              <div class="kpi-val">${cartVal}</div>
              <div class="kpi-sub">${isEcom && sp.addToCartRate ? `${sp.addToCartRate}% of visits` : "Cart events"}</div>
            </div>
          </td>
          <td style="width:50%;padding:4px;">
            <div class="kpi-tile">
              <div class="kpi-label">Checkout</div>
              <div class="kpi-val">${checkoutVal}</div>
              <div class="kpi-sub">${isEcom && sp.checkoutRate ? `${sp.checkoutRate}% of visits` : "Checkouts started"}</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="width:50%;padding:4px;">
            <div class="kpi-tile">
              <div class="kpi-label">Purchases</div>
              <div class="kpi-val">${purchasesVal}</div>
              <div class="kpi-sub">${isEcom && sp.purchaseConversionRate ? `${sp.purchaseConversionRate}% conv. rate` : "Orders placed"}</div>
            </div>
          </td>
          <td style="width:50%;padding:4px;">
            <div class="kpi-tile">
              <div class="kpi-label">Revenue</div>
              <div class="kpi-val" style="color:#047857;">${revenueVal}</div>
              <div class="kpi-sub">Total sales</div>
            </div>
          </td>
        </tr>
      </table>

      <!-- WHAT CHANGED -->
      <div class="section-label">WHAT CHANGED</div>
      <div class="card-box">
        <div style="font-size:14px;font-weight:600;color:#0F172A;margin-bottom:6px;">${headline}</div>
        <div style="font-size:13px;color:#475569;line-height:1.5;">${summary}</div>${isInsufficientData ? "<p>Monitoring evidence incomplete. Overall business stability cannot be confirmed.</p>" : ""}
      </div>

      <!-- WHERE SHOPPERS DROPPED OFF -->
      <div class="section-label">WHERE SHOPPERS DROPPED OFF</div>
      <div class="card-box">
        ${dropOffHtml}
      </div>

      <!-- TRAFFIC SOURCES -->
      <div class="section-label">TRAFFIC SOURCES & ATTRIBUTION</div>
      <div class="card-box">
        ${sourcesHtml}
      </div>

      <!-- NEEDS ATTENTION -->
      <div class="section-label">NEEDS ATTENTION</div>
      ${findingsHtml}

      <!-- DATA SOURCES MONITORED -->
      <div class="section-label" style="margin-top:20px;">DATA SOURCES MONITORED</div>
      <div style="font-size:12px;color:#475569;line-height:1.8;margin-bottom:20px;">
        <div>• <strong>Google Analytics 4:</strong> ${formatProviderStatus(ga4Source, "google_analytics")} (Primary)</div>
        <div>• <strong>Google Search Console:</strong> ${formatProviderStatus(gscSource, "google_search_console")} (Secondary)</div>
        <div>• <strong>Bing Webmaster:</strong> ${formatProviderStatus(bingSource, "bing_webmaster")} (Secondary)</div>
      </div>

      <a class="cta" href="https://sharflow.online">View Store Dashboard →</a>
    </div>
    <div class="footer">
      <p>Sharflow — E-Commerce Intelligence</p>
      <p style="margin-top:4px;">You run your store. Sharflow watches what shoppers do.</p>
      ${trialFooterHtml}
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
async function sendWatchdogEmail({ toEmail, userName = "", report = {}, entitlements = null, idempotencyKey = null }) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const fromEmail = (process.env.EMAIL_FROM || process.env.FROM_EMAIL || "Sharflow <hello@sharflow.online>").trim();

  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY env var.");
  }
  if (!toEmail) {
    throw new Error("toEmail is required.");
  }

  if (typeof report.userEmail !== "string" || report.userEmail.toLowerCase() !== toEmail.toLowerCase()) {
    throw new Error("Report recipient does not match report owner.");
  }
  const ownerDb = await getDb();
  const owner = await ownerDb.collection("users").findOne({ email: toEmail.toLowerCase() });
  if (!verified(owner) || owner.configurationReviewRequired) throw new Error("Verified report owner required.");
  if (process.env.EMAIL_DELIVERY_MODE !== "resend") throw new Error("Email delivery is disabled.");
  let resolvedEntitlements = getEntitlements(owner);
  if (resolvedEntitlements.enforced && !resolvedEntitlements.canRunMonitoring) {
    throw new Error("An active monitoring plan is required.");
  }

  const subject = getWatchdogEmailSubject(report);
  const html = watchdogReportHtml({ name: userName, report, entitlements: resolvedEntitlements });

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
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
  if (cors(req, res)) return;
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/send", product: "Sharflow AI Website Watchdog" });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const authenticatedUser = await requireAccount(req, res);
  if (!authenticatedUser) return;
  const email = authenticatedUser.email;

  try {
    const body = parseBody(req);
    const action = body.action || "watchdog_report";
    const allowedKeys = new Set(["action", "reportId"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      return res.status(400).json({ error: "Only action and reportId are accepted. Recipients and content are loaded from your account." });
    }
    if (!["welcome", "watchdog_report", "digest"].includes(action)) {
      return res.status(400).json({ error: "Unknown email action." });
    }

    const db = await getDb();
    const user = await db.collection("users").findOne({ email });
    if (!user || user.active === false) return res.status(403).json({ error: "Account unavailable." });
    const entitlements = getEntitlements(user);
    let report = null;
    if (action === "welcome") {
      if (!user.profile || !user.profile.websiteUrl || body.reportId !== undefined) {
        return res.status(400).json({ error: "Save your website profile before requesting a welcome email." });
      }
    } else {
      if (typeof body.reportId !== "string" || !/^[a-f0-9]{24}$/i.test(body.reportId)) {
        return res.status(400).json({ error: "A valid saved reportId is required." });
      }
      report = await db.collection("intelligence_reports").findOne({ userEmail: email, reportId: body.reportId });
      if (!report || (report.userId && String(report.userId) !== String(user._id))) {
        return res.status(404).json({ error: "Report not found." });
      }
      if (entitlements.enforced && !entitlements.canRunMonitoring) {
        return res.status(403).json({ error: "plan_required", message: "Choose a plan to continue." });
      }
    }
    if (process.env.EMAIL_DELIVERY_MODE !== "resend" || !(process.env.RESEND_API_KEY || "").trim()) {
      return res.status(503).json({ error: "Email delivery is unavailable." });
    }
    const claim = await claimEmailSend(db, user._id);
    if (!claim.allowed) {
      res.setHeader("Retry-After", String(claim.retryAfter));
      return res.status(429).json({ error: "Please wait a minute before sending another email." });
    }

    let data;
    if (report) {
      data = await sendWatchdogEmail({
        toEmail: user.email, userName: user.name || "", report, entitlements,
        idempotencyKey: claim.idempotencyKey,
      });
    } else {
      try { await db.collection("email_send_guards").insertOne({ _id: "welcome:" + String(user._id), requestedAt: new Date() }, { writeConcern: { w: "majority", wtimeoutMS: 5000 } }); }
      catch (err) { if (err.code !== 11000 || !err.keyPattern?._id) throw err; return res.status(200).json({ ok: true, alreadyRequested: true }); }
      const html = welcomeHtml({
        name: user.name || "", email: user.email,
        websiteUrl: user.profile.websiteUrl, profileSummary: user.profile.summary || "",
      });
      const response = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + process.env.RESEND_API_KEY.trim(),
          "Idempotency-Key": claim.idempotencyKey,
        },
        body: JSON.stringify({
          from: (process.env.EMAIL_FROM || process.env.FROM_EMAIL || "Sharflow <hello@sharflow.online>").trim(),
          to: [user.email], reply_to: "hello@sharflow.online",
          subject: "Welcome to Sharflow — your Website Watchdog profile is ready", html,
        }),
      });
      data = await response.json();
      if (!response.ok) throw new Error("Email provider rejected delivery.");
    }
    return res.status(200).json({ ok: true, id: data.id, action });
  } catch (_) {
    return res.status(503).json({ error: "Unable to send email right now. Please try again later." });
  }
}

module.exports = handler;
module.exports.sendWatchdogEmail = sendWatchdogEmail;
module.exports.watchdogReportHtml = watchdogReportHtml;
module.exports.welcomeHtml = welcomeHtml;
module.exports.getWatchdogEmailSubject = getWatchdogEmailSubject;
