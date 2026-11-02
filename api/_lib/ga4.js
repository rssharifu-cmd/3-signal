/**
 * Sharflow — Google Analytics 4 Performance Data Fetcher (E-Commerce Focused)
 *
 * Primary business intelligence collector for store owners:
 * - Traffic: Sessions, Total Users, New Users, Returning Users.
 * - Engagement: Engagement Rate, Avg Engagement Time, Page Views, Bounce Rate.
 * - Attribution & Channels: Source, Medium, Campaign, plus Verified AI-referral attribution.
 * - Landing Pages: Entry point volume and engagement quality.
 * - Device & Geo: Mobile/Desktop splits, Country breakdown.
 * - E-Commerce Funnel & Revenue: view_item, add_to_cart, begin_checkout, purchase, revenue.
 *
 * Uses the stored encrypted refresh token via getGoogleAccessToken() in api/_lib/oauthTokens.js.
 * Normalizes responses into the common snapshot shape with explicit null/not-configured handling.
 */

const { getGoogleAccessToken } = require("./oauthTokens");

const GA4_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";

// Recognized AI referral domains (matched against verified sessionSource/referrer data only)
const AI_REFERRAL_DOMAINS = [
  { domain: "chatgpt.com", platform: "ChatGPT" },
  { domain: "chat.openai.com", platform: "ChatGPT" },
  { domain: "openai.com", platform: "ChatGPT" },
  { domain: "perplexity.ai", platform: "Perplexity" },
  { domain: "claude.ai", platform: "Claude" },
  { domain: "anthropic.com", platform: "Claude" },
  { domain: "copilot.microsoft.com", platform: "Copilot" },
  { domain: "bing.com/chat", platform: "Copilot" },
  { domain: "gemini.google.com", platform: "Gemini" },
  { domain: "poe.com", platform: "Poe" },
  { domain: "meta.ai", platform: "Meta AI" },
  { domain: "groq.com", platform: "Groq" },
  { domain: "mistral.ai", platform: "Mistral" },
];

/**
 * Checks if a session source or medium originates from a verified AI platform.
 * @param {string} source
 * @param {string} medium
 * @returns {{ isAi: boolean, platform: string }}
 */
function classifyAiReferral(source = "", medium = "") {
  const src = String(source || "").toLowerCase().trim();
  const med = String(medium || "").toLowerCase().trim();
  const combined = `${src} ${med}`;

  for (const item of AI_REFERRAL_DOMAINS) {
    if (src.includes(item.domain) || combined.includes(item.domain)) {
      return { isAi: true, platform: item.platform };
    }
  }

  // Known source keywords
  if (src.includes("chatgpt")) return { isAi: true, platform: "ChatGPT" };
  if (src.includes("perplexity")) return { isAi: true, platform: "Perplexity" };
  if (src.includes("claude")) return { isAi: true, platform: "Claude" };
  if (src.includes("copilot")) return { isAi: true, platform: "Copilot" };
  if (src.includes("gemini")) return { isAi: true, platform: "Gemini" };

  // For unknown sources with utm_medium=ai or ai-search, use the actual source name or "AI Referral"
  if (med === "ai" || med === "ai-search" || med.includes("ai-search") || med.includes("ai_search")) {
    const rawSource = String(source || "").trim();
    const platform = rawSource && rawSource !== "(direct)" && rawSource !== "(not set)"
      ? rawSource.charAt(0).toUpperCase() + rawSource.slice(1)
      : "AI Referral";
    return { isAi: true, platform };
  }

  return { isAi: false, platform: "" };
}

/**
 * Formats a Date object to YYYY-MM-DD
 * @param {Date} d
 * @returns {string}
 */
