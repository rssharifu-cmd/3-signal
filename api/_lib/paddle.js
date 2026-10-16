/**
 * Sharflow — Paddle Billing v2 Server-side Helper
 *
 * Supports both Sandbox and Live environments configured via PADDLE_ENV.
 * Provides:
 *  - Environment resolution & base URLs (api.paddle.com vs sandbox-api.paddle.com)
 *  - Official Paddle-Signature HMAC-SHA256 verification with replay attack mitigation
 *  - Timing-safe signature comparisons
 *  - Paddle v2 REST API fetch client
 */

const crypto = require("crypto");

/**
 * Returns current Paddle environment mode ("sandbox" or "live").
 * Defaults to "live" if PADDLE_ENV is not set or set to "production" / "live".
 * @returns {"sandbox" | "live"}
 */
function getPaddleEnv() {
  const env = (process.env.PADDLE_ENV || "").trim().toLowerCase();
  if (env === "sandbox" || env === "development" || env === "test") {
    return "sandbox";
  }
  return "live";
}

/**
 * Returns the base API URL for Paddle v2 based on current environment.
 * @returns {string}
 */
function getPaddleBaseUrl() {
  return getPaddleEnv() === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";
}

/**
 * Returns the configured Paddle API Secret Key.
 * @returns {string}
 */
function getPaddleApiKey() {
  return (process.env.PADDLE_API_KEY || "").trim();
}

/**
 * Returns the configured Paddle Webhook Secret Key for signature validation.
 * @returns {string}
 */
function getPaddleWebhookSecret() {
  return (process.env.PADDLE_WEBHOOK_SECRET || "").trim();
}

/**
 * Parses Paddle-Signature header: "ts=1234567890;h1=abcdef..."
 * Multiple h1 tags or custom ordering are supported.
 *
 * @param {string} signatureHeader
 * @returns {{ ts: number, signatures: string[] } | null}
 */
function parsePaddleSignatureHeader(signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== "string") {
    return null;
  }

  const parts = signatureHeader.split(";");
  let ts = 0;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (key === "ts") {
      const parsedTs = parseInt(value, 10);
      if (!Number.isNaN(parsedTs)) {
        ts = parsedTs;
      }
    } else if (key === "h1" && value) {
      signatures.push(value.toLowerCase());
    }
  }

  if (!ts || signatures.length === 0) {
    return null;
  }

  return { ts, signatures };
}

/**
 * Verifies the Paddle v2 webhook signature against the raw request body.
 *
 * Official Paddle verification algorithm:
 * 1. Extract `ts` and `h1` from the `Paddle-Signature` header.
 * 2. Form signed payload string: `${ts}:${rawBody}`.
 * 3. Compute HMAC-SHA256 hex digest using the endpoint secret key.
 * 4. Perform timing-safe equal comparison with the provided `h1` signature(s).
 * 5. Optionally verify timestamp is within acceptable tolerance window to prevent replay attacks.
 *
 * @param {object} params
 * @param {string | Buffer} params.rawBody - Raw unparsed request body
 * @param {string} params.signatureHeader - Paddle-Signature header value
 * @param {string} [params.secretKey] - Optional secret override, defaults to process.env.PADDLE_WEBHOOK_SECRET
 * @param {number} [params.toleranceSeconds] - Max acceptable age in seconds (default: 300, 5 mins. Pass 0 to disable)
 * @returns {{ valid: boolean, error?: string, ts?: number }}
 */
function verifyPaddleWebhookSignature({
  rawBody,
  signatureHeader,
  secretKey,
  toleranceSeconds = 300,
}) {
  const secret = (secretKey || getPaddleWebhookSecret()).trim();
  if (!secret) {
    return { valid: false, error: "Missing PADDLE_WEBHOOK_SECRET configuration." };
  }

  if (rawBody === undefined || rawBody === null) {
    return { valid: false, error: "Missing raw request body." };
  }

  // Ensure rawBody is converted to string for concatenation
  const rawBodyString = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

  const parsed = parsePaddleSignatureHeader(signatureHeader);
  if (!parsed) {
    return {
      valid: false,
      error: "Invalid or missing Paddle-Signature header format (expected ts=...;h1=...).",
    };
  }

  const { ts, signatures } = parsed;

  // Replay attack prevention check
  if (toleranceSeconds > 0) {
    const currentUnixTimestamp = Math.floor(Date.now() / 1000);
    const age = Math.abs(currentUnixTimestamp - ts);
    if (age > toleranceSeconds) {
      return {
        valid: false,
        error: `Webhook timestamp expired or outside tolerance window (age: ${age}s, tolerance: ${toleranceSeconds}s).`,
        ts,
      };
    }
  }

  // Compute expected HMAC SHA256
  const payloadToSign = `${ts}:${rawBodyString}`;
  const computedHashHex = crypto
    .createHmac("sha256", secret)
    .update(payloadToSign, "utf8")
    .digest("hex")
    .toLowerCase();

  const computedBuffer = Buffer.from(computedHashHex, "utf8");

  // Check matching signature using timingSafeEqual
  let matchFound = false;
  for (const sig of signatures) {
    const sigBuffer = Buffer.from(sig, "utf8");
    if (
      sigBuffer.length === computedBuffer.length &&
      crypto.timingSafeEqual(sigBuffer, computedBuffer)
    ) {
      matchFound = true;
      break;
    }
  }

  if (!matchFound) {
    return { valid: false, error: "Signature mismatch.", ts };
  }

  return { valid: true, ts };
}

/**
 * Makes an authenticated request to Paddle v2 REST API.
 *
 * @param {string} endpoint - Path e.g. "/customers" or "/subscriptions/{id}"
 * @param {object} [options]
 * @param {string} [options.method] - GET, POST, PATCH, DELETE (default GET)
 * @param {object} [options.body] - Request body object (will be JSON serialized)
 * @param {string} [options.apiKey] - Optional custom API key override
 * @returns {Promise<any>}
 */
async function paddleApiRequest(endpoint, { method = "GET", body, apiKey } = {}) {
  const key = (apiKey || getPaddleApiKey()).trim();
  if (!key) {
    throw new Error("PADDLE_API_KEY environment variable is not configured.");
  }

  const baseUrl = getPaddleBaseUrl();
  const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const fetchOptions = {
    method: method.toUpperCase(),
    headers,
  };

  if (body && ["POST", "PATCH", "PUT"].includes(fetchOptions.method)) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);
  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Invalid JSON response from Paddle API: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const errorMsg =
      data?.error?.detail ||
      data?.error?.message ||
      `Paddle API request failed with status ${response.status}`;
    const err = new Error(errorMsg);
    err.status = response.status;
    err.details = data;
    throw err;
  }

  return data;
}

function getPaddleProPriceId() {
  return (process.env.PADDLE_PRICE_ID_PRO || "pri_01m4tf8w6602rpfrhv9mbrcm7b").trim();
}

module.exports = {
  getPaddleEnv,
  getPaddleBaseUrl,
  getPaddleApiKey,
  getPaddleWebhookSecret,
  getPaddleProPriceId,
  parsePaddleSignatureHeader,
  verifyPaddleWebhookSignature,
  paddleApiRequest,
};
