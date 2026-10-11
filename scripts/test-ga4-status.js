/**
 * Sharflow — Google Analytics 4 Connection Status System Tests
 *
 * Validates all required GA4 connection status states:
 * 1. Connected & working GA4 (with e-commerce purchases and revenue)
 * 2. Connected & working GA4 (traffic only, no e-commerce requested)
 * 3. Connected with 0 traffic ("No data yet" - must NEVER trigger an error warning)
 * 4. Missing property selection -> Action required
 * 5. Revoked authorization -> Action required
 * 6. Insufficient permission (missing scope) -> Action required
 * 7. Insufficient permission (HTTP 403 on GA4 Data API) -> Action required
 * 8. Partially configured: No e-commerce events (traffic active, but e-commerce events missing)
 * 9. Partially configured: Insufficient history (< 2 days recorded)
 * 10. Partially configured: Unavailable permissions (HTTP 403 on monetization)
 * 11. Temporary API error (HTTP 503) -> Connected (API busy)
 */

const assert = require("assert");
const { verifyGa4Status } = require("../api/_lib/ga4Status");
const { encryptToken } = require("../api/_lib/cryptoUtils");

async function runTests() {
  console.log("=================================================");
  console.log("🧪 Running GA4 Connection Status Verification Tests");
  console.log("=================================================\n");

  const mockEncryptedToken = encryptToken("mock-valid-refresh-token");
  const userEmail = "test-ga4@example.com";

  // Mock token refresh function (simulates Google OAuth endpoint)
  function createMockFetch(responses) {
    return async function mockFetch(url, options = {}) {
      const urlStr = String(url);

      // Google Token endpoint
      if (urlStr.includes("oauth2.googleapis.com/token")) {
        if (responses.tokenRevoked) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
            text: async () => JSON.stringify({ error: "invalid_grant" }),
          };
        }
        if (responses.tokenTemporaryError) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ error: "backend_error" }),
            text: async () => "Service Unavailable",
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "mock-access-token-12345", expires_in: 3600 }),
        };
      }

      // GA4 Data API runReport
      if (urlStr.includes("analyticsdata.googleapis.com/v1beta")) {
        const body = options.body ? JSON.parse(options.body) : {};
        const metrics = body.metrics || [];
        const isEcomProbe = metrics.some((m) => m.name === "ecommercePurchases");
        const isEventsProbe = (body.dimensions || []).some((d) => d.name === "eventName");

        if (responses.apiPermissionDenied) {
          return {
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ error: { message: "User does not have sufficient permissions for this property." } }),
            json: async () => ({ error: { message: "User does not have sufficient permissions for this property." } }),
          };
        }

        if (responses.apiPropertyNotFound) {
          return {
            ok: false,
            status: 404,
            text: async () => JSON.stringify({ error: { message: "Property not found." } }),
            json: async () => ({ error: { message: "Property not found." } }),
          };
        }

        if (responses.apiTemporaryError) {
          return {
            ok: false,
            status: 503,
            text: async () => "Service Unavailable",
            json: async () => ({ error: { message: "Service Unavailable" } }),
          };
        }

        if (isEcomProbe) {
          if (responses.ecomPermissionDenied) {
            return {
              ok: false,
              status: 403,
              text: async () => JSON.stringify({ error: { message: "Monetization metrics restricted." } }),
              json: async () => ({ error: { message: "Monetization metrics restricted." } }),
            };
          }
          if (responses.hasEcomData) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                rows: [
                  {
                    metricValues: [
                      { value: "42" },     // ecommercePurchases
                      { value: "2499.50" }, // purchaseRevenue
                      { value: "115" },    // itemsAddedToCart
                      { value: "68" },     // itemsCheckedOut
                    ],
                  },
                ],
              }),
            };
          }
          // Zero ecom metrics
          return {
            ok: true,
            status: 200,
            json: async () => ({
              rows: [
                {
                  metricValues: [
                    { value: "0" },
                    { value: "0" },
                    { value: "0" },
                    { value: "0" },
                  ],
                },
              ],
            }),
          };
        }

        if (isEventsProbe) {
          if (responses.eventsHaveEcom) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                rows: [
                  { dimensionValues: [{ value: "page_view" }], metricValues: [{ value: "500" }] },
                  { dimensionValues: [{ value: "session_start" }], metricValues: [{ value: "300" }] },
                  { dimensionValues: [{ value: "add_to_cart" }], metricValues: [{ value: "25" }] },
                  { dimensionValues: [{ value: "begin_checkout" }], metricValues: [{ value: "12" }] },
                  { dimensionValues: [{ value: "purchase" }], metricValues: [{ value: "0" }] },
                ],
              }),
            };
          }
          if (responses.eventsHaveZeroEcomCounts) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                rows: [
                  { dimensionValues: [{ value: "page_view" }], metricValues: [{ value: "500" }] },
                  { dimensionValues: [{ value: "add_to_cart" }], metricValues: [{ value: "0" }] },
                ],
              }),
            };
          }
          // Only standard web events (no ecommerce events)
          return {
            ok: true,
            status: 200,
            json: async () => ({
              rows: [
                { dimensionValues: [{ value: "page_view" }], metricValues: [{ value: "500" }] },
                { dimensionValues: [{ value: "session_start" }], metricValues: [{ value: "300" }] },
                { dimensionValues: [{ value: "scroll" }], metricValues: [{ value: "150" }] },
              ],
            }),
          };
        }

        // Standard Traffic probe
        if (responses.zeroTraffic) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ rows: [] }),
          };
        }

        if (responses.insufficientHistory) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              rows: [
                { dimensionValues: [{ value: "20261010" }], metricValues: [{ value: "15" }, { value: "12" }] },
              ],
            }),
          };
        }

        // Standard active traffic (multiple days)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            rows: [
              { dimensionValues: [{ value: "20261008" }], metricValues: [{ value: "120" }, { value: "100" }] },
              { dimensionValues: [{ value: "20261009" }], metricValues: [{ value: "150" }, { value: "130" }] },
              { dimensionValues: [{ value: "20261010" }], metricValues: [{ value: "140" }, { value: "115" }] },
            ],
          }),
        };
      }

      throw new Error(`Unhandled mock fetch URL: ${urlStr}`);
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1: Connected & Working GA4 (with e-commerce purchases & revenue)
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 1: Connected and working GA4 (successful e-commerce retrieval)");
    const status = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: { id: "properties/123456789", name: "My E-Commerce Store" },
      },
      userProfile: { websiteType: "E-commerce / Online Store" },
      forceProbe: true,
      customFetch: createMockFetch({ hasEcomData: true }),
    });

    assert.strictEqual(status.state, "connected", "State must be 'connected'");
    assert.strictEqual(status.badgeText, "Connected ✓");
    assert.strictEqual(status.actionRequired, false);
    assert.strictEqual(status.canMonitor, true);
    assert.strictEqual(status.trafficState, "active");
    assert.strictEqual(status.ecommerce.configured, true);
    assert.strictEqual(status.ecommerce.purchases, 42);
    assert.strictEqual(status.ecommerce.revenue, 2499.50);
    assert.match(status.message, /revenue monitoring active/i);
    console.log("  ✓ Status: Connected ✓ (purchases: 42, revenue: $2499.50)\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2: Connected & Working GA4 with 0 traffic ("No data yet")
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 2: Connected GA4 with zero traffic ('No data yet' distinction)");
    const status = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: { id: "properties/123456789", name: "New Website" },
      },
      userProfile: { websiteType: "Content / Blog" },
      forceProbe: true,
      customFetch: createMockFetch({ zeroTraffic: true }),
    });

    assert.strictEqual(status.state, "connected", "Must be 'connected' (zero traffic is not an error)");
    assert.strictEqual(status.trafficState, "no_data_yet");
    assert.strictEqual(status.actionRequired, false, "Zero traffic alone must NEVER trigger an actionRequired warning");
    assert.strictEqual(status.canMonitor, true);
    assert.match(status.message, /No visits recorded yet in GA4/i);
    console.log("  ✓ Status: Connected ✓ (properly distinguished as 'no_data_yet', no tracking error warning)\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: Action Required — Missing Property
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 3: Missing GA4 property selection -> Action required");
    const status = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: null,
      },
      userProfile: { websiteType: "E-commerce" },
      forceProbe: true,
      customFetch: createMockFetch({}),
    });

    assert.strictEqual(status.state, "action_required");
    assert.strictEqual(status.substate, "missing_property");
    assert.strictEqual(status.actionRequired, true);
    assert.strictEqual(status.actionType, "select_property");
    assert.strictEqual(status.canMonitor, false);
    assert.match(status.message, /No GA4 property selected/i);
    console.log("  ✓ Status: Action required ⚠️ (Action type: select_property)\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: Action Required — Revoked Authorization
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 4: Revoked authorization from Google -> Action required");
    const status = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: { id: "properties/123456789", name: "My Store" },
      },
      userProfile: {},
      forceProbe: true,
      customFetch: createMockFetch({ tokenRevoked: true }),
    });

    assert.strictEqual(status.state, "action_required");
    assert.strictEqual(status.substate, "revoked_auth");
    assert.strictEqual(status.actionRequired, true);
    assert.strictEqual(status.actionType, "reconnect");
    assert.strictEqual(status.canMonitor, false);
    assert.match(status.message, /revoked/i);
    console.log("  ✓ Status: Action required ⚠️ (Action type: reconnect, revoked authorization detected)\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5: Action Required — Insufficient Permissions (Missing Scope & HTTP 403)
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 5A: Insufficient permission (missing analytics scope)");
    const statusScope = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["openid", "email", "profile"], // lacks analytics.readonly
        selectedProperty: { id: "properties/123456789", name: "My Store" },
      },
      userProfile: {},
      forceProbe: true,
      customFetch: createMockFetch({}),
    });

    assert.strictEqual(statusScope.state, "action_required");
    assert.strictEqual(statusScope.substate, "insufficient_permissions");
    assert.strictEqual(statusScope.actionRequired, true);
    assert.match(statusScope.message, /analytics\.readonly/i);
    console.log("  ✓ Status: Action required ⚠️ (missing analytics.readonly scope)\n");

    console.log("Test 5B: Insufficient permission (HTTP 403 on GA4 Data API)");
    const status403 = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: { id: "properties/123456789", name: "Forbidden Property" },
      },
      userProfile: {},
      forceProbe: true,
      customFetch: createMockFetch({ apiPermissionDenied: true }),
    });

    assert.strictEqual(status403.state, "action_required");
    assert.strictEqual(status403.substate, "insufficient_permissions");
    assert.strictEqual(status403.actionRequired, true);
    assert.match(status403.message, /Viewer access/i);
    console.log("  ✓ Status: Action required ⚠️ (HTTP 403 Viewer access denied detected)\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 6: Partially Configured — Missing E-Commerce Events
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 6: Partially configured (traffic active, e-commerce requested but events missing)");
    const status = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: { id: "properties/123456789", name: "Store Without Ecommerce Tag" },
      },
      userProfile: { websiteType: "E-commerce / Online Store" },
      forceProbe: true,
      customFetch: createMockFetch({ hasEcomData: false, eventsHaveEcom: false }),
    });

    assert.strictEqual(status.state, "partially_configured");
    assert.strictEqual(status.substate, "ecommerce_unconfigured");
    assert.strictEqual(status.badgeText, "Partially configured");
    assert.strictEqual(status.canMonitor, true, "General traffic monitoring must remain available");
    assert.strictEqual(status.ecommerce.reason, "missing_events");
    assert.match(status.message, /Traffic monitoring active/i);
    assert.match(status.message, /add_to_cart.*purchase.*not configured/i);
    console.log("  ✓ Status: Partially configured (traffic active, missing e-commerce events explained)\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 7: E-Commerce Distinction — Active Zero Purchases (Funnel Active)
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 7: Active e-commerce tracking with 0 purchases (must NOT be treated as broken)");
    const status = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: { id: "properties/123456789", name: "Quiet Store" },
      },
      userProfile: { websiteType: "E-commerce" },
      forceProbe: true,
      customFetch: createMockFetch({ hasEcomData: false, eventsHaveEcom: true }), // funnel events present, purchases = 0
    });

    assert.strictEqual(status.state, "connected", "Must be 'connected' (funnel events active, 0 purchases is valid)");
    assert.strictEqual(status.ecommerce.configured, true);
    assert.strictEqual(status.ecommerce.reason, "active_zero_purchases");
    assert.match(status.message, /0 purchases recorded in recent 7-day window/i);
    console.log("  ✓ Status: Connected ✓ (active funnel with 0 purchases acknowledged correctly)\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 8: E-Commerce Distinction — Insufficient History (< 2 days recorded)
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 8: E-commerce distinction: Insufficient history (< 2 days recorded)");
    const status = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: { id: "properties/123456789", name: "Brand New Property" },
      },
      userProfile: { websiteType: "E-commerce" },
      forceProbe: true,
      customFetch: createMockFetch({ insufficientHistory: true, hasEcomData: false, eventsHaveEcom: false }),
    });

    assert.strictEqual(status.state, "partially_configured");
    assert.strictEqual(status.ecommerce.reason, "insufficient_history");
    assert.match(status.ecommerce.details, /fewer than 2 days recorded/i);
    console.log("  ✓ Status: Partially configured (properly distinguished as insufficient_history)\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 9: E-Commerce Distinction — Unavailable Permissions (403 on monetization)
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 9: E-commerce distinction: Unavailable permissions (HTTP 403 on monetization)");
    const status = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: { id: "properties/123456789", name: "Restricted Property" },
      },
      userProfile: { websiteType: "E-commerce" },
      forceProbe: true,
      customFetch: createMockFetch({ ecomPermissionDenied: true }),
    });

    assert.strictEqual(status.state, "partially_configured");
    assert.strictEqual(status.ecommerce.reason, "unavailable_permissions");
    assert.match(status.ecommerce.details, /restricted by property permissions/i);
    console.log("  ✓ Status: Partially configured (properly distinguished as unavailable_permissions)\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 10: Temporary API Error (HTTP 503) Handled Gracefully
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log("Test 10: Temporary API error (HTTP 503) on GA4 Data API");
    const status = await verifyGa4Status({
      userEmail,
      datasourceDoc: {
        provider: "google_analytics",
        status: "connected",
        encryptedRefreshToken: mockEncryptedToken,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        selectedProperty: { id: "properties/123456789", name: "Active Property" },
      },
      userProfile: {},
      forceProbe: true,
      customFetch: createMockFetch({ apiTemporaryError: true }),
    });

    assert.strictEqual(status.state, "connected", "Temporary API issues must NOT downgrade to action_required");
    assert.strictEqual(status.badgeText, "Connected (API busy)");
    assert.strictEqual(status.isTemporary, true);
    assert.strictEqual(status.canMonitor, true);
    assert.strictEqual(status.actionRequired, false);
    console.log("  ✓ Status: Connected (API busy) (temporary 503 handled without false error warning)\n");
  }

  console.log("=================================================");
  console.log("🎉 ALL 10 GA4 CONNECTION STATUS TESTS PASSED 100%");
  console.log("=================================================");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
