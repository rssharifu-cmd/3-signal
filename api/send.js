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

// ── WATCHDOG INTELLIGENCE REPORT EMAIL TEMPLATE (E-COMMERCE BRIEFING) ─────────
function watchdogReportHtml({ name, report = {}, dateStr = "" }) {
  const firstName = name ? name.split(" ")[0] : "there";
  const displayDate = dateStr || report.targetDate || new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const websiteUrl = report.websiteUrl || "Your Online Store";

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

  let fallbackHeadline = "Store metric shifts detected requiring attention";
  let fallbackSummary = "Watchdog identified notable changes across your shopper conversion and traffic metrics.";
  if (isNoSources) {
    fallbackHeadline = "Monitoring not active · Connect your store data";
    fallbackSummary = "Connect Google Analytics 4 to track shopper traffic, checkout drop-offs, and store revenue.";
  } else if (isInsufficientData) {
    fallbackHeadline = "Insufficient baseline data · Gathering metrics";
    fallbackSummary = "Connected data sources do not yet have sufficient historical comparison data to evaluate shopper performance.";
  } else if (isStable) {
    fallbackHeadline = "All systems normal · Store performance steady";
    fallbackSummary = "No significant drop-offs in store visitors, cart additions, checkout completion, or revenue were detected.";
  }

  const headline = escapeHtml(report.intelligence?.headline || fallbackHeadline);
  const summary = escapeHtml(report.intelligence?.summary || fallbackSummary);

  // Store Performance KPI Block
  const sp = report.storePerformance || {};
  const isEcom = sp.configured === true;

  const visitorsVal = `${sp.sessions ? sp.sessions.toLocaleString() : "0"} sessions`;
  const visitorsSub = sp.users ? `${sp.users.toLocaleString()} visitors` : "";
  const engageVal = sp.engagementRate !== null && sp.engagementRate !== undefined
    ? `${(sp.engagementRate * 100).toFixed(1)}%`
    : (sp.averageEngagementTime ? `${sp.averageEngagementTime}s avg` : "—");
  const cartVal = isEcom && sp.addToCartCount !== null ? sp.addToCartCount.toLocaleString() : "Not configured";
  const checkoutVal = isEcom && sp.checkoutCount !== null ? sp.checkoutCount.toLocaleString() : "Not configured";
  const purchasesVal = isEcom && sp.purchaseCount !== null ? sp.purchaseCount.toLocaleString() : "Not configured";
  const revenueVal = isEcom && sp.revenue !== null ? `$${sp.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Not configured";

  // Where Shoppers Dropped Off calculation
  let dropOffHtml = "";
  if (isEcom && sp.checkoutCount > 0 && sp.purchaseCount !== null) {
    const c2pRate = sp.checkoutToPurchaseRate !== null ? sp.checkoutToPurchaseRate : ((sp.purchaseCount / sp.checkoutCount) * 100);
    const abandonRate = Math.max(0, 100 - c2pRate).toFixed(1);

    if (sp.addToCartCount > 0 && sp.checkoutCount < sp.addToCartCount) {
      const cartToCheckout = ((sp.checkoutCount / sp.addToCartCount) * 100).toFixed(1);
      dropOffHtml = `
        <div style="font-size:13px;color:#0F172A;line-height:1.6;">
          <strong>Checkout Drop-Off:</strong> ${abandonRate}% of shoppers who began checkout did not complete their purchase (${sp.checkoutCount} checkouts vs ${sp.purchaseCount} orders).<br/>
          <span style="color:#64748B;">Cart-to-checkout progression: ${cartToCheckout}% of cart additions proceeded to checkout.</span>
        </div>
      `;
    } else {
      dropOffHtml = `
        <div style="font-size:13px;color:#0F172A;line-height:1.6;">
          <strong>Checkout Conversion:</strong> ${c2pRate.toFixed(1)}% of shoppers who started checkout completed their purchase (${abandonRate}% checkout drop-off).
        </div>
      `;
    }
  } else if (isEcom) {
    dropOffHtml = `
      <div style="font-size:13px;color:#475569;line-height:1.5;">
        Shopper funnel progression steady with ${sp.sessions || 0} visits recorded yesterday.
      </div>
    `;
  } else {
    dropOffHtml = `
      <div style="font-size:13px;color:#64748B;line-height:1.5;">
        E-commerce funnel events (add_to_cart, begin_checkout, purchase) are not yet configured in your GA4 property. Once enabled, drop-off analysis will populate automatically.
      </div>
    `;
  }

  // Traffic Sources & Verified AI Referrals
  const topChannels = Array.isArray(sp.topChannels) ? sp.topChannels : [];
  const aiReferrals = Array.isArray(sp.aiReferrals) ? sp.aiReferrals : [];
  const totalSess = sp.sessions || 1;

  let sourcesHtml = "";
  if (topChannels.length > 0) {
    const channelItems = topChannels.map((c) => {
      const pct = Math.round((c.sessions / totalSess) * 100);
      return `<div>• <strong>${escapeHtml(c.channel)}:</strong> ${c.sessions} sessions (${pct}%)</div>`;
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
    sourcesHtml = `<div style="font-size:13px;color:#64748B;">No traffic sources recorded yesterday.</div>`;
  }

  // Filter findings: Store & Business Relevant First (omit minor SEO noise in daily email)
  const rawFindings = Array.isArray(report.intelligence?.priorityRankedFindings) && report.intelligence.priorityRankedFindings.length > 0
    ? report.intelligence.priorityRankedFindings
    : (Array.isArray(report.findings) ? report.findings : []);

  const businessRelevantFindings = rawFindings.filter((f) => {
    // Always include critical findings
    if (f.severity === "critical") return true;
    // Always include e-commerce and traffic findings
    if (["ecommerce_revenue_drop", "checkout_to_purchase_drop", "add_to_cart_drop", "conversion_drop", "traffic_source_shift", "landing_page_engagement_drop", "organic_traffic_drop"].includes(f.type)) return true;
    // Include AI referral surges
    if (f.type === "verified_ai_referral_shift") return true;
    // Omit secondary search queries unless high priority
    return f.severity === "warning" && f.scope === "site";
  });

  const displayFindingsList = businessRelevantFindings.length > 0 ? businessRelevantFindings : rawFindings;

  let findingsHtml = "";
  if (isNoSources) {
    findingsHtml = `
      <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:16px;color:#92400E;font-size:14px;line-height:1.6;">
        ⚠️ No data sources are currently connected. Connect Google Analytics 4 to track shopper funnel metrics and sales.
      </div>
    `;
  } else if (isInsufficientData) {
    findingsHtml = `
      <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:16px;color:#92400E;font-size:14px;line-height:1.6;">
        ⏳ Baseline metrics are accumulating. Watchdog requires at least 2 daily snapshots to detect funnel leaks and metric shifts.
      </div>
    `;
  } else if (!isStable && displayFindingsList.length > 0) {
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
        ✓ Your store experienced no significant drops in visitors, checkout conversion, or revenue yesterday.
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
    return "Connected & Synced ✓";
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
        <div style="font-size:13px;color:#475569;line-height:1.5;">${summary}</div>
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
