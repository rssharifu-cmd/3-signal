# Sharflow — AI Website Watchdog

> **You run your business. Sharflow watches your website.**

Sharflow connects directly to your verified first-party website data sources (Google Search Console, Google Analytics 4, and Bing Webmaster Tools), executes deterministic statistical anomaly detection algorithms, conducts contextual external research when anomalies occur, and uses Gemini to deliver daily actionable intelligence reports.

---

## Architecture & Pipeline

1. **First-Party Data Ingestion (`api/_lib/` & `api/datasources.js`)**
   - Connects to Google Search Console (clicks, impressions, CTR, position per page/query).
   - Connects to Google Analytics 4 (active users, sessions, conversion events).
   - Connects to Bing Webmaster Tools (crawls, indexed pages, organic search clicks).
   - Encrypted refresh tokens stored securely in MongoDB (`aes-256-gcm`).

2. **Deterministic Anomaly Engine (`api/_lib/anomalies.js`)**
   - Pure mathematical rules — strictly zero LLM hallucinations.
   - Evaluates sustained drops against historical 7-day and 28-day baseline windows.
   - Statistical noise floors prevent false alarms on low-traffic fluctuations.

3. **Contextual External Research Layer (`api/_lib/research/`)**
   - Conditionally triggered only when search or ranking anomalies are flagged.
   - Cross-references Google Search Central RSS for core algorithm announcements.
   - Targeted web search (Tavily) for SERP volatility and competitor changes.
   - Community webmaster signals (Reddit r/SEO).

4. **AI Interpretation Layer (`api/_lib/intelligence.js`)**
   - Powered by Gemini via `@google/genai`.
   - Strictly skipped if code algorithms find zero anomalies ("All systems normal").
   - Identifies probable root causes, ranks findings P1–P4, and generates concrete 1-2-3 next steps.

5. **Delivery & Scheduler (`api/send.js` & `scripts/run-watchdog-scheduler.js`)**
   - Daily automated scheduler runs via GitHub Actions with concurrency control and deduplication.
   - High-contrast, responsive intelligence report emails dispatched via Resend.

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `MONGODB_URI` | Yes | Storage for users, data sources, metric snapshots, intelligence reports |
| `JWT_SECRET` | Yes | Token signing for dashboard authentication |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | Yes | 32-byte hex key for encrypting OAuth tokens (AES-256-GCM) |
| `GEMINI_API_KEY` | Recommended | Gemini model inference for Watchdog report interpretation |
| `RESEND_API_KEY` | For email | Email delivery via Resend |
| `FROM_EMAIL` | For email | Verified sender address (e.g. `watchdog@sharflow.online`) |
| `GOOGLE_CLIENT_ID` | For GSC / GA4 | Google OAuth 2.0 Web Application Client ID |
| `GOOGLE_CLIENT_SECRET` | For GSC / GA4 | Google OAuth 2.0 Client Secret |
| `BING_CLIENT_ID` | For Bing | Microsoft Entra / Bing OAuth Client ID |
| `BING_CLIENT_SECRET` | For Bing | Microsoft Entra / Bing Client Secret |
| `TAVILY_API_KEY` | Optional | External contextual web research for algorithm updates |

---

## API Endpoints

- `POST /api/auth` — User registration and login
- `GET /api/user` & `POST /api/user` — Website profile and notification settings
- `GET /api/datasources` & `DELETE /api/datasources` — Manage connected analytics providers
- `GET /api/oauth` & `GET /api/oauth/callback` — OAuth integration flow
- `GET /api/watchdog` & `POST /api/watchdog` — Retrieve latest report or trigger on-demand check
- `POST /api/send` — Dispatches welcome and Watchdog intelligence report emails
- `GET /api/admin-status` — System diagnostics and provider connection status
