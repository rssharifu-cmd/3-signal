// No connections or background work at import time. All effects are injected.
const { createHash, randomUUID } = require('node:crypto');
const { verified } = require('./accountEligibility');
const { getEntitlements, ensureTrial } = require('./plans');
const COLLECTION = 'daily_deliveries';
const LEASE_MS = 15 * 60 * 1000;
const REPLAY_MS = 23 * 60 * 60 * 1000; // Resend retains keys for 24h; leave a safety margin.
const MAX_ATTEMPTS = 5;
const TERMINAL = ['accepted', 'skipped', 'failed', 'needs_review'];
function dailyId(userId, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) throw Error('Invalid delivery date');
  return 'daily-v1-' + createHash('sha256').update(JSON.stringify([String(userId), date])).digest('hex');
}
// _id is the unique daily claim: no runtime index creation, no expiring dedup records.
async function verifyDeliveryIndexes(db) {
  const metadata = await db.listCollections({name:COLLECTION},{nameOnly:false}).toArray();
  if (metadata.length !== 1 || metadata[0].options?.capped || metadata[0].options?.timeseries || metadata[0].options?.expireAfterSeconds !== undefined) {
    throw Error('Provision an ordinary durable daily_deliveries collection before enabling the scheduler');
  }
  const indexes = await db.collection(COLLECTION).listIndexes().toArray();
  if (!indexes.some(i => JSON.stringify(i.key) === JSON.stringify({_id: 1})) ||
      indexes.some(i => i.expireAfterSeconds !== undefined || (i.unique && JSON.stringify(i.key) !== JSON.stringify({_id: 1})))) {
    throw Error('daily_deliveries requires the standard unique _id index, no TTL or additional unique indexes');
  }
}
function createDailyDelivery({ generate, send, prepare, now = () => new Date(), token = randomUUID }) {
  return async function processUser(user, db, targetDate) {
    if (!verified(user) || user.configurationReviewRequired) return {status: 'skipped', reason: 'ownership_or_review_required'};
    const id = dailyId(user._id, targetDate), col = db.collection(COLLECTION);
    let leaseToken, row;
    const result = (status, reason, extra = {}) => ({status, reason, deliveryId: id, ...extra});
    // Every mutation is fenced by token AND live lease; stale workers cannot commit.
    async function save(fields) {
      const at = now();
      const r = await col.updateOne({_id: id, leaseToken, leaseUntil: {$gt: at}}, {$set: {...fields, updatedAt: at}}, {writeConcern:{w:'majority'}});
      if (r.matchedCount !== 1) throw Error('Delivery lease lost');
      row = {...row, ...fields};
    }
    async function finish(status, reason, fields = {}) {
      await save({status, reason, ...fields, leaseUntil: now()});
      return result(status, reason, {emailSent: status === 'accepted'});
    }
    async function ineligible(reason) {
      return await finish(row.firstSendAt ? 'needs_review' : 'skipped', reason);
    }
    async function retry(stage, errorCode, ambiguous = false) {
      if (row.attempts >= MAX_ATTEMPTS) return await finish(ambiguous ? 'needs_review' : 'failed', 'attempts_exhausted', {stage, errorCode});
      await save({status: 'retry', stage, errorCode, ambiguous, nextAttemptAt: new Date(now().getTime() + Math.min(60, 2 ** row.attempts) * 60000), leaseUntil: now()});
      return result('retry', errorCode);
    }
    try {
      // Existing legacy logs cannot prove that no send occurred: never silently replay them.
      const legacy = await db.collection('delivery_logs').findOne({lockKey: `watchdog_run_${user.email}_${targetDate}`});
      try {
        await col.insertOne({_id: id, version: 1, userId: String(user._id), userEmail: user.email, targetDate,
          status: legacy ? 'needs_review' : 'pending', reason: legacy ? 'legacy_delivery_requires_reconciliation' : null,
          attempts: 0, leaseUntil: new Date(0), nextAttemptAt: now(), createdAt: now(), updatedAt: now(),
          idempotencyKey: id}, {writeConcern:{w:'majority'}});
      } catch (err) { if (err.code !== 11000 || (err.keyPattern && !err.keyPattern._id)) throw err; }
      leaseToken = token();
      row = await col.findOneAndUpdate({_id: id, status: {$in: ['pending','retry','generating','prepared','sending']},
        attempts: {$lt: MAX_ATTEMPTS}, leaseUntil: {$lte: now()}, nextAttemptAt: {$lte: now()}},
        {$set: {leaseToken, leaseUntil: new Date(now().getTime() + LEASE_MS), updatedAt: now()}, $inc: {attempts: 1}},
        {returnDocument: 'after', includeResultMetadata: false, writeConcern:{w:'majority'}});
      if (!row) {
        const existing = await col.findOne({_id: id});
        if (existing && !TERMINAL.includes(existing.status) && existing.attempts >= MAX_ATTEMPTS && existing.leaseUntil <= now()) {
          await col.updateOne({_id:id, leaseUntil:{$lte:now()}, attempts:{$gte:MAX_ATTEMPTS},status:{$in:['generating','sending','prepared','retry','pending']}},
            {$set:{status:'needs_review',reason:'expired_final_attempt',updatedAt:now()}}, {writeConcern:{w:'majority'}});
          return result('needs_review','expired_final_attempt');
        }
        return result(existing?.status === 'needs_review' || existing?.status === 'failed' ? existing.status : 'skipped', existing?.reason || 'already_claimed_or_finished');
      }
      if (row.userEmail !== user.email || row.userId !== String(user._id)) return await finish('needs_review', 'owner_identity_changed');
      // Never restart generation after an expired generating lease: the old worker may still be alive.
      if (row.status === 'generating') return await finish('needs_review', 'generation_outcome_unknown');
      const current = await db.collection('users').findOne({_id: user._id});
      if (!current || current.email !== user.email || !verified(current) || current.configurationReviewRequired) return await ineligible('owner_ineligible');
      await ensureTrial(db, current);
      const entitlements = getEntitlements(current);
      if (entitlements.enforced && !entitlements.canRunMonitoring) return await ineligible('no_active_plan');
      const count = await db.collection('datasources').countDocuments({userEmail: current.email, status:'connected'});
      if (!current.profile?.websiteUrl && count === 0) return await ineligible('no_website_or_datasource');
      if (!row.report) {
        await save({status:'generating',stage:'generation',generationStartedAt:now()});
        let report;
        try { report = await generate(String(current._id), {targetDate}); }
        catch { return await retry('generation', 'generation_failed'); }
        if (report?.userEmail !== current.email || report.targetDate !== targetDate || !report.reportId) return await finish('needs_review','invalid_generated_report');
        // The persisted report is reused across preparation/send failures; no regeneration.
        await save({status:'prepared',stage:'preparation',report,reportId:String(report.reportId)});
      }
      if (current.settings?.notifications === false) return await ineligible('notifications_disabled');
      if (!row.payload) {
        let payload;
        try { payload = await prepare({toEmail:current.email,userName:current.name || '',report:row.report,entitlements,prepareOnly:true}); }
        catch { return await retry('preparation','email_preparation_failed'); }
        await save({payload});
      }
      if (row.firstSendAt && now().getTime() - new Date(row.firstSendAt).getTime() >= REPLAY_MS) return await finish('needs_review','provider_replay_window_expired');
      const firstSendAt = row.firstSendAt || now();
      // Durable intent precedes network I/O, including the first attempt.
      await save({status:'sending',stage:'send',firstSendAt});
      let accepted;
      try {
        accepted = await send({toEmail:current.email,userName:current.name || '',report:row.report,entitlements,
          preparedPayload:row.payload,idempotencyKey:row.idempotencyKey,beforeSend:async()=>{
            if (now().getTime()-new Date(firstSendAt).getTime() >= REPLAY_MS) throw Error('Provider replay window expired');
            const latest = await db.collection('users').findOne({_id:user._id});
            if (!latest || latest.email !== user.email || !verified(latest) || latest.configurationReviewRequired ||
                latest.settings?.notifications === false || (getEntitlements(latest).enforced && !getEntitlements(latest).canRunMonitoring)) {
              throw Object.assign(Error('Delivery eligibility changed'),{deliveryDisposition:'eligibility_revoked'});
            }
            await save({});
          }});
      } catch (err) {
        if (err.deliveryDisposition === 'eligibility_revoked') return await ineligible('eligibility_changed_before_send');
        if (err.deliveryDisposition === 'permanent_rejection') return await finish(row.ambiguous ? 'needs_review' : 'failed','provider_rejected', {errorCode:err.providerCode || 'rejected'});
        if (err.deliveryDisposition === 'payload_conflict') return await finish('needs_review','idempotency_payload_conflict');
        return await retry('send','provider_outcome_unconfirmed',true);
      }
      if (!accepted?.id) return await retry('send','provider_acceptance_id_missing',true);
      // Acceptance is NOT mailbox delivery. The ID supports later provider reconciliation.
      return await finish('accepted','provider_accepted',{providerMessageId:accepted.id,acceptedAt:now(),ambiguous:false});
    } catch {
      // If a DB write failed after generation/send, leave durable intent untouched.
      // The expired lease recovery path will reconcile or halt safely.
      return result('error','delivery_state_or_lock_failure');
    }
  };
}
function summarize(results) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return {counts, failed:results.some(r => ['retry','failed','needs_review','error'].includes(r.status))};
}
module.exports = {createDailyDelivery, verifyDeliveryIndexes, dailyId, summarize, COLLECTION, LEASE_MS, REPLAY_MS, MAX_ATTEMPTS};
