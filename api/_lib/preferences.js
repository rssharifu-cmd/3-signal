/**
 * Sharflow — User-Controlled Monitoring Preferences
 *
 * Defines the user-controlled monitoring categories and options across:
 * - GA4 / Store Performance
 * - Google Search Console
 * - Bing Webmaster
 * - Website / Technical Health
 *
 * Provides normalization for backward compatibility with legacy profiles.
 */

const MONITORING_CATEGORIES = [
  {
    id: "ga4",
    name: "GA4 / Store Performance",
    provider: "google_analytics",
    description: "Shopper conversion, traffic, funnel progression & store revenue",
    options: [
      "Sales & Revenue",
      "Orders / Purchases",
      "Visitors & Traffic",
      "Traffic Sources / Campaigns",
      "Shopping Funnel",
      "Landing Pages",
      "Engagement",
      "Device / Country",
      "Verified AI / Referral Traffic",
    ],
  },
  {
    id: "gsc",
    name: "Google Search Console",
    provider: "google_search_console",
    description: "Organic search visibility, rankings, impressions & indexing",
    options: [
      "Search clicks & impressions",
      "Search queries",
      "Top pages",
      "Search position",
      "Indexing problems",
      "Search traffic changes",
    ],
  },
  {
    id: "bing",
    name: "Bing Webmaster",
    provider: "bing_webmaster",
    description: "Bing & Microsoft Copilot search queries, crawling & indexing",
    options: [
      "Clicks & impressions",
      "Search queries",
      "Top pages",
      "Crawl problems",
      "Indexing problems",
    ],
  },
  {
    id: "technical",
    name: "Website / Technical",
    provider: "technical",
    description: "Availability, priority landing pages & technical alerts",
    options: [
      "Website availability",
      "Important page problems",
      "Technical/indexing alerts",
    ],
  },
];

const ECOMMERCE_DEFAULT_PRIORITIES = [
  "Sales & Revenue",
  "Orders / Purchases",
  "Visitors & Traffic",
  "Traffic Sources / Campaigns",
  "Shopping Funnel",
];

const GENERAL_DEFAULT_PRIORITIES = [
  "Visitors & Traffic",
  "Search clicks & impressions",
  "Search traffic changes",
  "Important page problems",
  "Website availability",
];

const ALL_VALID_OPTIONS = MONITORING_CATEGORIES.flatMap((c) => c.options);

const LEGACY_PRIORITY_MAP = {
  "Search visibility": ["Search clicks & impressions", "Search position"],
  "Traffic changes": ["Visitors & Traffic", "Search traffic changes"],
  "Important pages": ["Top pages", "Important page problems", "Landing Pages"],
  "Technical / indexing problems": ["Indexing problems", "Crawl problems", "Technical/indexing alerts"],
  "Leads / conversions": ["Orders / Purchases", "Sales & Revenue", "Shopping Funnel"],
  "Content opportunities": ["Search queries", "Top pages"],
  "Pricing Page Conversions": ["Orders / Purchases", "Shopping Funnel"],
  "Organic Search Rankings": ["Search position", "Search queries"],
};

/**
 * Checks if a given website type corresponds to an e-commerce store.
 * @param {string} websiteType
 * @returns {boolean}
 */
function isEcommerceWebsite(websiteType = "") {
  const t = String(websiteType || "").toLowerCase();
  return t.includes("e-commerce") || t.includes("ecommerce") || t.includes("store") || t.includes("shop");
}

/**
 * Normalizes user-supplied or saved monitoring priorities into valid modern categories.
 * Preserves backward compatibility for users with legacy priority strings.
 *
 * @param {Array<string>} priorities
 * @param {string} [websiteType]
 * @returns {Array<string>}
 */
