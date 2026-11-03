const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { mockDb, loader, call, user, response } = require('./test-helpers/securityHarness');
Object.assign(process.env, { JWT_SECRET: 'lemon-isolated-test-secret', LEMON_ENABLED: 'true', LEMON_TEST_MODE: 'true',
  LEMON_API_KEY: 'fixture-only', LEMON_WEBHOOK_SECRET: 'fixture-signing-secret', LEMON_STORE_ID: '10',
  LEMON_VARIANT_ANALYTICS: '20', LEMON_VARIANT_COMPLETE: '30' });
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();
function subscription(changes = {}) { return { type: 'subscriptions', id: '40', attributes: {
  store_id: 10, variant_id: 20, customer_id: 50, test_mode: true, status: 'active',
  updated_at: '2026-11-04T10:00:00Z', renews_at: future(),
  urls: { customer_portal: 'https://sharflow.lemonsqueezy.com/billing?fixture=1' }, ...changes,
} }; }
function webhook(data = subscription(), custom, event = 'subscription_created') {
  const body = JSON.stringify({ meta: { event_name: event, custom_data: custom }, data });
  return { body, headers: { 'x-signature': crypto.createHmac('sha256', process.env.LEMON_WEBHOOK_SECRET).update(body).digest('hex') } };
}
function fixture(initial = {}, fetchFn) {
  const db = mockDb({ users: [user()], ...initial });
  const load = loader({ db, fetchFn: async (...args) => catalogResponse(args[0]) ||
    (fetchFn ? fetchFn(...args) : response({ data: subscription() })) });
  return { db, load, billing: load('api/billing.js'), webhook: load('api/lemon-webhook.js') };
}
function catalogResponse(url, price = 999) {
  if (url.includes('/products?')) return response({ data: ['Analytics', 'Complete'].map((name, index) => ({
    type: 'products', id: String(index + 11), attributes: { name: 'Sharflow ' + name, store_id: 10, test_mode: true, status: 'published' },
  })) });
  if (url.includes('/variants?')) {
    const analytics = url.includes('=11&');
    return response({ data: [{ type: 'variants', id: analytics ? '20' : '30', attributes: {
      product_id: analytics ? 11 : 12, status: 'published', is_subscription: true, interval: 'month',
      interval_count: 1, price: analytics ? price : 1975, pay_what_you_want: false,
    } }] });
  }
}
function linked(extra = {}) { return user({ billingProvider: 'lemon', plan: 'analytics', lemonSubscriptionId: '40',
  lemonCustomerId: '50', lemonTestMode: true, lemonStatus: 'active', lemonRenewsAt: future(), ...extra }); }

