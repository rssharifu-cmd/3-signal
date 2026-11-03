const crypto = require('crypto');
const { requireAccount } = require('./_lib/accountSecurity');
const { cors } = require('./_lib/authMiddleware');
const { getDb } = require('./_lib/db');
const { appOrigin } = require('./_lib/origins');
const lemon = require('./_lib/lemon');
const { limit, WRITE } = require('./_lib/rateLimits');

module.exports = async function billing(req, res) {
  if (cors(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  // Published product identifiers/prices are public checkout metadata. Never expose credentials,
  // customer records or subscription data here. Provider reads are coalesced and cached.
  if (req.method === 'GET' && new URL(req.url, 'https://sharflow.online').searchParams.get('action') === 'plans') {
    try { return res.status(200).json({ ok: true, ...(await lemon.catalog()) }); }
    catch (err) { return res.status(503).json({ error: 'Plan verification is temporarily unavailable',
      code: /^(LEMON|CATALOG)_[A-Z0-9_]+$/.test(err.code || '') ? err.code : 'CATALOG_UNAVAILABLE' }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await requireAccount(req, res);
  if (!user) return;
  const c = lemon.settings();
  if (!lemon.ready(c)) return res.status(503).json({ error: 'Payments are being connected. Please try again later.' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || !['checkout', 'portal'].includes(body.action)) return res.status(400).json({ error: 'Invalid billing action' });
  try {
    const db = await getDb();
    await limit(db, 'billing-account', String(user._id), 10, 60);
    // Existing subscriptions are managed in the portal, preventing duplicate recurring charges.
    if (user.lemonSubscriptionId) {
      const sub = (await lemon.request('/subscriptions/' + encodeURIComponent(user.lemonSubscriptionId))).data;
      if (!sub || !lemon.planFor(sub.attributes, c) || String(sub.attributes.customer_id) !== user.lemonCustomerId) {
        throw new Error('Subscription verification unavailable');
      }
      if (body.action === 'portal' || sub.attributes.status !== 'expired') {
        return res.status(200).json({ ok: true, url: lemon.safeUrl(sub.attributes.urls?.customer_portal) });
      }
    } else if (body.action === 'portal') return res.status(404).json({ error: 'No subscription to manage' });
    if (!Object.hasOwn(c.variants, body.plan)) return res.status(400).json({ error: 'Choose Analytics or Complete' });
    const catalog = await lemon.catalog();
    if (catalog.plans[body.plan].variantId !== c.variants[body.plan]) throw new Error('Configured variant does not match verified monthly price');
    if (user.lemonCheckout?.url && user.lemonCheckout.plan === body.plan &&
        new Date(user.lemonCheckout.expiresAt) > new Date()) {
      return res.status(200).json({ ok: true, url: lemon.safeUrl(user.lemonCheckout.url) });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    // Keep the binding on the authenticated account. Email/custom user IDs alone never establish ownership.
    const saved = await db.collection('users').updateOne({ _id: user._id, authVersion: user.authVersion,
      lemonRevision: user.lemonRevision === undefined ? { $exists: false } : user.lemonRevision,
      lemonSubscriptionId: user.lemonSubscriptionId || { $exists: false },
      $or: [{ lemonCheckout: { $exists: false } }, { 'lemonCheckout.expiresAt': { $lte: now } }] }, {
      $set: { lemonCheckout: { hash: lemon.hash(token), plan: body.plan, testMode: c.testMode,
        createdAt: now, expiresAt: new Date(now.getTime() + 30 * 60 * 1000) } },
    }, { writeConcern: WRITE });
    if (!saved.matchedCount) return res.status(409).json({ error: 'A checkout is already open. Finish it or try again shortly.' });
    try {
      await db.collection('billing_events').insertOne({ eventId: 'lemon-checkout:' + lemon.hash(token),
        provider: 'lemon', status: 'checkout', userId: user._id, authVersion: user.authVersion,
        plan: body.plan, testMode: c.testMode, previousSubscriptionId: user.lemonSubscriptionId || null,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) }, { writeConcern: WRITE });
      const checkout = await lemon.request('/checkouts', { method: 'POST', body: { data: {
        type: 'checkouts', attributes: { test_mode: c.testMode,
          expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
          product_options: { enabled_variants: [Number(c.variants[body.plan])],
            redirect_url: appOrigin() + '/?checkout=success#billing' },
          // The app already supplies a no-card trial. Do not restart a second trial at checkout.
          checkout_options: { skip_trial: true },
          checkout_data: { custom: { sharflow_checkout: token } },
        }, relationships: {
          store: { data: { type: 'stores', id: c.storeId } },
          variant: { data: { type: 'variants', id: c.variants[body.plan] } },
        },
      } } });
      const url = lemon.safeUrl(checkout.data?.attributes?.url);
      await db.collection('users').updateOne({ _id: user._id, 'lemonCheckout.hash': lemon.hash(token) }, {
        $set: { 'lemonCheckout.url': url },
      });
      return res.status(200).json({ ok: true, url });
    } catch (err) {
      // A timeout can occur after the provider created a checkout: retain its binding to avoid a second charge.
      throw err;
    }
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: err.message });
    return res.status(502).json({ error: 'Billing is temporarily unavailable. Please contact hello@sharflow.online if this continues.' });
  }
};
