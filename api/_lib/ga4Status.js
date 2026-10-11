/**
 * Sharflow — Google Analytics 4 Connection Status Verifier
 *
 * Implements server-side status verification for GA4 with three clear states:
 * 1. "connected":
 *    - Valid OAuth token
 *    - Property selected
 *    - Data retrieved successfully
 * 2. "partially_configured":
 *    - GA4 connection works, but requested features (e.g. e-commerce) cannot be verified or lack data
 *    - Explains exactly what is missing
 *    - General traffic monitoring remains available
 * 3. "action_required":
 *    - Confirmed problem: missing property, revoked token, missing permissions, or persistent failure
 *
 * Special protections:
 * - Distinguishes "No data yet" from tracking failure. Zero traffic alone NEVER triggers an error.
 * - Distinguishes zero purchases from broken e-commerce tracking.
 * - Handles temporary API errors (500/503) separately from configuration errors.
 * - Caches results to prevent excessive Google Analytics API requests.
 */

const { getDb } = require("./db");
const { decryptToken } = require("./cryptoUtils");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GA4_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
const GA4_SCOPE_REQUIRED = "https://www.googleapis.com/auth/analytics.readonly";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

/**
 * Checks if a user profile requests e-commerce monitoring.
 * @param {object} profile
 * @returns {boolean}
 */
function isEcommerceRequested(profile = {}) {
  const priorities = Array.isArray(profile.monitoringPriorities) ? profile.monitoringPriorities : [];
  const type = String(profile.websiteType || "").toLowerCase();
  const purpose = String(profile.websitePurpose || "").toLowerCase();

  if (type.includes("e-commerce") || type.includes("ecommerce") || type.includes("store") || type.includes("shop")) {
    return true;
  }
  if (purpose.includes("sell products")) {
    return true;
  }
  return priorities.some((p) =>
    ["Sales & Revenue", "Orders / Purchases", "Shopping Funnel"].includes(p)
  );
}

/**
 * Executes a probe query against the GA4 Data API runReport endpoint.
 * @param {string} accessToken
 * @param {string} propertyId
 * @param {object} reportBody
 * @param {Function} [fetchFn]
 * @returns {Promise<{ ok: boolean, status: number, data?: object, error?: string, isTemporary?: boolean }>}
 */
