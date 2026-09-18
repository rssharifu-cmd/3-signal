/**
 * Sharflow — AI Interpretation Layer
 *
 * The ONLY place an LLM is called in the Watchdog pipeline.
 *
 * Takes the findings array (which has already been detected and scored by
 * deterministic code) and produces:
 * 1. Plausible-cause explanations
 * 2. Priority ranking (P1-P4)
 * 3. 1-3 concrete recommended actions per finding
 * 4. Executive summary
 * 5. External research context integration (Tavily, RSS, Reddit)
 *
 * CRITICAL DIRECTIVE:
 * - If the findings array is empty, SKIP the AI call entirely and return
 *   a fixed "nothing important changed today" message.
 * - The AI never decides whether something is significant — only explains
 *   and prioritizes findings already flagged by code.
 */

const { GoogleGenAI } = require("@google/genai");

const FIXED_ALL_CLEAR = {
  status: "stable",
  headline: "All systems normal · No significant website changes detected",
  summary: "No significant organic traffic drops, ranking losses, or conversion anomalies were detected across your connected data sources. Website performance and search visibility remain steady.",
  priorityRankedFindings: [],
  recommendedActions: [
    "Continue regular content updates and standard SEO monitoring.",
    "Verify tracking scripts and analytics tags remain healthy.",
  ],
  interpretedAt: new Date(),
  aiCallSkipped: true,
};

/**
 * Fallback deterministic interpreter in case GEMINI_API_KEY is not configured
 * or the AI service experiences temporary connectivity issues.
 * @param {Array<object>} findings
 * @param {object} userContext
 * @param {Array<object>} [externalResearch]
 * @returns {object}
 */