function formatDate(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Normalizes GA4 date "YYYYMMDD" to "YYYY-MM-DD"
 * @param {string} d
 * @returns {string}
 */
function parseGa4Date(d) {
  if (!d) return "";
  if (d.includes("-")) return d;
  return d.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
}

/**
 * Calculates a default date range if none is provided.
 * Default: last 28 days ending yesterday.
 */
function getDefaultDateRange() {
  const now = new Date();
  const endDateObj = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
  const startDateObj = new Date(endDateObj.getTime() - 27 * 24 * 60 * 60 * 1000);
  return {
    startDate: formatDate(startDateObj),
    endDate: formatDate(endDateObj),
  };
}

/**
 * Executes a GA4 Data API runReport call.
 * @param {string} accessToken
 * @param {string} propertyId
 * @param {object} reportBody
 * @returns {Promise<object>}
 */
async function runGa4Report(accessToken, propertyId, reportBody) {
  const propPath = propertyId.startsWith("properties/") ? propertyId : `properties/${propertyId}`;
  const url = `${GA4_DATA_BASE}/${propPath}:runReport`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reportBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errJson = {};
    try { errJson = JSON.parse(errText); } catch {}
    const msg = errJson.error?.message || `GA4 API HTTP ${res.status}: ${errText.slice(0, 150)}`;
    throw new Error(msg);
  }

  return res.json();
}

/**
 * Fetches and normalizes GA4 analytics and e-commerce data for a user and property.
 *
 * @param {object} params
 * @param {string} params.userEmail - User email to refresh OAuth token for
 * @param {string} params.propertyRef - GA4 property ID (e.g. "properties/12345678" or "12345678")
 * @param {string} [params.startDate] - YYYY-MM-DD
 * @param {string} [params.endDate] - YYYY-MM-DD
 * @param {string} [params.accessToken] - Optional pre-fetched access token
 * @returns {Promise<Array<{ provider: string, propertyRef: string, date: string, metrics: object, dimensions: object }>>}
 */