async function probeGa4Api(accessToken, propertyId, reportBody, fetchFn = global.fetch) {
  const propPath = propertyId.startsWith("properties/") ? propertyId : `properties/${propertyId}`;
  const url = `${GA4_DATA_BASE}/${propPath}:runReport`;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reportBody),
    });

    if (res.status === 403) {
      const text = await res.text();
      let msg = "Permission denied for this GA4 property.";
      try {
        const j = JSON.parse(text);
        if (j.error?.message) msg = j.error.message;
      } catch {}
      return { ok: false, status: 403, error: msg };
    }

    if (res.status === 404) {
      return { ok: false, status: 404, error: "GA4 property not found or deleted." };
    }

    if (res.status >= 500) {
      return {
        ok: false,
        status: res.status,
        error: `Google Analytics API temporary error (HTTP ${res.status}).`,
        isTemporary: true,
      };
    }

    if (!res.ok) {
      const text = await res.text();
      let msg = `GA4 API returned HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        if (j.error?.message) msg = j.error.message;
      } catch {}
      return { ok: false, status: res.status, error: msg };
    }

    const data = await res.json();
    return { ok: true, status: 200, data };
  } catch (netErr) {
    return {
      ok: false,
      status: 0,
      error: `Network error reaching Google Analytics API: ${netErr.message}`,
      isTemporary: true,
    };
  }
}

/**
 * Refreshes Google access token using stored refresh token.
 * Detects revoked or expired authorization directly.
 * @param {string} refreshToken
 * @param {Function} [fetchFn]
 * @returns {Promise<{ ok: boolean, accessToken?: string, error?: string, isRevoked?: boolean }>}
 */
async function refreshGoogleTokenDirect(refreshToken, fetchFn = global.fetch) {
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) {
    return { ok: false, error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not configured." };
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  try {
    const res = await fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await res.json();
    if (!res.ok) {
      const errCode = data.error || "";
      const isRevoked = errCode === "invalid_grant" || /revoked|expired/i.test(data.error_description || "");
      return {
        ok: false,
        error: data.error_description || data.error || "Token refresh failed",
        isRevoked,
      };
    }

    return { ok: true, accessToken: data.access_token };
  } catch (err) {
    return { ok: false, error: err.message, isRevoked: false };
  }
}

/**
 * Comprehensive verification of GA4 connection status for a user.
 *
 * @param {object} params
 * @param {string} params.userEmail
 * @param {object} [params.datasourceDoc]
 * @param {object} [params.userProfile]
 * @param {boolean} [params.forceProbe=false]
 * @param {object} [params.db]
 * @param {Function} [params.customFetch]
 * @returns {Promise<object>} Status result object
 */
async function verifyGa4Status({
  userEmail,
  datasourceDoc,
  userProfile = {},
  forceProbe = false,
  db = null,
  customFetch = global.fetch,
}) {
  const now = new Date();

  // 1. Not connected state
  if (!datasourceDoc || datasourceDoc.status === "not_connected" || !datasourceDoc.encryptedRefreshToken) {
    return {
      state: "not_connected",
      substate: "unlinked",
      badgeText: "Not connected",
      badgeClass: "gray",
      message: "Google Analytics 4 is not connected. Connect your account to monitor traffic and sales.",
      actionRequired: false,
      canMonitor: false,
      checkedAt: now.toISOString(),
    };
  }

  // 2. Check cached verification result unless forceProbe is requested
  if (!forceProbe && datasourceDoc.ga4Verification && datasourceDoc.ga4Verification.checkedAt) {
    const lastCheck = new Date(datasourceDoc.ga4Verification.checkedAt).getTime();
    if (now.getTime() - lastCheck < CACHE_TTL_MS) {
      return {
        ...datasourceDoc.ga4Verification.result,
        fromCache: true,
      };
    }
  }

  // 3. Decrypt token
  let refreshToken = null;
  try {
    refreshToken = decryptToken(datasourceDoc.encryptedRefreshToken);
  } catch (decErr) {
    const result = {
      state: "action_required",
      substate: "decryption_failed",
      badgeText: "Action required ⚠️",
      badgeClass: "red",
      message: "Google authorization token cannot be decrypted. Please reconnect Google Analytics.",
      actionRequired: true,
      actionType: "reconnect",
      actionLabel: "Reconnect Google Analytics",
      canMonitor: false,
      checkedAt: now.toISOString(),
    };
    return result;
  }

  if (!refreshToken) {
    return {
      state: "action_required",
      substate: "missing_token",
      badgeText: "Action required ⚠️",
      badgeClass: "red",
      message: "Stored authorization token is missing or corrupted. Please reconnect Google Analytics.",
      actionRequired: true,
      actionType: "reconnect",
      actionLabel: "Reconnect Google Analytics",
      canMonitor: false,
      checkedAt: now.toISOString(),
    };
  }

  // 4. Verify scope authorization
  const grantedScopes = Array.isArray(datasourceDoc.scopes) ? datasourceDoc.scopes : [];
  const hasAnalyticsScope = grantedScopes.length === 0 || grantedScopes.some((s) =>
    s.includes("analytics.readonly") || s.includes("analytics")
  );

  if (!hasAnalyticsScope) {
    return {
      state: "action_required",
      substate: "insufficient_permissions",
      badgeText: "Action required ⚠️",
      badgeClass: "red",
      message: "Missing Google Analytics read permission (analytics.readonly). Please reconnect and grant Analytics access.",
      actionRequired: true,
      actionType: "reconnect",
      actionLabel: "Reconnect with Analytics Permission",
      canMonitor: false,
      checkedAt: now.toISOString(),
    };
  }

  // 5. Verify refresh token validity with Google
  const tokenRefresh = await refreshGoogleTokenDirect(refreshToken, customFetch);
  if (!tokenRefresh.ok) {
    if (tokenRefresh.isRevoked) {
      return {
        state: "action_required",
        substate: "revoked_auth",
        badgeText: "Action required ⚠️",
        badgeClass: "red",
        message: "Google authorization expired or was revoked. Please reconnect Google Analytics.",
        actionRequired: true,
        actionType: "reconnect",
        actionLabel: "Reconnect Google Analytics",
        canMonitor: false,
        checkedAt: now.toISOString(),
      };
    }
    // Temporary refresh failure
    return {
      state: "action_required",
      substate: "temporary_api_error",
      badgeText: "Temporary issue",
      badgeClass: "amber",
      message: `Google authorization server temporarily unavailable: ${tokenRefresh.error}`,
      actionRequired: false,
      isTemporary: true,
      canMonitor: true,
      checkedAt: now.toISOString(),
    };
  }

  const accessToken = tokenRefresh.accessToken;

  // 6. Check selected property
  const selectedProperty = datasourceDoc.selectedProperty;
  const propertyId = selectedProperty?.id || "";

  if (!propertyId) {
    return {
      state: "action_required",
      substate: "missing_property",
      badgeText: "Action required ⚠️",
      badgeClass: "amber",
      message: "No GA4 property selected. Please select a property to begin monitoring.",
      actionRequired: true,
      actionType: "select_property",
      actionLabel: "Select Property",
      canMonitor: false,
      checkedAt: now.toISOString(),
    };
  }

  // 7. Probe GA4 Data API for Traffic & Access verification
  const probeRange = {
    startDate: "7daysAgo",
    endDate: "yesterday",
  };

  const trafficProbe = await probeGa4Api(
    accessToken,
    propertyId,
    {
      dateRanges: [probeRange],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
    },
    customFetch
  );

  if (!trafficProbe.ok) {
    if (trafficProbe.status === 403) {
      return {
        state: "action_required",
        substate: "insufficient_permissions",
        badgeText: "Action required ⚠️",
        badgeClass: "red",
        message: "Your connected Google account does not have Viewer access to this GA4 property.",
        actionRequired: true,
        actionType: "check_permissions",
        actionLabel: "Verify Property Permissions",
        canMonitor: false,
        checkedAt: now.toISOString(),
      };
    }
    if (trafficProbe.status === 404) {
      return {
        state: "action_required",
        substate: "invalid_property",
        badgeText: "Action required ⚠️",
        badgeClass: "red",
        message: "Selected GA4 property was not found or was deleted. Please select an active property.",
        actionRequired: true,
        actionType: "select_property",
        actionLabel: "Change Property",
        canMonitor: false,
        checkedAt: now.toISOString(),
      };
    }
    if (trafficProbe.isTemporary) {
      return {
        state: "connected",
        substate: "temporary_api_error",
        badgeText: "Connected (API busy)",
        badgeClass: "amber",
        message: "Connection verified, but Google Analytics API is temporarily busy (HTTP 503). Retrying automatically.",
        actionRequired: false,
        isTemporary: true,
        canMonitor: true,
        checkedAt: now.toISOString(),
      };
    }
    return {
      state: "action_required",
      substate: "data_fetch_failed",
      badgeText: "Action required ⚠️",
      badgeClass: "red",
      message: `Failed to retrieve data from GA4: ${trafficProbe.error}`,
      actionRequired: true,
      actionType: "select_property",
      actionLabel: "Review GA4 Configuration",
      canMonitor: false,
      checkedAt: now.toISOString(),
    };
  }

  // Probe succeeded: calculate traffic volume
  const trafficRows = trafficProbe.data?.rows || [];
  const totalSessions = trafficRows.reduce((acc, r) => acc + Number(r.metricValues?.[0]?.value || 0), 0);
  const hasTraffic = totalSessions > 0;

  // 8. E-Commerce Assessment
  const ecomRequested = isEcommerceRequested(userProfile);
  let ecomConfigured = false;
  let ecomPurchases = 0;
  let ecomRevenue = 0;
  let ecomReason = "not_requested";

  if (ecomRequested) {
    const ecomProbe = await probeGa4Api(
      accessToken,
      propertyId,
      {
        dateRanges: [probeRange],
        metrics: [
          { name: "ecommercePurchases" },
          { name: "purchaseRevenue" },
          { name: "itemsAddedToCart" },
          { name: "itemsCheckedOut" },
        ],
      },
      customFetch
    );

    if (!ecomProbe.ok) {
      if (ecomProbe.status === 403) {
        ecomReason = "unavailable_permissions";
      } else {
        ecomReason = "missing_events";
      }
    } else {
      const ecomRows = ecomProbe.data?.rows || [];
      if (ecomRows.length > 0) {
        ecomPurchases = Number(ecomRows[0]?.metricValues?.[0]?.value || 0);
        ecomRevenue = Number(ecomRows[0]?.metricValues?.[1]?.value || 0);
        const cartAdds = Number(ecomRows[0]?.metricValues?.[2]?.value || 0);
        const checkouts = Number(ecomRows[0]?.metricValues?.[3]?.value || 0);

        if (ecomPurchases > 0 || cartAdds > 0 || checkouts > 0) {
          ecomConfigured = true;
          ecomReason = ecomPurchases > 0 ? "fully_active" : "active_zero_purchases";
        }
      }

      // Check event breakdown as fallback if metric values were 0
      if (!ecomConfigured) {
        const eventsProbe = await probeGa4Api(
          accessToken,
          propertyId,
          {
            dateRanges: [probeRange],
            dimensions: [{ name: "eventName" }],
            metrics: [{ name: "eventCount" }],
            limit: 100,
          },
          customFetch
        );

        if (!eventsProbe.ok) {
          if (eventsProbe.status === 403) {
            ecomReason = "unavailable_permissions";
          } else if (trafficRows.length < 2) {
            ecomReason = "insufficient_history";
          } else {
            ecomReason = "missing_events";
          }
        } else if (eventsProbe.data?.rows) {
          const names = eventsProbe.data.rows.map((r) => r.dimensionValues?.[0]?.value);
          const ecomEventRows = eventsProbe.data.rows.filter((r) =>
            ["purchase", "add_to_cart", "begin_checkout", "view_item"].includes(r.dimensionValues?.[0]?.value)
          );
          const hasEcomEvents = ecomEventRows.length > 0;
          const totalEcomEventCount = ecomEventRows.reduce(
            (acc, r) => acc + Number(r.metricValues?.[0]?.value || 0),
            0
          );

          if (hasEcomEvents && totalEcomEventCount > 0) {
            ecomConfigured = true;
            ecomReason = "active_zero_purchases";
          } else if (hasEcomEvents && totalEcomEventCount === 0) {
            ecomReason = "zero_event_counts";
          } else if (trafficRows.length < 2) {
            ecomReason = "insufficient_history";
          } else {
            ecomReason = "missing_events";
          }
        } else if (trafficRows.length < 2) {
          ecomReason = "insufficient_history";
        } else {
          ecomReason = "missing_events";
        }
      }
    }
  }

  // 9. Synthesize final state
  let finalResult = null;

  if (ecomRequested && !ecomConfigured) {
    // Partially configured: GA4 works, general traffic works, but e-commerce lacks data/events
    let missingDetail = "";
    if (ecomReason === "unavailable_permissions") {
      missingDetail = "E-commerce and monetization metrics are restricted by property permissions in GA4.";
    } else if (ecomReason === "insufficient_history") {
      missingDetail = "Insufficient historical data in GA4 (fewer than 2 days recorded). E-commerce verification will resume as traffic accumulates.";
    } else if (ecomReason === "zero_event_counts") {
      missingDetail = "E-commerce tracking is configured, but zero e-commerce interactions were recorded in the recent window.";
    } else {
      missingDetail = "E-commerce events (add_to_cart, begin_checkout, purchase) are not configured in your GA4 property.";
    }

    finalResult = {
      state: "partially_configured",
      substate: "ecommerce_unconfigured",
      badgeText: "Partially configured",
      badgeClass: "amber",
      message: hasTraffic
        ? `Traffic monitoring active · ${missingDetail}`
        : `Connected (no visits recorded yet in GA4) · ${missingDetail}`,
      actionRequired: false,
      canMonitor: true,
      trafficState: hasTraffic ? "active" : "no_data_yet",
      ecommerce: {
        requested: true,
        configured: false,
        reason: ecomReason,
        details: missingDetail,
      },
      checkedAt: now.toISOString(),
    };
  } else {
    // Fully connected state
    let messageText = "";
    if (ecomRequested && ecomConfigured) {
      if (ecomPurchases > 0) {
        messageText = "Connected & verified · Traffic, conversion funnel, and revenue monitoring active.";
      } else {
        messageText = "Connected & verified · Traffic and funnel active (0 purchases recorded in recent 7-day window).";
      }
    } else if (hasTraffic) {
      messageText = "Connected & verified · Website visitor and engagement monitoring active.";
    } else {
      // Distinguish zero traffic as "No data yet", NEVER as an error
      messageText = "Connected & verified · No visits recorded yet in GA4 (new property or zero visits). Monitoring is ready.";
    }

    finalResult = {
      state: "connected",
      substate: ecomConfigured ? (ecomPurchases > 0 ? "fully_active" : "active_zero_purchases") : (hasTraffic ? "traffic_active" : "no_data_yet"),
      badgeText: "Connected ✓",
      badgeClass: "green",
      message: messageText,
      actionRequired: false,
      canMonitor: true,
      trafficState: hasTraffic ? "active" : "no_data_yet",
      ecommerce: {
        requested: ecomRequested,
        configured: ecomConfigured,
        purchases: ecomPurchases,
        revenue: ecomRevenue,
        reason: ecomReason,
      },
      checkedAt: now.toISOString(),
    };
  }

  // Persist cache to database if db instance provided
  if (db) {
    try {
      await db.collection("datasources").updateOne(
        { userEmail, provider: "google_analytics" },
        {
          $set: {
            ga4Verification: {
              result: finalResult,
              checkedAt: now,
            },
            updatedAt: now,
          },
        }
      );
    } catch (saveErr) {
      console.warn("[GA4 Status] Failed to cache verification result in DB:", saveErr.message);
    }
  }

  return finalResult;
}

module.exports = {
  verifyGa4Status,
  isEcommerceRequested,
  probeGa4Api,
  refreshGoogleTokenDirect,
  CACHE_TTL_MS,
};