function buildDeterministicInterpretation(findings, userContext, externalResearch = []) {
  const ranked = findings.map((f, idx) => {
    let priorityBadge = "P3 · Medium";
    let priorityRank = idx + 1;
    let plausibleCauses = [];
    let primaryCause = "";
    let recommendedActions = [];

    if (f.severity === "critical") {
      priorityBadge = "P1 · Immediate Action";
    } else if (f.severity === "warning") {
      priorityBadge = "P2 · High Priority";
    } else {
      priorityBadge = "P3 · Opportunity";
    }

    if (f.type === "organic_traffic_drop") {
      plausibleCauses = [
        "Google search algorithm volatility or core update rollout",
        "Recent URL structure, redirect, or canonical tag changes",
        "Indexing or render issues on the page template",
      ];
      primaryCause = "Search engine visibility loss or tracking degradation";
      recommendedActions = [
        {
          action: "Inspect Google Search Console URL Inspection tool for affected URLs",
          detail: "Verify the page is still indexed and has no canonicalization or mobile usability errors.",
          urgency: "immediate",
        },
        {
          action: "Compare date of drop with Google Search Status Dashboard",
          detail: "Check if the drop aligns with a confirmed Google algorithm update.",
          urgency: "this_week",
        },
      ];
    } else if (f.type === "ranking_position_drop") {
      plausibleCauses = [
        "Competitors published newer or more comprehensive content for this query",
        "Title tag or H1 tag changes reduced topical relevance",
        "Internal linking or page authority dilution",
      ];
      primaryCause = "Search result displacement by competing domains";
      recommendedActions = [
        {
          action: "Review top 3 ranking competitors for the query",
          detail: "Identify content gaps, word count differences, or new search intent patterns.",
          urgency: "immediate",
        },
        {
          action: "Strengthen internal links and update key headings",
          detail: "Add links from high-authority pages on your site directly to the affected page.",
          urgency: "this_week",
        },
      ];
    } else if (f.type === "ctr_opportunity") {
      plausibleCauses = [
        "Page title is truncated or lacks compelling value proposition in SERPs",
        "Meta description does not directly address searcher intent",
        "Rich snippets or featured snippets pushing standard organic clicks down",
      ];
      primaryCause = "High impression visibility with lower than expected click-through rate";
      recommendedActions = [
        {
          action: "Rewrite title tag and meta description for higher click intent",
          detail: "Frontload primary keyword and include a clear differentiator or outcome.",
          urgency: "immediate",
        },
      ];
    } else if (f.type === "new_page_traction") {
      plausibleCauses = [
        "Search engine has discovered and begun testing this URL for relevant queries",
        "Fresh backlink or social mention generated initial authority boost",
      ];
      primaryCause = "Emerging search visibility on new or updated content";
      recommendedActions = [
        {
          action: "Add contextual internal links to this emerging page from relevant cornerstone pages",
          detail: "Reinforce authority to sustain and accelerate keyword rankings.",
          urgency: "this_week",
        },
      ];
    } else if (f.type === "conversion_drop") {
      plausibleCauses = [
        "Checkout, lead form, or CTA tracking tag failure in Google Analytics 4",
        "Form submission script error or broken button following recent site update",
        "Page speed regression on high-converting mobile templates",
      ];
      primaryCause = "Tracking failure or user conversion path friction";
      recommendedActions = [
        {
          action: "Submit a live test conversion in GA4 DebugView",
          detail: "Confirm key conversion events (e.g. generate_lead, purchase) are registering in real time.",
          urgency: "immediate",
        },
        {
          action: "Test form functionality and mobile responsiveness across devices",
          detail: "Ensure no JavaScript errors prevent visitors from completing checkout or lead capture.",
          urgency: "immediate",
        },
      ];
    } else {
      plausibleCauses = [
        "Traffic redistribution across channels or external platform changes",
        "Measurement variance or attribution window shift",
      ];
      primaryCause = "Audience acquisition channel variance";
      recommendedActions = [
        {
          action: "Review referral sources and campaign tags",
          detail: "Confirm UTM parameters and tracking tags are firing accurately.",
          urgency: "routine",
        },
      ];
    }

    return {
      findingId: f.id,
      type: f.type,
      severity: f.severity,
      priorityRank,
      priorityBadge,
      title: f.evidence?.context || `${f.type.replace(/_/g, " ")} on ${f.scope}`,
      plausibleCauses,
      primaryCause,
      recommendedActions,
      impactAssessment: `Affects ${f.scope} (${f.evidence?.subject || f.evidence?.metric || "traffic"}).`,
      originalEvidence: f.evidence,
    };
  });

  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;

  return {
    status: criticalCount > 0 ? "critical_attention" : "needs_attention",
    headline: `${findings.length} actionable signal${findings.length > 1 ? "s" : ""} detected across your website`,
    summary: `Watchdog identified ${criticalCount} critical and ${warningCount} notable changes requiring attention. Focus on high-priority ranking and traffic signals first.`,
    priorityRankedFindings: ranked,
    recommendedActions: ranked.flatMap((r) => r.recommendedActions.map((a) => a.action)).slice(0, 3),
    externalResearch: externalResearch || [],
    interpretedAt: new Date(),
    aiCallSkipped: false,
    usedFallback: true,
  };
}

/**
 * Interprets a verified findings array using Gemini Flash via @google/genai.
 *
 * @param {object} params
 * @param {Array<object>} params.findings - Deterministically flagged findings
 * @param {object} [params.userContext] - User profile and website details
 * @param {object} [params.comparisonWindows] - Historical window metrics
 * @param {Array<object>} [params.externalResearch] - External research items (Tavily, RSS, Reddit)
 * @returns {Promise<object>} Structured interpretation report
 */
