// Import-safe scheduler: no dotenv, database import, execution or sends at module load.
const {createDailyDelivery, verifyDeliveryIndexes, summarize, COLLECTION} = require('../api/_lib/dailyDelivery');
async function processUser(user, db, targetDate) {
  const {generateDailyIntelligence} = require('../api/_lib/generateDailyIntelligence');
  const {sendWatchdogEmail} = require('../api/send');
  return createDailyDelivery({generate:generateDailyIntelligence, send:sendWatchdogEmail, prepare:sendWatchdogEmail})(user,db,targetDate);
}
function scheduledDate(at) {
  // Reports accept completed UTC days only. At 13:00 open yesterday's target;
  // before then continue the target opened by the previous day's schedule.
  return new Date(at.getTime() - (at.getUTCHours() < 13 ? 2 : 1) * 86400000).toISOString().slice(0,10);
}
async function run({db, process = processUser, now = new Date(), log = console.log}) {
  await verifyDeliveryIndexes(db);
  const users = await db.collection('users').find({active:{$ne:false}}).toArray();
  const targetDate = scheduledDate(now);
  const pending = await db.collection(COLLECTION).find({status:{$in:['pending','retry','prepared','sending','generating']}}).toArray();
  const tasks = new Map(users.map(u => [String(u._id)+'/'+targetDate,{user:u,date:targetDate}]));
  const byId = new Map(users.map(u => [String(u._id),u]));
  const orphaned = [];
  for (const row of pending) {
    const user = byId.get(row.userId);
    if (user) tasks.set(row.userId+'/'+row.targetDate,{user,date:row.targetDate});
    else orphaned.push({status:'needs_review',reason:'pending_owner_missing_or_inactive',deliveryId:row._id});
  }
  const results = [...orphaned], all = [...tasks.values()];
  for (let i=0;i<all.length;i+=3) {
    const batch = await Promise.allSettled(all.slice(i,i+3).map(t => process(t.user,db,t.date)));
    for (const r of batch) results.push(r.status === 'fulfilled' ? r.value : {status:'error',reason:'unhandled_worker_failure'});
  }
  const summary = summarize(results);
  log(JSON.stringify({targetDate,...summary,attention:results.filter(r=>['retry','failed','needs_review','error'].includes(r.status))}));
  return summary;
}
async function main() {
  // Guard before importing db.js, which connects immediately on import.
  if (process.env.DAILY_DELIVERY_EXECUTION_ACK !== 'approved-daily-delivery-v1' || process.env.APP_ENV !== 'production' ||
      (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF !== 'refs/heads/main')) throw Error('Explicit scheduler execution approval required');
  const {getDb,closeDb} = require('../api/_lib/db');
  try { return await run({db:await getDb()}); }
  finally { await closeDb(); }
}
if (require.main === module) main().then(s=>{process.exitCode=s.failed?1:0;},()=>{console.error('Scheduler failed; inspect configuration, indexes and persisted daily delivery state.');process.exitCode=1;});
module.exports = {processUser,run,scheduledDate,main};
