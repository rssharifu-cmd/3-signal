/**
 * Sharflow — Deterministic Anomaly Detection Engine
 *
 * Scans metric snapshots and historical comparison windows (1d, 7d, 28d)
 * using deterministic statistical heuristics (pure code, NO LLM calls).
 *
 * Detects:
 * 1. organic_traffic_drop   — Significant drop in organic clicks/sessions
 * 2. ranking_position_drop  — Position degradation on top or important queries/pages
 * 3. ctr_opportunity        — High impressions & top ranking, but underperforming CTR
 * 4. new_page_traction      — Previously quiet page seeing sustained growth
 * 5. conversion_drop        — Significant decline in GA4 conversions / key events
 * 6. traffic_source_shift   — Abnormal channel redistribution or loss
 *
 * Anti-Flapping & Noise Floor Rules:
 * - Minimum absolute thresholds (noise floors) prevent small-sample percentages from firing.
 * - Sustained change across multiple days required; single-day blips are discarded.
 * - Returns [] if no findings clear the confidence threshold (>= 0.70).
 */

const crypto = require("crypto");

const CONFIDENCE_THRESHOLD = 0.70;

// Noise floors (minimum absolute volume in prior window)
const NOISE_FLOORS = {
  gscClicks7d: 35,
  gscImpressions7d: 150,
  ga4Sessions7d: 50,
  ga4Conversions7d: 10,
  queryImpressions7d: 80,
  pageImpressions7d: 100,
  channelSessions7d: 40,
};

/**
 * Checks if a metric drop was sustained across multiple days in a 7-day window.
 * Requires at least 4 of 7 days to be below the prior daily average.
 * @param {Array<object>} dailySeries
 * @param {string} metricName
 * @param {number} priorDailyAvg
 * @returns {{ sustained: boolean, daysBelow: number }}
 */
function verifySustainedDrop(dailySeries, metricName, priorDailyAvg) {
  if (!dailySeries || dailySeries.length < 4) {
    return { sustained: false, daysBelow: 0 };
  }
  let daysBelow = 0;
  for (const day of dailySeries) {
    const val = day.metrics?.[metricName] || 0;
    if (val < priorDailyAvg * 0.90) { // At least 10% below prior daily average
      daysBelow++;
    }
  }
  return {
    sustained: daysBelow >= Math.min(4, Math.ceil(dailySeries.length * 0.6)),
    daysBelow,
  };
}

/**
 * Checks if a metric gain was sustained across multiple days in a 7-day window.
 * @param {Array<object>} dailySeries
 * @param {string} metricName
 * @param {number} threshold
 * @returns {{ sustained: boolean, activeDays: number }}
 */
function verifySustainedGain(dailySeries, metricName, threshold = 1) {
  if (!dailySeries || dailySeries.length === 0) {
    return { sustained: false, activeDays: 0 };
  }
  let activeDays = 0;
  for (const day of dailySeries) {
    const val = day.metrics?.[metricName] || 0;
    if (val >= threshold) {
      activeDays++;
    }
  }
  return {
    sustained: activeDays >= 3,
    activeDays,
  };
}

/**
 * Generates a stable unique finding ID.
 * @param {string} type
 * @param {string} scope
 * @param {string} subject
 * @returns {string}
 */
function makeFindingId(type, scope, subject) {
  const hash = crypto.createHash("md5").update(`${type}:${scope}:${subject}`).digest("hex").slice(0, 10);
  return `finding_${type}_${hash}`;
}

/**
 * Normalizes URL paths for matching.
 * @param {string} url
 * @returns {string}
 */
function cleanPath(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://example.com${url.startsWith("/") ? "" : "/"}${url}`);
    return parsed.pathname.toLowerCase().replace(/\/$/, "");
  } catch {
    return url.toLowerCase().trim();
  }
}

/**
 * Scans comparison windows across all connected providers for anomalies.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.userEmail]
 * @param {object} params.comparisonWindows - Map of provider -> comparison windows object
 * @param {object} [params.userProfile] - User profile with importantPages, websiteUrl, etc.
 * @param {string} [params.targetDate]
 * @returns {Array<object>} Array of structured findings clearing confidence threshold
 */