async function interpretFindings({ findings = [], userContext = {}, comparisonWindows = {}, externalResearch = [] }) {
  // ── STEP 1: ZERO FINDINGS SHORT-CIRCUIT ───────────────────────────────────
  // Strictly avoid calling the LLM if nothing was flagged by code
  if (!Array.isArray(findings) || findings.length === 0) {
    return {
      ...FIXED_ALL_CLEAR,
      interpretedAt: new Date(),
    };
  }

  // ── STEP 2: CHECK FOR GEMINI API KEY ──────────────────────────────────────
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    console.warn("[Intelligence] GEMINI_API_KEY not configured. Using deterministic fallback.");
    return buildDeterministicInterpretation(findings, userContext, externalResearch);
  }

  // ── STEP 3: CALL GEMINI API ───────────────────────────────────────────────
  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });

    const websiteUrl = userContext.profile?.websiteUrl || userContext.websiteUrl || "the website";
    const websiteType = userContext.profile?.websiteType || "Website";

    const prompt = `
You are the AI Website Watchdog analysis engine for Sharflow.
Your role: explain and prioritize findings that code algorithms have already flagged and verified.
DO NOT question or second-guess whether these findings are real. They have already cleared strict statistical noise floors and sustained-change checks.

Website: ${websiteUrl} (${websiteType})
User Priorities: ${JSON.stringify(userContext.profile?.monitoringPriorities || [])}

Verified Code Findings to Interpret (${findings.length} total):
${JSON.stringify(findings, null, 2)}
${externalResearch && externalResearch.length > 0 ? `
External Research & Context (Official Search Central announcements, industry discussions, SERP volatility):
${JSON.stringify(externalResearch, null, 2)}
` : ""}
If external research is provided, incorporate relevant external context (e.g. search updates, competitor movements, community reports) into plausibleCauses and impactAssessment where directly applicable. Never fabricate numbers or sources.

Produce a JSON object matching this exact structure:
{
  "headline": "A concise, professional 6-12 word executive headline summarizing the findings.",
  "summary": "2-3 clear, executive sentences explaining what changed, why it matters, and overall site posture.",
  "overallHealth": "critical | needs_attention | steady",
  "priorityRankedFindings": [
    {
      "findingId": "Exact ID matching the code finding",
      "type": "Exact type matching the code finding",
      "severity": "critical | warning | opportunity | info",
      "priorityRank": 1,
      "priorityBadge": "P1 · Immediate Action | P2 · High Priority | P3 · Moderate | P4 · Opportunity",
      "title": "Clear, readable 1-line title for this issue",
      "primaryCause": "1 sentence identifying the single most probable root cause",
      "plausibleCauses": [
        "Plausible cause 1 (technical SEO, algorithm update, content staleness, etc.)",
        "Plausible cause 2",
        "Plausible cause 3"
      ],
      "recommendedActions": [
        {
          "action": "Specific 1-sentence action item",
          "detail": "Actionable explanation of exactly how to check or fix it",
          "urgency": "immediate | this_week | routine"
        }
      ],
      "impactAssessment": "Concise business impact assessment (lost traffic, revenue risk, or growth potential)"
    }
  ],
  "topThreeNextSteps": [
    "Immediate step 1",
    "Immediate step 2",
    "Immediate step 3"
  ]
}
`.trim();

    let response = null;
    let modelUsed = "gemini-3.6-flash";

    try {
      response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });
    } catch (primaryErr) {
      console.warn("[Intelligence] gemini-3.6-flash primary attempt warning:", primaryErr.message);
      try {
        modelUsed = "gemini-2.5-flash";
        response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
          },
        });
      } catch (fallbackErr) {
        throw primaryErr; // Throw original error to trigger deterministic fallback
      }
    }

    const text = response.text;
    if (!text) {
      throw new Error("Empty response from Gemini API");
    }

    const parsed = JSON.parse(text);

    // Merge original code evidence into each ranked finding to preserve raw data
    const findingMap = new Map(findings.map((f) => [f.id, f]));
    if (Array.isArray(parsed.priorityRankedFindings)) {
      parsed.priorityRankedFindings.forEach((rf) => {
        const original = findingMap.get(rf.findingId);
        if (original) {
          rf.originalEvidence = original.evidence;
          rf.confidence = original.confidence;
          rf.scope = original.scope;
        }
      });
    }

    return {
      status: parsed.overallHealth || "needs_attention",
      headline: parsed.headline,
      summary: parsed.summary,
      priorityRankedFindings: parsed.priorityRankedFindings || [],
      recommendedActions: parsed.topThreeNextSteps || [],
      externalResearch: externalResearch || [],
      interpretedAt: new Date(),
      aiCallSkipped: false,
      modelUsed,
    };
  } catch (err) {
    console.error("[Intelligence Error] Gemini interpretation failed:", err.message);
    // Fall back smoothly to deterministic interpretation
    return buildDeterministicInterpretation(findings, userContext, externalResearch);
  }
}

module.exports = {
  interpretFindings,
  buildDeterministicInterpretation,
  FIXED_ALL_CLEAR,
};
