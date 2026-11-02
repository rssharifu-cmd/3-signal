const {COLLECTION, MAX_ATTEMPTS} = require('./dailyDelivery');
async function deliveryDiagnostics(db, now = new Date()) {
  const rows = await db.collection(COLLECTION).find({updatedAt:{$gte:new Date(now.getTime()-86400000)}},
    {projection:{_id:1,status:1,reason:1,attempts:1,leaseUntil:1,nextAttemptAt:1,updatedAt:1,providerMessageId:1}}).toArray();
  const counts = {}, attention = [];
  for (const r of rows) {
    counts[r.status] = (counts[r.status] || 0)+1;
    const expired = ['generating','sending','prepared'].includes(r.status) && r.leaseUntil <= now;
    if (expired || ['retry','failed','needs_review'].includes(r.status)) attention.push({deliveryId:r._id,status:r.status,reason:r.reason,
      attempts:r.attempts,leaseExpired:expired,nextAttemptAt:r.nextAttemptAt,providerMessageId:r.providerMessageId || null});
  }
  // Old unresolved rows must remain visible even after the 24h reporting window.
  const unresolved = await db.collection(COLLECTION).find({status:{$in:['failed','needs_review','retry','generating','sending','prepared','pending']}},
    {projection:{_id:1,status:1,reason:1,attempts:1,leaseUntil:1,nextAttemptAt:1}}).toArray();
  return {service:'Daily Delivery',status:unresolved.some(r=>['failed','needs_review'].includes(r.status) ||
      r.attempts >= MAX_ATTEMPTS || (['generating','sending','prepared'].includes(r.status) && r.leaseUntil <= now) ||
      (['retry','pending'].includes(r.status) && r.nextAttemptAt <= now))?'error':'ok',
    message:`${counts.accepted || 0} email(s) accepted by provider in the last 24h; mailbox delivery is not confirmed.`,
    extra:{counts,unresolvedCount:unresolved.length,attention,olderUnresolved:unresolved.filter(r=>!rows.some(x=>x._id===r._id)).map(r=>({deliveryId:r._id,status:r.status,reason:r.reason})),note:'Read-only daily_deliveries state; no automatic repair or resend.'}};
}
module.exports = {deliveryDiagnostics};
