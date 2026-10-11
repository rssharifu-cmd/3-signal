/**
 * Sharflow — Data Sources Management API
 *
 * Provides status, property discovery, and property selection for:
 * 1. Google Search Console
 * 2. Google Analytics 4
 * 3. Bing Webmaster Tools
 *
 * SENSITIVE DATA POLICY:
 * - Refresh tokens are NEVER exposed to the frontend.
 * - Access tokens are used only server-side.
 */

const { getDb } = require("./_lib/db");
const { cors, extractEmail } = require("./_lib/authMiddleware");
const {
  getGoogleAccessToken,
  getBingAccessToken,
  discoverSearchConsoleProperties,
  discoverAnalyticsProperties,
  discoverBingSites,
} = require("./_lib/oauthTokens");
const { verifyGa4Status } = require("./_lib/ga4Status");

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;

  const userEmail = extractEmail(req);
  if (!userEmail) {
    return res.status(401).json({ ok: false, error: "Unauthorized. Please sign in to access data sources." });
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const action = req.query.action || urlObj.searchParams.get("action");
  const provider = req.query.provider || urlObj.searchParams.get("provider");

  try {
    const db = await getDb();
    const datasourcesCol = db.collection("datasources");
    const usersCol = db.collection("users");

    // ── 1. GET ALL DATA SOURCE STATUSES ─────────────────────────────────────
    if (req.method === "GET" && !action) {
      const records = await datasourcesCol.find({ userEmail }).toArray();
      const user = await usersCol.findOne({ email: userEmail });

      const ga4Rec = records.find((r) => r.provider === "google_analytics");
      const ga4Status = await verifyGa4Status({
        userEmail,
        datasourceDoc: ga4Rec,
        userProfile: user?.profile || {},
        forceProbe: Boolean(req.query?.force || urlObj.searchParams.get("force")),
        db,
      });

      const sourceMap = {
        google_search_console: {
          connected: false,
          selectedProperty: null,
          lastSuccessfulSync: null,
          accountEmail: null,
        },
        google_analytics: {
          connected: ga4Status.state === "connected" || ga4Status.state === "partially_configured",
          isLinked: ga4Status.state !== "not_connected",
          statusState: ga4Status.state,
          statusBadge: ga4Status.badgeText,
          statusClass: ga4Status.badgeClass,
          statusMessage: ga4Status.message,
          actionRequired: Boolean(ga4Status.actionRequired),
          actionType: ga4Status.actionType || null,
          actionLabel: ga4Status.actionLabel || null,
          canMonitor: Boolean(ga4Status.canMonitor),
          trafficState: ga4Status.trafficState || null,
          ecommerce: ga4Status.ecommerce || null,
          selectedProperty: ga4Rec?.selectedProperty || null,
          lastSuccessfulSync: ga4Rec?.lastSuccessfulSync || null,
          accountEmail: ga4Rec?.providerAccountId || null,
        },
        bing_webmaster: {
          connected: false,
          selectedProperty: null,
          lastSuccessfulSync: null,
        },
      };

      records.forEach((rec) => {
        const p = rec.provider;
        if (p === "google_analytics") {
          // Already populated with verified status
        } else if (sourceMap[p]) {
          sourceMap[p] = {
            connected: rec.status === "connected" && Boolean(rec.encryptedRefreshToken),
            selectedProperty: rec.selectedProperty || null,
            lastSuccessfulSync: rec.lastSuccessfulSync || null,
            accountEmail: rec.providerAccountId || null,
          };
        }
      });

      return res.status(200).json({ ok: true, sources: sourceMap });
    }

    // ── 1B. ON-DEMAND VERIFY DATA SOURCE STATUS ──────────────────────────────
    if (req.method === "GET" && action === "verify") {
      if (provider === "google_analytics") {
        const ga4Rec = await datasourcesCol.findOne({ userEmail, provider: "google_analytics" });
        const user = await usersCol.findOne({ email: userEmail });
        const ga4Status = await verifyGa4Status({
          userEmail,
          datasourceDoc: ga4Rec,
          userProfile: user?.profile || {},
          forceProbe: true,
          db,
        });
        return res.status(200).json({ ok: true, status: ga4Status });
      }
      return res.status(400).json({ ok: false, error: `Unsupported verify provider: ${provider}` });
    }

    // ── 2. DISCOVER PROPERTIES FOR CONNECTED SOURCE ──────────────────────────
    if (req.method === "GET" && action === "properties") {
      if (!provider) {
        return res.status(400).json({ ok: false, error: "Missing provider parameter." });
      }

      if (provider === "google_search_console") {
        const { accessToken, accountEmail } = await getGoogleAccessToken(userEmail);
        const properties = await discoverSearchConsoleProperties(accessToken);
        return res.status(200).json({ ok: true, provider, accountEmail, properties });
      }

      if (provider === "google_analytics") {
        const { accessToken, accountEmail } = await getGoogleAccessToken(userEmail);
        const properties = await discoverAnalyticsProperties(accessToken);
        return res.status(200).json({ ok: true, provider, accountEmail, properties });
      }

      if (provider === "bing_webmaster" || provider === "bing") {
        let accessToken = null;
        try {
          const bingAuth = await getBingAccessToken(userEmail);
          accessToken = bingAuth.accessToken;
        } catch (err) {
          // If individual token fails but BING_WEBMASTER_API_KEY is configured for testing:
          if (!process.env.BING_WEBMASTER_API_KEY) throw err;
        }
        const properties = await discoverBingSites(accessToken);
        return res.status(200).json({ ok: true, provider: "bing_webmaster", properties });
      }

      return res.status(400).json({ ok: false, error: `Unsupported provider: ${provider}` });
    }

    // ── 3. SAVE SELECTED PROPERTY ────────────────────────────────────────────
    if (req.method === "POST") {
      const body = req.body || {};
      const reqAction = body.action || action;

      if (reqAction === "select_property") {
        const targetProvider = body.provider || provider;
        const property = body.property;

        if (!targetProvider || !property || !property.id) {
          return res.status(400).json({ ok: false, error: "Missing provider or property details." });
        }

        const selectedProperty = {
          id: String(property.id),
          name: String(property.name || property.id),
          url: property.url ? String(property.url) : "",
          selectedAt: new Date(),
        };

        // Update datasources collection
        const updateDoc = {
          $set: {
            selectedProperty,
            updatedAt: new Date(),
          },
        };
        if (targetProvider === "google_analytics") {
          updateDoc.$unset = { ga4Verification: "" };
        }
        await datasourcesCol.updateOne(
          { userEmail, provider: targetProvider },
          updateDoc
        );

        // Also update the user's Watchdog monitoring profile
        await usersCol.updateOne(
          { email: userEmail },
          {
            $set: {
              [`profile.dataSources.${targetProvider}`]: {
                connected: true,
                propertyId: selectedProperty.id,
                propertyName: selectedProperty.name,
                url: selectedProperty.url,
                updatedAt: new Date(),
              },
              updatedAt: new Date(),
            },
          }
        );

        return res.status(200).json({
          ok: true,
          message: "Property saved successfully.",
          selectedProperty,
        });
      }

      // ── 4. DISCONNECT DATA SOURCE ──────────────────────────────────────────
      if (reqAction === "disconnect") {
        const targetProvider = body.provider || provider;
        if (!targetProvider) {
          return res.status(400).json({ ok: false, error: "Missing provider to disconnect." });
        }

        await datasourcesCol.updateOne(
          { userEmail, provider: targetProvider },
          {
            $set: {
              status: "not_connected",
              encryptedRefreshToken: null,
              selectedProperty: null,
              updatedAt: new Date(),
            },
            $unset: {
              ga4Verification: "",
            },
          }
        );

        // Remove from user profile
        await usersCol.updateOne(
          { email: userEmail },
          {
            $unset: {
              [`profile.dataSources.${targetProvider}`]: "",
            },
            $set: {
              updatedAt: new Date(),
            },
          }
        );

        return res.status(200).json({ ok: true, message: "Data source disconnected." });
      }

      return res.status(400).json({ ok: false, error: `Invalid action: ${reqAction}` });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed." });
  } catch (err) {
    console.error("[Data Sources API Error]", err.message);
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to process data sources request.",
    });
  }
};
