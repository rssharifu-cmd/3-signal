const { getDb } = require('./_lib/db');
const lemon = require('./_lib/lemon');
const { verified } = require('./_lib/accountEligibility');
const { WRITE } = require('./_lib/rateLimits');

async function rawBody(req) {
  if (Buffer.isBuffer(req.rawBody) || typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return Buffer.from(req.body);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 1024 * 1024) throw new Error('Body too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const c = lemon.settings();
  if (!lemon.ready(c)) return res.status(503).json({ error: 'Billing not configured' });
  let raw, payload;
  try {
    raw = await rawBody(req);
    if (!lemon.signatureValid(raw, req.headers?.['x-signature'], c.secret)) return res.status(401).json({ error: 'Invalid signature' });
    payload = JSON.parse(raw.toString('utf8'));
  } catch { return res.status(400).json({ error: 'Invalid payload' }); }
  const event = payload.meta?.event_name;
  const data = payload.data;
  if (typeof event !== 'string' || !data?.id || !data.attributes) return res.status(400).json({ error: 'Missing event data' });
  if (data.attributes.test_mode !== c.testMode) return res.status(200).json({ ok: true, ignored: true });
  const isInvoice = data.type === 'subscription-invoices' && event.startsWith('subscription_payment_');
  if (!(data.type === 'subscriptions' && event.startsWith('subscription_')) && !isInvoice) {
    return res.status(200).json({ ok: true, ignored: true });
  }
  const id = String(isInvoice ? data.attributes.subscription_id : data.id);
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid subscription' });
  const eventId = 'lemon:' + lemon.hash(raw);
  try {
    const db = await getDb(), users = db.collection('users'), events = db.collection('billing_events');
    if (await events.findOne({ eventId, status: 'processed' })) return res.status(200).json({ ok: true, duplicate: true });
    // Always fetch current state: delayed events must never restore an expired subscription.
    const sub = (await lemon.request('/subscriptions/' + id)).data;
    if (sub?.type !== 'subscriptions' || String(sub.id) !== id) throw new Error('Invalid provider response');
    const a = sub.attributes;
    const plan = lemon.planFor(a, c);
    if (!plan) return res.status(200).json({ ok: true, ignored: true });
    const version = new Date(a.updated_at);
    if (!Number.isFinite(version.getTime())) throw new Error('Missing subscription version');
    let user = await users.findOne({ lemonSubscriptionId: id, lemonTestMode: c.testMode });
    let binding = null;
    let checkout = null;
    if (!user) {
      const token = payload.meta?.custom_data?.sharflow_checkout;
      if (typeof token !== 'string' || !/^[a-f\d]{64}$/.test(token)) return res.status(200).json({ ok: true, unmatched: true });
      binding = lemon.hash(token);
      checkout = await events.findOne({ eventId: 'lemon-checkout:' + binding, status: 'checkout',
        testMode: c.testMode, expiresAt: { $gt: new Date() } });
      if (!checkout || checkout.plan !== plan) return res.status(200).json({ ok: true, unmatched: true });
      user = await users.findOne({ _id: checkout.userId, authVersion: checkout.authVersion });
      if (!user || !verified(user) ||
          (user.lemonSubscriptionId || null) !== checkout.previousSubscriptionId) return res.status(200).json({ ok: true, unmatched: true });
    }
    if (!verified(user) || (user.lemonCustomerId && user.lemonCustomerId !== String(a.customer_id))) {
      return res.status(200).json({ ok: true, unmatched: true });
    }
    const update = { billingProvider: 'lemon', lemonSubscriptionId: id, lemonCustomerId: String(a.customer_id),
      lemonTestMode: c.testMode, lemonVariantId: String(a.variant_id), lemonUpdatedAt: version,
      lemonStatus: a.status, lemonEndsAt: a.ends_at ? new Date(a.ends_at) : null,
      lemonRenewsAt: a.renews_at ? new Date(a.renews_at) : null,
      lemonTrialEndsAt: a.trial_ends_at ? new Date(a.trial_ends_at) : null, updatedAt: new Date() };
    let refunded = binding ? false : Boolean(user.lemonRefunded);
    if (binding) { update.lemonRefunded = false; update.lemonInvoiceDate = null; }
    if (isInvoice && ['subscription_payment_success', 'subscription_payment_recovered', 'subscription_payment_refunded'].includes(event)) {
      const invoice = (await lemon.request('/subscription-invoices/' + encodeURIComponent(data.id))).data;
      const inv = invoice?.attributes;
      if (invoice?.type !== 'subscription-invoices' || String(inv?.subscription_id) !== id ||
          String(inv.store_id) !== c.storeId || inv.test_mode !== c.testMode) throw new Error('Invalid invoice');
      const invoiceDate = new Date(inv.created_at);
      if (!Number.isFinite(invoiceDate.getTime())) throw new Error('Invalid invoice date');
      if (binding || !user.lemonInvoiceDate || invoiceDate >= new Date(user.lemonInvoiceDate)) {
        refunded = Boolean(inv.refunded && Number(inv.refunded_amount) >= Number(inv.total) && Number(inv.total) > 0);
        update.lemonRefunded = refunded;
        update.lemonInvoiceDate = invoiceDate;
      }
    }
    const allowed = lemon.access(a) && !refunded;
    update.plan = allowed ? plan : 'starter';
    update.subscriptionStatus = allowed ? 'active' : refunded ? 'refunded' : a.status;
    const filter = { _id: user._id, authVersion: user.authVersion,
      // Compare-and-set serializes overlapping events, including refunds with identical subscription versions.
      lemonRevision: user.lemonRevision === undefined ? { $exists: false } : user.lemonRevision,
      ...(binding ? { lemonSubscriptionId: checkout.previousSubscriptionId || { $exists: false } } : { lemonSubscriptionId: id }) };
    if (user.lemonUpdatedAt && version < new Date(user.lemonUpdatedAt)) return res.status(200).json({ ok: true, ignored: true });
    const result = await users.updateOne(filter, { $set: update, $inc: { lemonRevision: 1 },
      ...(binding && user.lemonCheckout?.hash === binding ? { $unset: { lemonCheckout: '' } } : {}) }, { writeConcern: WRITE });
    if (!result.matchedCount) return res.status(409).json({ error: 'Concurrent update; retry' });
    await events.updateOne({ eventId }, { $set: { provider: 'lemon', status: 'processed', eventType: event,
      subscriptionId: id, processedAt: new Date() } }, { upsert: true, writeConcern: WRITE });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(503).json({ error: 'Subscription synchronization temporarily unavailable; retry' });
  }
}
handler.config = { api: { bodyParser: false } };
module.exports = handler;