function normalizeMonitoringPreferences(priorities, websiteType = "") {
  if (!Array.isArray(priorities) || priorities.length === 0) {
    return isEcommerceWebsite(websiteType)
      ? [...ECOMMERCE_DEFAULT_PRIORITIES]
      : [...GENERAL_DEFAULT_PRIORITIES];
  }

  // If user selected legacy "All important changes", expand appropriately
  if (priorities.includes("All important changes")) {
    if (isEcommerceWebsite(websiteType)) {
      return Array.from(new Set([
        ...ECOMMERCE_DEFAULT_PRIORITIES,
        "Landing Pages",
        "Engagement",
        "Verified AI / Referral Traffic",
        "Search clicks & impressions",
        "Search traffic changes",
        "Important page problems",
        "Technical/indexing alerts",
      ]));
    }
    return [...ALL_VALID_OPTIONS];
  }

  const normalized = new Set();

  for (const item of priorities) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();

    // Check if directly matches one of the new 23 valid options
    if (ALL_VALID_OPTIONS.includes(trimmed)) {
      normalized.add(trimmed);
      continue;
    }

    // Check legacy translation map
    if (LEGACY_PRIORITY_MAP[trimmed]) {
      LEGACY_PRIORITY_MAP[trimmed].forEach((opt) => normalized.add(opt));
      continue;
    }

    // Heuristic fallbacks for freeform priorities
    const lower = trimmed.toLowerCase();
    if (lower.includes("revenue") || lower.includes("sales")) normalized.add("Sales & Revenue");
    if (lower.includes("order") || lower.includes("purchase") || lower.includes("conversion")) normalized.add("Orders / Purchases");
    if (lower.includes("funnel") || lower.includes("cart") || lower.includes("checkout")) normalized.add("Shopping Funnel");
    if (lower.includes("visitor") || lower.includes("traffic")) normalized.add("Visitors & Traffic");
    if (lower.includes("source") || lower.includes("campaign")) normalized.add("Traffic Sources / Campaigns");
    if (lower.includes("ai") || lower.includes("chatgpt") || lower.includes("referral")) normalized.add("Verified AI / Referral Traffic");
    if (lower.includes("ranking") || lower.includes("position")) normalized.add("Search position");
    if (lower.includes("query") || lower.includes("keyword")) normalized.add("Search queries");
    if (lower.includes("index") || lower.includes("crawl")) normalized.add("Indexing problems");
    if (lower.includes("page")) normalized.add("Top pages");
  }

  if (normalized.size === 0) {
    return isEcommerceWebsite(websiteType)
      ? [...ECOMMERCE_DEFAULT_PRIORITIES]
      : [...GENERAL_DEFAULT_PRIORITIES];
  }

  return Array.from(normalized);
}

/**
 * Mapping from finding types to corresponding user-controlled monitoring options.
 */
const FINDING_CATEGORY_MAP = {
  // GA4 / Store Performance
  ecommerce_revenue_drop: ["Sales & Revenue"],
  checkout_to_purchase_drop: ["Orders / Purchases", "Shopping Funnel"],
  add_to_cart_drop: ["Shopping Funnel"],
  conversion_drop: ["Orders / Purchases", "Shopping Funnel"],
  traffic_source_shift: ["Traffic Sources / Campaigns"],
  verified_ai_referral_shift: ["Verified AI / Referral Traffic", "Traffic Sources / Campaigns"],
  landing_page_engagement_drop: ["Landing Pages", "Important page problems"],
  organic_traffic_drop: ["Visitors & Traffic", "Search traffic changes", "Search clicks & impressions"],

  // Google Search Console
  ranking_position_drop: ["Search position", "Search queries"],
  ctr_opportunity: ["Search clicks & impressions", "Search queries"],
  new_page_traction: ["Top pages", "Visitors & Traffic"],
  page_not_indexed: ["Indexing problems", "Important page problems", "Technical/indexing alerts"],
  mobile_usability_issue: ["Technical/indexing alerts", "Important page problems"],
  low_search_visibility_baseline: ["Search clicks & impressions", "Clicks & impressions"],

  // Bing Webmaster
  bing_organic_click_drop: ["Clicks & impressions", "Search traffic changes"],
  bing_organic_traffic_drop: ["Clicks & impressions", "Search traffic changes"],
  bing_crawl_issues: ["Crawl problems", "Technical/indexing alerts", "Indexing problems"],
};

/**
 * Checks whether an anomaly finding aligns with a user's selected preferences.
 * CRITICAL RULE: Critical findings always match so critical store alerts are never hidden.
 *
 * @param {object} finding
 * @param {Array<string>} userPreferences
 * @returns {boolean}
 */
function matchesUserPreferences(finding, userPreferences) {
  if (!finding) return false;
  // Critical issues always surface to ensure safety
  if (finding.severity === "critical") return true;

  if (!Array.isArray(userPreferences) || userPreferences.length === 0) {
    return true;
  }

  const findingType = finding.type || "";
  const mappedOptions = FINDING_CATEGORY_MAP[findingType] || [];

  return mappedOptions.some((opt) => userPreferences.includes(opt));
}

module.exports = {
  MONITORING_CATEGORIES,
  ECOMMERCE_DEFAULT_PRIORITIES,
  GENERAL_DEFAULT_PRIORITIES,
  ALL_VALID_OPTIONS,
  isEcommerceWebsite,
  normalizeMonitoringPreferences,
  FINDING_CATEGORY_MAP,
  matchesUserPreferences,
};