async function fetchGa4Performance({
  userEmail,
  propertyRef,
  startDate,
  endDate,
  accessToken: explicitToken,
}) {
  if (!propertyRef) {
    throw new Error("Missing propertyRef (property ID) for Google Analytics fetch.");
  }

  const range = (startDate && endDate) ? { startDate, endDate } : getDefaultDateRange();

  let accessToken = explicitToken;
  if (!accessToken) {
    if (!userEmail) {
      throw new Error("userEmail or accessToken is required to fetch GA4 performance.");
    }
    const auth = await getGoogleAccessToken(userEmail);
    accessToken = auth.accessToken;
  }

  // 1. Fetch Daily Traffic & Engagement Totals
  let dailyData = null;
  try {
    dailyData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "newUsers" },
        { name: "screenPageViews" },
        { name: "engagementRate" },
        { name: "userEngagementDuration" },
        { name: "bounceRate" },
      ],
    });
  } catch (err) {
    console.warn("[GA4 Fetch] Extended traffic metrics failed, attempting standard metrics:", err.message);
    // Fallback without userEngagementDuration/engagementRate if unsupported on property
    dailyData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "screenPageViews" },
        { name: "bounceRate" },
      ],
    });
  }

  // 2. Fetch E-Commerce Daily Totals (Safely separated with fallback)
  let ecommerceData = null;
  let ecommerceConfigured = false;
  try {
    ecommerceData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "ecommercePurchases" },
        { name: "purchaseRevenue" },
        { name: "itemsAddedToCart" },
        { name: "itemsCheckedOut" },
        { name: "itemsViewed" },
      ],
    });
    // Check if any positive value exists in the entire range
    if (ecommerceData?.rows && ecommerceData.rows.length > 0) {
      const hasAnyActivity = ecommerceData.rows.some((row) =>
        row.metricValues.some((v) => Number(v.value || 0) > 0)
      );
      if (hasAnyActivity) {
        ecommerceConfigured = true;
      }
    }
  } catch (ecomErr) {
    console.warn(`[GA4 Fetch] Native ecommerce metrics not available for ${propertyRef}:`, ecomErr.message);
    ecommerceData = null;
  }

  // 3. Fetch Conversion & E-Commerce Events Breakdown by date
  let eventsData = null;
  try {
    eventsData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [
        { name: "date" },
        { name: "eventName" },
      ],
      metrics: [
        { name: "eventCount" },
        { name: "eventValue" },
      ],
      limit: 2500,
    });
  } catch (err) {
    console.warn(`[GA4 Fetch] Failed to fetch event breakdown for ${propertyRef}:`, err.message);
  }

  // 4. Fetch Traffic Sources with Campaign & Landing Page Breakdown
  let trafficSourcesData = null;
  try {
    trafficSourcesData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [
        { name: "date" },
        { name: "sessionSource" },
        { name: "sessionMedium" },
        { name: "sessionCampaignName" },
      ],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
      ],
      limit: 2500,
    });
  } catch (err) {
    // Fallback without campaign dimension
    try {
      trafficSourcesData = await runGa4Report(accessToken, propertyRef, {
        dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
        dimensions: [
          { name: "date" },
          { name: "sessionSource" },
          { name: "sessionMedium" },
        ],
        metrics: [
          { name: "sessions" },
          { name: "totalUsers" },
        ],
        limit: 2500,
      });
    } catch (e) {
      console.warn(`[GA4 Fetch] Failed to fetch traffic sources for ${propertyRef}:`, e.message);
    }
  }

  // 5. Fetch Landing Pages Breakdown
  let landingPagesData = null;
  try {
    landingPagesData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [
        { name: "date" },
        { name: "landingPagePlusQueryString" },
      ],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "screenPageViews" },
        { name: "bounceRate" },
      ],
      limit: 2500,
    });
  } catch (err) {
    console.warn(`[GA4 Fetch] landingPagePlusQueryString unavailable, falling back to pagePath:`, err.message);
    try {
      landingPagesData = await runGa4Report(accessToken, propertyRef, {
        dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
        dimensions: [
          { name: "date" },
          { name: "pagePath" },
        ],
        metrics: [
          { name: "screenPageViews" },
          { name: "sessions" },
        ],
        limit: 2500,
      });
    } catch (e) {
      console.warn(`[GA4 Fetch] Failed to fetch page data for ${propertyRef}:`, e.message);
    }
  }

  // 6. Fetch Device & Country Breakdown
  let deviceGeoData = null;
  try {
    deviceGeoData = await runGa4Report(accessToken, propertyRef, {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [
        { name: "date" },
        { name: "deviceCategory" },
        { name: "country" },
      ],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
      ],
      limit: 2500,
    });
  } catch (err) {
    console.warn(`[GA4 Fetch] Failed to fetch device/geo breakdown for ${propertyRef}:`, err.message);
  }

  const reportComplete = (report, cap=Infinity) => Boolean(report) && (report.rows || []).length < cap &&
    (!report.rowCount || report.rowCount <= (report.rows || []).length) && !report.metadata?.subjectToThresholding && !report.metadata?.dataLossFromOtherRow && !(report.metadata?.samplingMetadatas?.length);
  const metric = (report,row,name,index) => {
    const actual=report.metricHeaders?.length ? report.metricHeaders.findIndex(h=>h.name===name) : index;
    const value=actual<0?undefined:row.metricValues[actual]?.value;
    if(value===undefined || value===null || value==='')return null;
    const number=Number(value);return Number.isFinite(number)&&(number>=0||name==='purchaseRevenue')?number:null;
  };
  const ecommerceComplete=reportComplete(ecommerceData);
  // ── Index Breakdown Data by Normalized Date (YYYY-MM-DD) ───────────────────
  const ecomByDate = {};
  if (ecommerceData?.rows) {
    ecommerceData.rows.forEach((r) => {
      const d = parseGa4Date(r.dimensionValues[0]?.value);
      ecomByDate[d] = {
        purchases: metric(ecommerceData,r,'ecommercePurchases',0),
        revenue: metric(ecommerceData,r,'purchaseRevenue',1),
        itemsAddedToCart: metric(ecommerceData,r,'itemsAddedToCart',2),
        itemsCheckedOut: metric(ecommerceData,r,'itemsCheckedOut',3),
        itemsViewed: metric(ecommerceData,r,'itemsViewed',4),
      };
    });
  }

  const eventsByDate = {};
  if (eventsData?.rows) {
    eventsData.rows.forEach((r) => {
      const d = parseGa4Date(r.dimensionValues[0]?.value);
      const eventName = r.dimensionValues[1]?.value || "unknown";
      const eventCount = Number(r.metricValues[0]?.value) || 0;
      const eventValue = Number(r.metricValues[1]?.value) || 0;

      if (!eventsByDate[d]) eventsByDate[d] = [];
      eventsByDate[d].push({ eventName, eventCount, eventValue });

      // If standard ecommerce events exist, mark ecommerce as configured
      if (["purchase", "add_to_cart", "begin_checkout", "view_item"].includes(eventName) && eventCount > 0) {
        ecommerceConfigured = true;
      }
    });
  }

  const sourcesByDate = {};
  const aiReferralsByDate = {};
  if (trafficSourcesData?.rows) {
    trafficSourcesData.rows.forEach((r) => {
      const d = parseGa4Date(r.dimensionValues[0]?.value);
      const source = r.dimensionValues[1]?.value || "(direct)";
      const medium = r.dimensionValues[2]?.value || "(none)";
      const campaign = r.dimensionValues[3]?.value || "(not set)";
      const sessions = Number(r.metricValues[0]?.value) || 0;
      const users = Number(r.metricValues[1]?.value) || 0;

      if (!sourcesByDate[d]) sourcesByDate[d] = [];
      sourcesByDate[d].push({
        source,
        medium,
        channel: `${source} / ${medium}`,
        campaign,
        sessions,
        users,
      });

      // Deterministic AI referral verification
      const aiCheck = classifyAiReferral(source, medium);
      if (aiCheck.isAi && sessions > 0) {
        if (!aiReferralsByDate[d]) aiReferralsByDate[d] = [];
        aiReferralsByDate[d].push({
          source,
          medium,
          platform: aiCheck.platform,
          sessions,
          users,
        });
      }
    });
  }

  const landingPagesByDate = {};
  if (landingPagesData?.rows) {
    landingPagesData.rows.forEach((r) => {
      const d = parseGa4Date(r.dimensionValues[0]?.value);
      const pagePath = r.dimensionValues[1]?.value || "/";
      const sessions = Number(r.metricValues[0]?.value) || 0;
      const users = Number(r.metricValues[1]?.value) || 0;
      const pageViews = Number(r.metricValues[2]?.value) || 0;
      const bounceRate = Number(r.metricValues[3]?.value || 0);

      if (!landingPagesByDate[d]) landingPagesByDate[d] = [];
      landingPagesByDate[d].push({
        page: pagePath,
        pagePath,
        sessions,
        users,
        pageViews,
        bounceRate: Number(bounceRate.toFixed(4)),
      });
    });
  }

  const devicesByDate = {};
  const countriesByDate = {};
  if (deviceGeoData?.rows) {
    deviceGeoData.rows.forEach((r) => {
      const d = parseGa4Date(r.dimensionValues[0]?.value);
      const device = r.dimensionValues[1]?.value || "desktop";
      const country = r.dimensionValues[2]?.value || "Unknown";
      const sessions = Number(r.metricValues[0]?.value) || 0;
      const users = Number(r.metricValues[1]?.value) || 0;

      if (!devicesByDate[d]) devicesByDate[d] = {};
      devicesByDate[d][device] = (devicesByDate[d][device] || 0) + sessions;

      if (!countriesByDate[d]) countriesByDate[d] = {};
      countriesByDate[d][country] = (countriesByDate[d][country] || 0) + sessions;
    });
  }

  // ── Build Normalized Daily Snapshots ───────────────────────────────────────
  const snapshots = [];
  const dailyRows = dailyData?.rows || [];

  if (dailyRows.length > 0) {
    for (const r of dailyRows) {
      const dateStr = parseGa4Date(r.dimensionValues[0]?.value);
      const extended=r.metricValues.length>4;
      const sessions=metric(dailyData,r,'sessions',0),totalUsers=metric(dailyData,r,'totalUsers',1);
      const newUsers=metric(dailyData,r,'newUsers',extended?2:-1);
      const pageViews=metric(dailyData,r,'screenPageViews',extended?3:2);
      const engagementRate=metric(dailyData,r,'engagementRate',extended?4:-1);
      const userEngagementDuration=metric(dailyData,r,'userEngagementDuration',extended?5:-1);
      const bounceRate=metric(dailyData,r,'bounceRate',extended?6:3);
      const returningUsers=null; // Daily unique users minus new users is not a returning-user metric.

      // Merge E-Commerce Metrics
      const ecom = ecomByDate[dateStr] || null;
      const dayEvents = eventsByDate[dateStr] || [];

      // Missing/failed ecommerce reports are unknown, never an eventValue/revenue substitute.
      const value=name=>ecommerceComplete ? (ecom ? ecom[name] : 0) : null;
      const viewItemCount=value('itemsViewed'),addToCartCount=value('itemsAddedToCart'),checkoutCount=value('itemsCheckedOut'),purchaseCount=value('purchases'),revenue=value('revenue');

      // Native counts are item quantities, not checkout/add-to-cart events. No inferred conversion rate.
      const addToCartRate=null,checkoutRate=null,purchaseConversionRate=null,checkoutToPurchaseRate=null;

      const trafficSources = (sourcesByDate[dateStr] || []).sort((a, b) => b.sessions - a.sessions);
      const aiReferrals = (aiReferralsByDate[dateStr] || []).sort((a, b) => b.sessions - a.sessions);
      const landingPages = (landingPagesByDate[dateStr] || []).sort((a, b) => b.sessions - a.sessions);
      const events = dayEvents.sort((a, b) => b.eventCount - a.eventCount);

      const deviceBreakdown = Object.entries(devicesByDate[dateStr] || {}).map(([device, sess]) => ({ device, sessions: sess })).sort((a, b) => b.sessions - a.sessions);
      const geoBreakdown = Object.entries(countriesByDate[dateStr] || {}).map(([country, sess]) => ({ country, sessions: sess })).sort((a, b) => b.sessions - a.sessions);

      snapshots.push({
        provider: "google_analytics",
        propertyRef,
        date: dateStr,
        metrics: {
          sessions,
          users: totalUsers,
          totalUsers,
          newUsers,
          returningUsers,
          pageViews,
          engagementRate,
          averageEngagementTime: sessions > 0 && userEngagementDuration!==null ? Number((userEngagementDuration / sessions).toFixed(1)) : null,
          bounceRate,
          // E-Commerce Core Metrics (null when unconfigured/unavailable)
          ecommerceConfigured,
          funnelUnits: "items",
          viewItemCount: ecommerceConfigured ? viewItemCount : null,
          addToCartCount: ecommerceConfigured ? addToCartCount : null,
          checkoutCount: ecommerceConfigured ? checkoutCount : null,
          purchaseCount: ecommerceConfigured ? purchaseCount : null,
          revenue: ecommerceConfigured ? revenue : null,
          currencyCode: ecommerceData?.metadata?.currencyCode || null,
          // Funnel Conversion Rates (%)
          addToCartRate,
          checkoutRate,
          purchaseConversionRate,
          checkoutToPurchaseRate,
          // Legacy backwards-compatibility
          conversions: purchaseCount,
        },
        dimensions: {
          trafficSources: trafficSources.slice(0, 50),
          aiReferrals,
          landingPages: landingPages.slice(0, 50),
          pages: landingPages.slice(0, 50),
          events: events.slice(0, 50),
          devices: deviceBreakdown,
          countries: geoBreakdown.slice(0, 20),
        },
      });
    }
  }

  // Sort chronological ascending
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  for (const snapshot of snapshots) snapshot.dataQuality={daily:reportComplete(dailyData),dimensions:{
    trafficSources:reportComplete(trafficSourcesData,2500) && snapshot.dimensions.trafficSources.length<50,
    landingPages:reportComplete(landingPagesData,2500) && snapshot.dimensions.landingPages.length<50,
    pages:reportComplete(landingPagesData,2500) && snapshot.dimensions.pages.length<50,
    events:reportComplete(eventsData,2500) && snapshot.dimensions.events.length<50,
    devices:reportComplete(deviceGeoData,2500)},
    warnings:!ecommerceComplete || !reportComplete(eventsData,2500) || !reportComplete(trafficSourcesData,2500) || !reportComplete(landingPagesData,2500) || !reportComplete(deviceGeoData,2500) ? ['GA4 optional evidence incomplete'] : []};
  return snapshots;
}

module.exports = {
  fetchGa4Performance,
  getDefaultDateRange,
  formatDate,
  classifyAiReferral,
};