function detectAnomalies({ userId, userEmail, comparisonWindows = {}, userProfile = {}, targetDate }) {
  const findings = [];
  const detectedAt = new Date();

  // Extract user priorities and designated important pages
  const importantPagesList = (userProfile.importantPages || []).map((p) => cleanPath(typeof p === "string" ? p : p.url || p.path));

  // ──────────────────────────────────────────────────────────────────────────
  // 1. GOOGLE SEARCH CONSOLE ANOMALIES
  // ──────────────────────────────────────────────────────────────────────────
  const gscWin = comparisonWindows.google_search_console || comparisonWindows.gsc;
  if (gscWin) {
    const w7d = gscWin.last7_vs_prior7;
    if (w7d && w7d.priorMetrics && w7d.currentMetrics) {
      const priorClicks = w7d.priorMetrics.clicks || 0;
      const currClicks = w7d.currentMetrics.clicks || 0;
      const clickDiff = w7d.changes.clicks;
      const priorDailyAvgClicks = priorClicks / 7;

      // 1A. Significant Site-Wide Organic Click Drop
      if (priorClicks >= NOISE_FLOORS.gscClicks7d && clickDiff.percent <= -20.0) {
        const sustainedCheck = verifySustainedDrop(w7d.dailySeries, "clicks", priorDailyAvgClicks);
        if (sustainedCheck.sustained) {
          const isCritical = clickDiff.percent <= -40.0;
          const confidence = Math.min(0.95, 0.75 + (Math.abs(clickDiff.percent) / 200) + (priorClicks > 200 ? 0.1 : 0.05));

          findings.push({
            id: makeFindingId("organic_traffic_drop", "site", "gsc_clicks"),
            userId,
            type: "organic_traffic_drop",
            severity: isCritical ? "critical" : "warning",
            confidence: Number(confidence.toFixed(2)),
            scope: "site",
            evidence: {
              metric: "clicks",
              provider: "google_search_console",
              currentValue: currClicks,
              priorValue: priorClicks,
              absoluteChange: clickDiff.absolute,
              changePercent: clickDiff.percent,
              window: "last7_vs_prior7",
              sustainedDays: sustainedCheck.daysBelow,
              context: `Organic Google search clicks dropped ${Math.abs(clickDiff.percent)}% over the last 7 days (${currClicks} vs ${priorClicks} prior). The drop was sustained across ${sustainedCheck.daysBelow} of the 7 days.`,
            },
            detectedAt,
          });
        }
      }

      // 1B. Page-Level Drop on Important / Top Pages
      const currPages = w7d.currentDimensions?.pages || [];
      const priorPages = w7d.priorDimensions?.pages || [];
      const priorPageMap = new Map(priorPages.map((p) => [p.page, p]));

      for (const currP of currPages) {
        const priorP = priorPageMap.get(currP.page);
        if (!priorP) continue;

        const pPriorClicks = priorP.clicks || 0;
        const pCurrClicks = currP.clicks || 0;
        const pClickPct = pPriorClicks > 0 ? ((pCurrClicks - pPriorClicks) / pPriorClicks) * 100 : 0;
        const isDesignatedImportant = importantPagesList.some((ip) => ip && cleanPath(currP.page).includes(ip));

        // Noise floor for single page drop: at least 20 prior clicks (or 10 if designated important)
        const minClicks = isDesignatedImportant ? 10 : 20;

        if (pPriorClicks >= minClicks && pClickPct <= -30.0) {
          const confidence = Number((0.72 + (isDesignatedImportant ? 0.15 : 0.05) + Math.min(0.1, pPriorClicks / 500)).toFixed(2));
          findings.push({
            id: makeFindingId("organic_traffic_drop", "page", currP.page),
            userId,
            type: "organic_traffic_drop",
            severity: (pClickPct <= -50.0 || isDesignatedImportant) ? "critical" : "warning",
            confidence,
            scope: "page",
            evidence: {
              subject: currP.page,
              isDesignatedImportant,
              metric: "clicks",
              provider: "google_search_console",
              currentValue: pCurrClicks,
              priorValue: pPriorClicks,
              absoluteChange: pCurrClicks - pPriorClicks,
              changePercent: Number(pClickPct.toFixed(2)),
              window: "last7_vs_prior7",
              context: `Page ${currP.page} lost ${pPriorClicks - pCurrClicks} organic clicks (${Math.abs(pClickPct).toFixed(1)}% drop).${isDesignatedImportant ? " This is one of your designated priority pages." : ""}`,
            },
            detectedAt,
          });
        }
      }

      // 1C. Ranking Position Drop on Top Queries & Pages
      const currQueries = w7d.currentDimensions?.queries || [];
      const priorQueries = w7d.priorDimensions?.queries || [];
      const priorQueryMap = new Map(priorQueries.map((q) => [q.query, q]));

      for (const currQ of currQueries) {
        const priorQ = priorQueryMap.get(currQ.query);
        if (!priorQ) continue;

        const priorPos = priorQ.position || 0;
        const currPos = currQ.position || 0;
        const priorImp = priorQ.impressions || 0;

        // Check significant position drop (fell by >= 3.0 spots, higher number means worse rank)
        if (priorImp >= NOISE_FLOORS.queryImpressions7d && priorPos > 0 && currPos > 0) {
          const posDiff = currPos - priorPos; // Positive means position worsened
          if (posDiff >= 3.0) {
            const fellOffPageOne = priorPos <= 10.0 && currPos > 10.0;
            const confidence = Number((0.75 + (fellOffPageOne ? 0.12 : 0.05) + Math.min(0.08, priorImp / 1000)).toFixed(2));

            findings.push({
              id: makeFindingId("ranking_position_drop", "query", currQ.query),
              userId,
              type: "ranking_position_drop",
              severity: fellOffPageOne ? "critical" : "warning",
              confidence,
              scope: "query",
              evidence: {
                subject: currQ.query,
                metric: "position",
                provider: "google_search_console",
                currentPosition: currPos,
                priorPosition: priorPos,
                positionChange: Number(posDiff.toFixed(1)),
                priorImpressions: priorImp,
                currentImpressions: currQ.impressions || 0,
                fellOffPageOne,
                window: "last7_vs_prior7",
                context: `Search rank for query "${currQ.query}" dropped from position ${priorPos.toFixed(1)} to ${currPos.toFixed(1)} (+${posDiff.toFixed(1)} spots).${fellOffPageOne ? " Query fell off Page 1 of Google." : ""}`,
              },
              detectedAt,
            });
          }
        }
      }

      // 1D. CTR Opportunity (High Impressions & Page 1 Rank, but Underperforming CTR)
      for (const currQ of currQueries) {
        const imp = currQ.impressions || 0;
        const pos = currQ.position || 0;
        const ctr = currQ.ctr || 0;

        // Position 1-10 with at least 150 impressions in 7d
        if (pos > 0 && pos <= 10.0 && imp >= 150) {
          // Expected baseline CTRs
          let underperforming = false;
          let expectedMinCtr = 0;
          if (pos <= 3.0 && ctr < 0.08) { // Pos 1-3 typically gets > 10-25%
            underperforming = true;
            expectedMinCtr = 0.08;
          } else if (pos <= 7.0 && ctr < 0.025) { // Pos 4-7 typically gets > 3-5%
            underperforming = true;
            expectedMinCtr = 0.025;
          } else if (pos <= 10.0 && ctr < 0.015) { // Pos 8-10 typically gets > 2%
            underperforming = true;
            expectedMinCtr = 0.015;
          }

          if (underperforming) {
            const missedClicksEstimate = Math.round(imp * (expectedMinCtr - ctr));
            if (missedClicksEstimate >= 8) {
              findings.push({
                id: makeFindingId("ctr_opportunity", "query", currQ.query),
                userId,
                type: "ctr_opportunity",
                severity: "opportunity",
                confidence: Number((0.72 + Math.min(0.15, imp / 1500)).toFixed(2)),
                scope: "query",
                evidence: {
                  subject: currQ.query,
                  metric: "ctr",
                  provider: "google_search_console",
                  currentCtr: ctr,
                  expectedMinCtr,
                  position: pos,
                  impressions: imp,
                  estimatedMissedClicks: missedClicksEstimate,
                  window: "last7_vs_prior7",
                  context: `Query "${currQ.query}" ranks at position ${pos.toFixed(1)} with ${imp} impressions, but only has ${(ctr * 100).toFixed(2)}% CTR. Improving snippet CTR could yield ~${missedClicksEstimate} additional clicks.`,
                },
                detectedAt,
              });
            }
          }
        }
      }

      // 1E. New Page Gaining Traction
      for (const currP of currPages) {
        const priorP = priorPageMap.get(currP.page);
        const priorClicks = priorP?.clicks || 0;
        const priorImp = priorP?.impressions || 0;
        const currClicks = currP.clicks || 0;
        const currImp = currP.impressions || 0;

        // Page had virtually no traffic before, now has meaningful volume
        if (priorClicks <= 3 && priorImp <= 40 && currClicks >= 20 && currImp >= 120) {
          findings.push({
            id: makeFindingId("new_page_traction", "page", currP.page),
            userId,
            type: "new_page_traction",
            severity: "opportunity",
            confidence: 0.82,
            scope: "page",
            evidence: {
              subject: currP.page,
              metric: "clicks",
              provider: "google_search_console",
              currentClicks: currClicks,
              priorClicks,
              currentImpressions: currImp,
              priorImpressions: priorImp,
              position: currP.position,
              window: "last7_vs_prior7",
              context: `New page ${currP.page} is gaining organic traction: generated ${currClicks} clicks and ${currImp} impressions over the last 7 days (up from ${priorClicks} prior).`,
            },
            detectedAt,
          });
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. GOOGLE ANALYTICS 4 ANOMALIES
  // ──────────────────────────────────────────────────────────────────────────
  const ga4Win = comparisonWindows.google_analytics || comparisonWindows.ga4;
  if (ga4Win) {
    const w7d = ga4Win.last7_vs_prior7;
    if (w7d && w7d.priorMetrics && w7d.currentMetrics) {
      const priorSessions = w7d.priorMetrics.sessions || 0;
      const currSessions = w7d.currentMetrics.sessions || 0;
      const priorConversions = w7d.priorMetrics.conversions || 0;
      const currConversions = w7d.currentMetrics.conversions || 0;
      const sessionDiff = w7d.changes.sessions;
      const convDiff = w7d.changes.conversions;

      // 2A. Conversion Drop in GA4
      if (priorConversions >= NOISE_FLOORS.ga4Conversions7d && convDiff.percent <= -25.0) {
        const sustainedCheck = verifySustainedDrop(w7d.dailySeries, "conversions", priorConversions / 7);
        if (sustainedCheck.sustained) {
          const isCritical = convDiff.percent <= -45.0;
          findings.push({
            id: makeFindingId("conversion_drop", "site", "ga4_conversions"),
            userId,
            type: "conversion_drop",
            severity: isCritical ? "critical" : "warning",
            confidence: Number((0.80 + (isCritical ? 0.1 : 0.05) + Math.min(0.08, priorConversions / 200)).toFixed(2)),
            scope: "site",
            evidence: {
              metric: "conversions",
              provider: "google_analytics",
              currentValue: currConversions,
              priorValue: priorConversions,
              absoluteChange: convDiff.absolute,
              changePercent: convDiff.percent,
              window: "last7_vs_prior7",
              sustainedDays: sustainedCheck.daysBelow,
              context: `Website conversions dropped ${Math.abs(convDiff.percent)}% over the last 7 days (${currConversions} vs ${priorConversions} prior), sustained across ${sustainedCheck.daysBelow} days.`,
            },
            detectedAt,
          });
        }
      }

      // 2B. Unusual Traffic Source Channel Shift
      const currChannels = w7d.currentDimensions?.channels || [];
      const priorChannels = w7d.priorDimensions?.channels || [];
      const priorChannelMap = new Map(priorChannels.map((c) => [c.channel, c]));

      for (const currC of currChannels) {
        const priorC = priorChannelMap.get(currC.channel);
        if (!priorC) continue;

        const pSessions = priorC.sessions || 0;
        const cSessions = currC.sessions || 0;
        const channelShare = priorSessions > 0 ? (pSessions / priorSessions) : 0;

        // Channel must represent at least 10% of prior site traffic and clear noise floor
        if (pSessions >= NOISE_FLOORS.channelSessions7d && channelShare >= 0.10) {
          const pctChange = ((cSessions - pSessions) / pSessions) * 100;

          // Severe channel collapse (>= 35% drop)
          if (pctChange <= -35.0) {
            findings.push({
              id: makeFindingId("traffic_source_shift", "channel", currC.channel),
              userId,
              type: "traffic_source_shift",
              severity: "warning",
              confidence: Number((0.75 + Math.min(0.12, pSessions / 500)).toFixed(2)),
              scope: "channel",
              evidence: {
                subject: currC.channel,
                metric: "sessions",
                provider: "google_analytics",
                currentSessions: cSessions,
                priorSessions: pSessions,
                absoluteChange: cSessions - pSessions,
                changePercent: Number(pctChange.toFixed(2)),
                channelSharePercent: Number((channelShare * 100).toFixed(1)),
                window: "last7_vs_prior7",
                context: `Traffic from channel "${currC.channel}" plunged ${Math.abs(pctChange).toFixed(1)}% (${cSessions} sessions vs ${pSessions} prior). This channel accounts for ${(channelShare * 100).toFixed(1)}% of baseline site traffic.`,
              },
              detectedAt,
            });
          }
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. BING WEBMASTER ANOMALIES
  // ──────────────────────────────────────────────────────────────────────────
  const bingWin = comparisonWindows.bing_webmaster || comparisonWindows.bing;
  if (bingWin) {
    const w7d = bingWin.last7_vs_prior7;
    if (w7d && w7d.priorMetrics && w7d.currentMetrics) {
      const priorErrors = w7d.priorMetrics.crawlErrors || 0;
      const currErrors = w7d.currentMetrics.crawlErrors || 0;
      const priorClicks = w7d.priorMetrics.clicks || 0;
      const currClicks = w7d.currentMetrics.clicks || 0;

      // 3A. Crawl Errors Spike
      if (currErrors >= 5 && (currErrors > priorErrors * 2 || (priorErrors === 0 && currErrors >= 10))) {
        findings.push({
          id: makeFindingId("organic_traffic_drop", "site", "bing_crawl_errors"),
          userId,
          type: "organic_traffic_drop",
          severity: "warning",
          confidence: 0.80,
          scope: "site",
          evidence: {
            metric: "crawlErrors",
            provider: "bing_webmaster",
            currentErrors: currErrors,
            priorErrors,
            window: "last7_vs_prior7",
            context: `Bing Webmaster reported a surge in crawl errors (${currErrors} current vs ${priorErrors} prior).`,
          },
          detectedAt,
        });
      }

      // 3B. Bing Organic Traffic Drop
      if (priorClicks >= 30 && (currClicks - priorClicks) / priorClicks <= -30.0) {
        findings.push({
          id: makeFindingId("organic_traffic_drop", "site", "bing_clicks"),
          userId,
          type: "organic_traffic_drop",
          severity: "warning",
          confidence: 0.74,
          scope: "site",
          evidence: {
            metric: "clicks",
            provider: "bing_webmaster",
            currentClicks: currClicks,
            priorClicks,
            changePercent: Number((((currClicks - priorClicks) / priorClicks) * 100).toFixed(1)),
            window: "last7_vs_prior7",
            context: `Bing organic search clicks decreased by ${Math.abs(Number((((currClicks - priorClicks) / priorClicks) * 100).toFixed(1)))}% (${currClicks} vs ${priorClicks} prior).`,
          },
          detectedAt,
        });
      }
    }
  }

  // Filter findings by confidence threshold
  const verifiedFindings = findings.filter((f) => f.confidence >= CONFIDENCE_THRESHOLD);

  // Sort findings by severity priority: critical -> warning -> opportunity -> info
  const severityRank = { critical: 0, warning: 1, opportunity: 2, info: 3 };
  verifiedFindings.sort((a, b) => {
    const rankDiff = (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99);
    if (rankDiff !== 0) return rankDiff;
    return b.confidence - a.confidence;
  });

  return verifiedFindings;
}

module.exports = {
  detectAnomalies,
  verifySustainedDrop,
  verifySustainedGain,
  CONFIDENCE_THRESHOLD,
  NOISE_FLOORS,
};
