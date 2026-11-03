const crypto = require('crypto');

function settings() {
  const env = name => (process.env[name] || '').trim();
  return {
    enabled: env('LEMON_ENABLED') === 'true',
    testMode: env('LEMON_TEST_MODE') !== 'false',
    apiKey: env('LEMON_API_KEY'), secret: env('LEMON_WEBHOOK_SECRET'),
    storeId: env('LEMON_STORE_ID'),
    variants: { analytics: env('LEMON_VARIANT_ANALYTICS'), complete: env('LEMON_VARIANT_COMPLETE') },
  };
}
function ready(c = settings()) {
  return Boolean(c.enabled && c.apiKey && c.secret && /^\d+$/.test(c.storeId) &&
    /^\d+$/.test(c.variants.analytics) && /^\d+$/.test(c.variants.complete) &&
    c.variants.analytics !== c.variants.complete);
}
function signatureValid(raw, signature, secret = settings().secret) {
  if (!secret || !/^[a-f\d]{64}$/i.test(signature || '')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password &&
        (u.hostname === 'lemonsqueezy.com' || u.hostname.endsWith('.lemonsqueezy.com'))) return u.href;
  } catch {}
  throw new Error('Invalid billing destination');
}
async function request(endpoint, { method = 'GET', body } = {}) {
  if (!/^\/[a-z0-9/?=&._%-]+$/i.test(endpoint)) throw new Error('Invalid billing endpoint');
  const response = await fetch('https://api.lemonsqueezy.com/v1' + endpoint, {
    method, headers: { Authorization: 'Bearer ' + settings().apiKey,
      Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Billing provider temporarily unavailable');
  return response.json();
}
function planFor(a, c = settings()) {
  if (String(a.store_id) !== c.storeId || a.test_mode !== c.testMode) return null;
  return Object.keys(c.variants).find(key => c.variants[key] === String(a.variant_id)) || null;
}
function access(a, now = new Date()) {
  const until = a.status === 'active' ? a.renews_at : a.status === 'on_trial' ? a.trial_ends_at : a.status === 'cancelled' ? a.ends_at : null;
  return Boolean(until && new Date(until).getTime() > now.getTime());
}
module.exports = { settings, ready, signatureValid, hash, safeUrl, request, planFor, access };