test('signature uses exact bytes; tampering and malformed hex are rejected', async () => {
  const f = fixture(); const req = webhook();
  assert.equal((await call(f.webhook, { ...req, body: req.body + ' ' })).statusCode, 401);
  assert.equal((await call(f.webhook, { ...req, headers: { 'x-signature': 'z'.repeat(64) } })).statusCode, 401);
  assert.equal(f.db.calls.length, 0);
});
test('checkout requires verified current session, profile review and trusted origin', async () => {
  const f = fixture();
  assert.equal((await call(f.billing, { email: null, body: { action: 'checkout', plan: 'analytics' } })).statusCode, 401);
  assert.equal((await call(f.billing, { headers: { origin: 'https://evil.example' } })).statusCode, 403);
  f.db.data.users[0].configurationReviewRequired = true;
  assert.equal((await call(f.billing, { body: { action: 'checkout', plan: 'analytics' } })).statusCode, 403);
});
test('checkout locks concurrent attempts, ignores client price and persists account binding before API', async () => {
  let requests = 0, token;
  const f = fixture({}, async (url, options) => {
    if (url.includes('/subscriptions/')) return response({ data: subscription() });
    requests++;
    const body = JSON.parse(options.body).data;
    assert.equal(body.relationships.variant.data.id, '20');
    assert.equal(body.attributes.custom_price, undefined);
    assert.equal(body.attributes.checkout_data.email, undefined);
    assert.equal(body.attributes.checkout_options.skip_trial, true);
    token = body.attributes.checkout_data.custom.sharflow_checkout;
    assert.ok(f.db.data.billing_events.some(e => e.eventId === 'lemon-checkout:' + crypto.createHash('sha256').update(token).digest('hex')));
    return response({ data: { attributes: { url: 'https://sharflow.lemonsqueezy.com/checkout/fixture' } } });
  });
  const options = { body: { action: 'checkout', plan: 'analytics', price: 1, userId: 'attacker' } };
  const results = await Promise.all([call(f.billing, options), call(f.billing, options)]);
  assert.equal(requests, 1); assert.ok(results.some(r => r.statusCode === 200));
  const repeat = await call(f.billing, options);
  assert.equal(repeat.statusCode, 200); assert.equal(requests, 1);
  assert.notEqual(f.db.data.users[0].lemonCheckout.hash, token);
  assert.equal((await call(f.webhook, webhook(subscription(), { sharflow_checkout: token }))).statusCode, 200);
  assert.equal(f.db.data.users[0].lemonSubscriptionId, '40');
  assert.equal(f.db.data.users[0].plan, 'analytics');
});
test('custom email or user ID alone cannot claim a subscription', async () => {
  const f = fixture();
  await call(f.webhook, webhook(subscription(), { user_id: user()._id, email: user().email }));
  assert.equal(f.db.data.users[0].plan, undefined);
});
test('live/test or store mismatch cannot grant or revoke access', async () => {
  const f = fixture({ users: [linked()] });
  await call(f.webhook, webhook(subscription({ test_mode: false, status: 'expired' })));
  await call(f.webhook, webhook(subscription({ store_id: 99, status: 'expired' })));
  assert.equal(f.db.data.users[0].plan, 'analytics');
});
test('delayed active payload uses current expired provider state', async () => {
  const f = fixture({ users: [linked()] }, async () => response({ data: subscription({ status: 'expired', ends_at: past() }) }));
  assert.equal((await call(f.webhook, webhook())).statusCode, 200);
  assert.equal(f.db.data.users[0].plan, 'starter');
});
test('cancelled access lasts only to ends_at, even without another webhook', () => {
  const f = fixture(); const { isPaidActive } = f.load('api/_lib/plans.js');
  assert.equal(isPaidActive(linked({ lemonStatus: 'cancelled', lemonEndsAt: future() })), true);
  assert.equal(isPaidActive(linked({ lemonStatus: 'cancelled', lemonEndsAt: past() })), false);
  assert.equal(isPaidActive(linked({ lemonTestMode: false })), false);
  assert.equal(isPaidActive(linked({ lemonRefunded: true })), false);
});
test('duplicate delivery does not mutate account twice', async () => {
  const f = fixture({ users: [linked()] }); const req = webhook();
  assert.equal((await call(f.webhook, req)).statusCode, 200);
  assert.equal((await call(f.webhook, req)).body.duplicate, true);
  assert.equal(f.db.data.users[0].lemonRevision, 1);
});
test('concurrent events use account compare-and-set and retry the losing update', async () => {
  const f = fixture({ users: [linked()] });
  const results = await Promise.all([call(f.webhook, webhook()), call(f.webhook, webhook(subscription(), undefined, 'subscription_updated'))]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
  assert.equal(f.db.data.users[0].lemonRevision, 1);
});
test('provider outage returns retryable response without changing subscription', async () => {
  const f = fixture({ users: [linked()] }, async () => { throw Error('fixture outage'); });
  assert.equal((await call(f.webhook, webhook())).statusCode, 503);
  assert.equal(f.db.data.users[0].lemonRevision, undefined);
});
test('a webhook for an old subscription cannot modify its replacement', async () => {
  const f = fixture({ users: [linked({ lemonSubscriptionId: '41' })] });
  await call(f.webhook, webhook(subscription({ status: 'expired' })));
  assert.equal(f.db.data.users[0].lemonSubscriptionId, '41');
  assert.equal(f.db.data.users[0].plan, 'analytics');
});
test('existing subscription opens portal instead of creating duplicate checkout', async () => {
  const requests = [];
  const f = fixture({ users: [linked()] }, async url => { requests.push(url); return response({ data: subscription() }); });
  const r = await call(f.billing, { body: { action: 'checkout', plan: 'complete' } });
  assert.equal(r.statusCode, 200); assert.match(r.body.url, /\/billing/);
  assert.equal(requests.length, 1); assert.match(requests[0], /\/subscriptions\/40$/);
});
test('full latest invoice refund revokes access; ordinary updates cannot restore it', async () => {
  const invoice = { type: 'subscription-invoices', id: '60', attributes: { subscription_id: 40,
    store_id: 10, test_mode: true, refunded: true, refunded_amount: 999, total: 999, created_at: '2026-11-04T09:00:00Z' } };
  const f = fixture({ users: [linked()] }, async url => response({ data: url.includes('subscription-invoices') ? invoice : subscription() }));
  assert.equal((await call(f.webhook, webhook(invoice, undefined, 'subscription_payment_refunded'))).statusCode, 200);
  assert.equal(f.db.data.users[0].plan, 'starter');
  await call(f.webhook, webhook());
  assert.equal(f.db.data.users[0].plan, 'starter');
});
test('provider URLs cannot redirect customers to unrelated sites', () => {
  const { safeUrl } = fixture().load('api/_lib/lemon.js');
  for (const url of ['https://lemonsqueezy.com.evil.example', 'javascript:alert(1)', 'http://sharflow.lemonsqueezy.com', 'https://name:secret@sharflow.lemonsqueezy.com']) assert.throws(() => safeUrl(url));
});
test('public catalog returns only verified published plan metadata, never credentials or accounts', async () => {
  const f = fixture();
  const result = await call(f.billing, { method: 'GET', url: '/api/billing?action=plans', email: null });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.plans.analytics.variantId, '20');
  assert.equal(result.body.plans.complete.priceUsdMonthly, 19.75);
  assert.doesNotMatch(JSON.stringify(result.body), /fixture-only|fixture-signing|owner@example/);
  assert.equal(f.db.calls.length, 0);
});
test('catalog coalesces concurrent provider reads', async () => {
  let count = 0;
  const load = loader({ fetchFn: async url => { count++; return catalogResponse(url); } });
  const { catalog } = load('api/_lib/lemon.js');
  await Promise.all([catalog(), catalog(), catalog()]);
  assert.equal(count, 3);
});
test('catalog refuses an incorrect subscription price', async () => {
  const load = loader({ fetchFn: async url => catalogResponse(url, 1) });
  await assert.rejects(load('api/_lib/lemon.js').catalog(), /price verification failed/);
});
test('a published product can use its single pending default variant', async () => {
  const load = loader({ fetchFn: async url => {
    const r = catalogResponse(url);
    const data = await r.json();
    if (url.includes('/variants?')) data.data[0].attributes.status = 'pending';
    return response(data);
  } });
  assert.equal((await load('api/_lib/lemon.js').catalog()).plans.analytics.variantId, '20');
});
