const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {mockDb,loader,user} = require('./test-helpers/securityHarness');
const {createDailyDelivery,dailyId,verifyDeliveryIndexes,LEASE_MS,REPLAY_MS,MAX_ATTEMPTS,summarize} = require('../api/_lib/dailyDelivery');
const {deliveryDiagnostics} = require('../api/_lib/deliveryDiagnostics');
const DATE='2026-11-03';
function fixture(options={}) {
  const owner=user({trialEndsAt:new Date('2100-01-01'),...options.owner});
  const db=mockDb({users:[owner],...options.data});
  const baseCollection=db.collection.bind(db);
  let at=new Date('2026-11-04T13:00:00Z'),serial=0;
  const calls={generation:0,preparation:0,sends:[],accepted:new Map()};
  db.collection=name=>{
    const col=baseCollection(name);
    for(const op of ['insertOne','findOne','findOneAndUpdate','updateOne']) {
      const original=col[op].bind(col);
      col[op]=async(...args)=>{
        if(options.fault)await options.fault({name,op,args,after:false});
        const value=await original(...args);
        if(options.fault)await options.fault({name,op,args,after:true});
        return value;
      };
    }
    return col;
  };
  const generate=async(...args)=>{
    calls.generation++;
    if(options.generate)return options.generate(calls,...args);
    return {reportId:'saved-report',userEmail:owner.email,targetDate:args[1].targetDate,findings:[]};
  };
  const prepare=async(args)=>{calls.preparation++;if(options.prepare)return options.prepare(calls,args);return {from:'test@example.test',to:[args.toEmail],subject:'Frozen',html:'report'};};
  const send=async(args)=>{
    await args.beforeSend();
    calls.sends.push(args);
    const serialized=JSON.stringify(args.preparedPayload),old=calls.accepted.get(args.idempotencyKey);
    if(old)assert.equal(old.payload,serialized,'Retries must preserve the complete payload');
    else calls.accepted.set(args.idempotencyKey,{id:'provider-'+calls.accepted.size,payload:serialized});
    if(options.send)return options.send(calls,args);
    return {id:calls.accepted.get(args.idempotencyKey).id};
  };
  const process=createDailyDelivery({generate,prepare,send,now:()=>new Date(at),token:()=>`token-${++serial}`});
  return {db,owner,calls,run:(date=DATE)=>process(owner,db,date),
    advance:ms=>{at=new Date(at.getTime()+ms);},now:()=>new Date(at),
    row:()=>db.data.daily_deliveries?.find(r=>r.targetDate===DATE)};
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
test('parallel daily claims generate and send once, with durable report/payload/key before send',async()=>{
  const x=fixture({send:async(c,args)=>{
    assert.equal(x.row().status,'sending');assert.ok(x.row().firstSendAt);assert.ok(x.row().report);
    assert.equal(x.row().idempotencyKey,args.idempotencyKey);assert.equal(x.row().payload.html,args.preparedPayload.html);
    return {id:'accepted'};
  }});
  const results=await Promise.all(Array.from({length:20},()=>x.run()));
  assert.equal(results.filter(r=>r.status==='accepted').length,1);
  assert.equal(x.calls.generation,1);assert.equal(x.calls.sends.length,1);
  assert.equal(x.row().providerMessageId,'accepted');assert.equal((await x.run()).status,'skipped');
});
test('claim keys separate owners/dates, reject invalid dates, and contain no email',()=>{
  assert.notEqual(dailyId('a',DATE),dailyId('b',DATE));assert.notEqual(dailyId('a',DATE),dailyId('a','2026-11-04'));
  assert.match(dailyId('owner@example.test',DATE),/^daily-v1-[a-f0-9]{64}$/);
  for(const date of ['2026-02-30','bad','2026-13-01'])assert.throws(()=>dailyId('a',date));
});
for(const op of ['findOne','insertOne','findOneAndUpdate'])test('failed '+op+' lock fails closed before generation or send',async()=>{
  const x=fixture({fault:({name,op:actual,after})=>{if(!after&&name===(op==='findOne'?'delivery_logs':'daily_deliveries')&&actual===op)throw Error('DB unavailable');}});
  assert.equal((await x.run()).status,'error');assert.equal(x.calls.generation,0);assert.equal(x.calls.sends.length,0);
});
test('expired generation lease stops automatic regeneration and fences stale worker',async()=>{
  const entered=deferred(),release=deferred();
  const x=fixture({generate:async()=>{entered.resolve();await release.promise;return {reportId:'r',targetDate:DATE,userEmail:'owner@example.com'};}});
  const first=x.run();await entered.promise;x.advance(LEASE_MS+1);
  const recovery=await x.run();assert.equal(recovery.reason,'generation_outcome_unknown');
  release.resolve();assert.equal((await first).status,'error');assert.equal(x.calls.generation,1);assert.equal(x.calls.sends.length,0);
});
test('known generation failure gets bounded retry, with no retry before due time',async()=>{
  const x=fixture({generate:async(c)=>{if(c.generation===1)throw Error('transient');return {reportId:'r',targetDate:DATE,userEmail:'owner@example.com'};}});
  assert.equal((await x.run()).status,'retry');assert.equal((await x.run()).status,'skipped');
  x.advance(3600000);assert.equal((await x.run()).status,'accepted');assert.equal(x.calls.generation,2);
});
test('persistent generation failure exhausts attempts and reports failed',async()=>{
  const x=fixture({generate:async()=>{throw Error('failed');}});
  for(let i=0;i<MAX_ATTEMPTS;i++){await x.run();x.advance(3600000);}
  assert.equal(x.row().status,'failed');await x.run();assert.equal(x.calls.generation,MAX_ATTEMPTS);assert.equal(x.calls.sends.length,0);
});
test('email preparation failure reuses persisted report instead of regenerating',async()=>{
  const x=fixture({prepare:async(c,args)=>{if(c.preparation===1)throw Error('configuration unavailable');return {to:[args.toEmail],html:'fixed'};}});
  assert.equal((await x.run()).status,'retry');x.advance(3600000);assert.equal((await x.run()).status,'accepted');assert.equal(x.calls.generation,1);
});
test('ambiguous provider timeout replays same key and payload without duplicate acceptance',async()=>{
  const x=fixture({send:async(c)=>{if(c.sends.length===1)throw Error('accepted then response lost');return {id:'original-message'};}});
  assert.equal((await x.run()).status,'retry');x.advance(3600000);assert.equal((await x.run()).status,'accepted');
  assert.equal(x.calls.accepted.size,1);assert.equal(x.calls.generation,1);assert.equal(x.calls.preparation,1);
  assert.equal(x.calls.sends[0].idempotencyKey,x.calls.sends[1].idempotencyKey);
});
test('ambiguous outcome beyond provider retention halts for review without another send',async()=>{
  const x=fixture({send:async()=>{throw Error('timeout');}});await x.run();x.advance(REPLAY_MS);
  assert.equal((await x.run()).reason,'provider_replay_window_expired');assert.equal(x.calls.sends.length,1);
});
test('ambiguous outcomes exhaust to review rather than a false completed state',async()=>{
  const x=fixture({send:async()=>{throw Error('timeout');}});
  for(let i=0;i<MAX_ATTEMPTS;i++){await x.run();x.advance(3600000);}
  assert.equal(x.row().status,'needs_review');assert.equal(x.calls.sends.length,MAX_ATTEMPTS);assert.equal(x.calls.accepted.size,1);
});
test('crash after acceptance before database completion replays original key safely',async()=>{
  let failed=false;
  const x=fixture({fault:({name,op,args,after})=>{if(!after&&!failed&&name==='daily_deliveries'&&op==='updateOne'&&args[1].$set?.status==='accepted'){failed=true;throw Error('crash');}}});
  assert.equal((await x.run()).status,'error');assert.equal(x.row().status,'sending');x.advance(LEASE_MS+1);
  assert.equal((await x.run()).status,'accepted');assert.equal(x.calls.accepted.size,1);assert.equal(x.calls.generation,1);
});
test('crash after durable send intent but before request resumes with saved payload',async()=>{
  let failed=false;
  const x=fixture({fault:({name,op,args,after})=>{if(after&&!failed&&name==='daily_deliveries'&&op==='updateOne'&&args[1].$set?.status==='sending'){failed=true;throw Error('crash');}}});
  assert.equal((await x.run()).status,'error');assert.equal(x.calls.sends.length,0);x.advance(LEASE_MS+1);
  assert.equal((await x.run()).status,'accepted');assert.equal(x.calls.generation,1);assert.equal(x.calls.preparation,1);
});
test('crash after generation before report checkpoint never generates twice',async()=>{
  let failed=false;
  const x=fixture({fault:({name,op,args,after})=>{if(!after&&!failed&&name==='daily_deliveries'&&op==='updateOne'&&args[1].$set?.report){failed=true;throw Error('crash');}}});
  assert.equal((await x.run()).status,'error');x.advance(LEASE_MS+1);
  assert.equal((await x.run()).status,'needs_review');assert.equal(x.calls.generation,1);assert.equal(x.calls.sends.length,0);
});
test('long in-flight send and expired lease share key; stale worker cannot finalize',async()=>{
  const entered=deferred(),release=deferred();
  const x=fixture({send:async(c)=>{if(c.sends.length===1){entered.resolve();await release.promise;}return {id:'same-message'};}});
  const first=x.run();await entered.promise;x.advance(LEASE_MS+1);
  assert.equal((await x.run()).status,'accepted');release.resolve();assert.equal((await first).status,'error');assert.equal(x.calls.accepted.size,1);
});
test('expired final attempt becomes reviewable instead of stuck forever',async()=>{
  const x=fixture();await x.run();Object.assign(x.row(),{status:'sending',attempts:MAX_ATTEMPTS,leaseUntil:new Date(0)});
  assert.equal((await x.run()).status,'needs_review');assert.equal(x.row().reason,'expired_final_attempt');assert.equal(x.calls.sends.length,1);
});
test('legacy log requires reconciliation rather than a potentially duplicate send',async()=>{
  const x=fixture({data:{delivery_logs:[{lockKey:`watchdog_run_owner@example.com_${DATE}`,status:'completed',emailSent:true}]}});
  assert.equal((await x.run()).reason,'legacy_delivery_requires_reconciliation');assert.equal(x.calls.generation,0);assert.equal(x.calls.sends.length,0);
});
test('notifications disabled persists report but skips email',async()=>{
  const x=fixture({owner:{settings:{notifications:false}}});assert.equal((await x.run()).reason,'notifications_disabled');assert.ok(x.row().report);assert.equal(x.calls.sends.length,0);
});
for(const change of [{active:false},{emailVerifiedAt:null},{configurationReviewRequired:true},{email:'changed@example.test'}])test('fresh owner eligibility prevents stale scheduled work '+JSON.stringify(change),async()=>{
  const x=fixture();Object.assign(x.db.data.users[0],change);const r=await x.run();assert.equal(r.status,'skipped');assert.equal(x.calls.generation,0);
});
test('invalid generated owner/date/report identity never sends',async()=>{
  const x=fixture({generate:async()=>({reportId:'r',targetDate:DATE,userEmail:'foreign@example.test'})});assert.equal((await x.run()).status,'needs_review');assert.equal(x.calls.sends.length,0);
});
for(const [disposition,status] of [['permanent_rejection','failed'],['payload_conflict','needs_review']])test('provider '+disposition+' is reported honestly',async()=>{
  const x=fixture({send:async()=>{throw Object.assign(Error('provider error'),{deliveryDisposition:disposition});}});assert.equal((await x.run()).status,status);
});
test('missing successful provider ID remains ambiguous',async()=>{
  const x=fixture({send:async()=>({})});assert.equal((await x.run()).reason,'provider_acceptance_id_missing');assert.equal(x.row().status,'retry');
});
test('index preflight requires unique daily _id and durable retention, never provisions indexes',async()=>{
  await verifyDeliveryIndexes(mockDb());
  for(const indexes of [[],[{key:{_id:1}},{key:{updatedAt:1},expireAfterSeconds:100}],[{key:{_id:1}},{key:{userEmail:1},unique:true}]]){
    await assert.rejects(verifyDeliveryIndexes({listCollections:()=>({toArray:async()=>[{options:{}}]}),collection:()=>({listIndexes:()=>({toArray:async()=>indexes})})}));
  }
});
test('missing or expiring collection fails index preflight before users or providers',async()=>{
  for(const metadata of [[],[{options:{capped:true}}],[{options:{timeseries:{}}}],[{options:{expireAfterSeconds:100}}]]){
    await assert.rejects(verifyDeliveryIndexes({listCollections:()=>({toArray:async()=>metadata}),collection:()=>{throw Error('Must not inspect after invalid metadata');}}));
  }
});
test('diagnostics distinguish provider acceptance, retry and old unresolved rows',async()=>{
  const x=fixture();await x.run();x.db.data.daily_deliveries.push({_id:'old',status:'needs_review',reason:'unknown',updatedAt:new Date(0)});
  const d=await deliveryDiagnostics(x.db,x.now());assert.equal(d.status,'error');assert.match(d.message,/accepted.*mailbox delivery is not confirmed/);assert.equal(d.extra.olderUnresolved[0].deliveryId,'old');
});
test('mixed success/failure summary stays failed',()=>{
  assert.equal(summarize([{status:'accepted'},{status:'retry'}]).failed,true);assert.equal(summarize([{status:'accepted'},{status:'skipped'}]).failed,false);
});
test('scheduler import and unapproved main never connect; UTC target opens at 13:00',async()=>{
  require('./run-watchdog-scheduler');
  assert.equal(require.cache[require.resolve('../api/_lib/db')],undefined,'Import must not load the eager database module');
  const scheduler=loader({})('scripts/run-watchdog-scheduler.js');await assert.rejects(scheduler.main(),/approval/);
  assert.equal(scheduler.scheduledDate(new Date('2026-11-04T12:59:00Z')),'2026-11-02');assert.equal(scheduler.scheduledDate(new Date('2026-11-04T13:00:00Z')),DATE);
});
test('workflow protects concurrency, production branch, explicit approval and bounded runtime',()=>{
  const text=fs.readFileSync(require('node:path').join(__dirname,'../.github/workflows/daily-digest.yml'),'utf8');
  for(const required of ['group: sharflow-daily-delivery-production','cancel-in-progress: false','timeout-minutes: 45',"github.ref == 'refs/heads/main'",'vars.DAILY_DELIVERY_EXECUTION_ACK','npm ci --ignore-scripts'])assert.ok(text.includes(required),required);
});

test('hourly recovery includes older persisted targets and reports partial failure',async()=>{
  const owner=user(),db=mockDb({users:[owner],daily_deliveries:[{_id:'old',userId:String(owner._id),targetDate:'2026-11-02',status:'retry'}]});
  const scheduler=loader({})('scripts/run-watchdog-scheduler.js'),dates=[];
  const summary=await scheduler.run({db,now:new Date('2026-11-04T14:00Z'),log:()=>{},process:async(_u,_db,date)=>{dates.push(date);return {status:date===DATE?'accepted':'retry'};}});
  assert.deepEqual(dates.sort(),['2026-11-02',DATE]);assert.equal(summary.failed,true);
});
test('orphaned unresolved work remains visible and workflow fails',async()=>{
  const db=mockDb({daily_deliveries:[{_id:'orphan',userId:'missing',targetDate:DATE,status:'sending'}]});
  const scheduler=loader({})('scripts/run-watchdog-scheduler.js');
  const summary=await scheduler.run({db,log:()=>{},process:()=>{throw Error('No active owners');}});assert.equal(summary.failed,true);
});
test('terminal unresolved state keeps subsequent hourly runs red',async()=>{
  const x=fixture({send:async()=>{throw Object.assign(Error('bad'),{deliveryDisposition:'permanent_rejection'});}});
  assert.equal((await x.run()).status,'failed');assert.equal((await x.run()).status,'failed');assert.equal(x.calls.sends.length,1);
});
test('failure to persist frozen payload cannot send an uncheckpointed email',async()=>{
  let failed=false;const x=fixture({fault:({name,op,args,after})=>{if(!after&&!failed&&name==='daily_deliveries'&&op==='updateOne'&&args[1].$set?.payload){failed=true;throw Error('DB down');}}});
  assert.equal((await x.run()).status,'error');assert.equal(x.calls.sends.length,0);x.advance(LEASE_MS+1);
  assert.equal((await x.run()).status,'accepted');assert.equal(x.calls.generation,1);
});
test('majority acknowledgement is required for claims and checkpoints',async()=>{
  const x=fixture({fault:({name,op,args,after})=>{
    if(!after&&name==='daily_deliveries'&&['insertOne','findOneAndUpdate','updateOne'].includes(op))assert.equal(args[op==='insertOne'?1:2].writeConcern.w,'majority');
  }});assert.equal((await x.run()).status,'accepted');
});
test('opt-out during preparation is caught by final pre-send eligibility fence',async()=>{
  const x=fixture({prepare:async(_calls,args)=>{x.db.data.users[0].settings={notifications:false};return {to:[args.toEmail],html:'saved'};}});
  assert.equal((await x.run()).reason,'eligibility_changed_before_send');assert.equal(x.calls.sends.length,0);
});
test('mocked standalone worker closes database on clean completion',async()=>{
  const previous=process.env.DAILY_DELIVERY_EXECUTION_ACK,oldActions=process.env.GITHUB_ACTIONS;let opened=0,closed=0;
  process.env.DAILY_DELIVERY_EXECUTION_ACK='approved-daily-delivery-v1';process.env.GITHUB_ACTIONS='false';
  try {
    const scheduler=loader({overrides:{'../api/_lib/db':{getDb:async()=>{opened++;return mockDb();},closeDb:async()=>{closed++;}}}})('scripts/run-watchdog-scheduler.js');
    assert.equal((await scheduler.main()).failed,false);assert.equal(opened,1);assert.equal(closed,1);
  } finally {
    if(previous===undefined)delete process.env.DAILY_DELIVERY_EXECUTION_ACK;else process.env.DAILY_DELIVERY_EXECUTION_ACK=previous;
    if(oldActions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=oldActions;
  }
});
test('earlier ambiguous send followed by rejection still requires reconciliation',async()=>{
  const x=fixture({send:async c=>{if(c.sends.length===1)throw Error('unknown');throw Object.assign(Error('auth revoked'),{deliveryDisposition:'permanent_rejection'});}});
  await x.run();x.advance(3600000);assert.equal((await x.run()).status,'needs_review');
});
for(const change of [{settings:{notifications:false}},{active:false},{trialEndsAt:new Date(0)}])test('eligibility changes after ambiguous send do not hide uncertain outcome '+JSON.stringify(change),async()=>{
  const x=fixture({send:async()=>{throw Error('unknown');}});await x.run();x.advance(3600000);Object.assign(x.db.data.users[0],change);
  assert.equal((await x.run()).status,'needs_review');assert.equal(x.calls.sends.length,1);
});
test('real mail helper freezes body/from and key across configuration changes',async()=>{
  const owner=user(),db=mockDb({users:[owner]}),requests=[];
  const helper=loader({db,fetchFn:async(_url,args)=>{requests.push(args);return {ok:true,json:async()=>({id:'provider-message'})};}})('api/send.js').sendWatchdogEmail;
  const report={userEmail:owner.email,targetDate:DATE,findings:[]};
  const payload=await helper({toEmail:owner.email,report,prepareOnly:true});assert.equal(requests.length,0);
  const oldFrom=process.env.FROM_EMAIL;process.env.FROM_EMAIL='changed@example.test';
  try {
    for(let i=0;i<2;i++)await helper({toEmail:owner.email,userName:'changed',report,preparedPayload:payload,idempotencyKey:'fixed-key'});
  } finally {if(oldFrom===undefined)delete process.env.FROM_EMAIL;else process.env.FROM_EMAIL=oldFrom;}
  assert.equal(requests[0].body,requests[1].body);assert.equal(JSON.parse(requests[0].body).from,payload.from);assert.equal(requests[0].headers['Idempotency-Key'],'fixed-key');
  await assert.rejects(helper({toEmail:owner.email,report,preparedPayload:{...payload,bcc:['foreign@example.test']}}),/recipient/);
});
test('real helper executes fencing callback before any provider request',async()=>{
  const owner=user(),db=mockDb({users:[owner]});let sent=0;
  const helper=loader({db,fetchFn:async()=>{sent++;throw Error('Must not send');}})('api/send.js').sendWatchdogEmail;
  await assert.rejects(helper({toEmail:owner.email,report:{userEmail:owner.email},beforeSend:async()=>{throw Error('lease lost');}}),/lease lost/);assert.equal(sent,0);
});
for(const [status,name,disposition] of [[422,'validation_error','permanent_rejection'],[409,'invalid_idempotent_request','payload_conflict'],[409,'concurrent_idempotent_requests','unknown'],[500,'application_error','unknown']])test('real helper classifies provider '+status+'/'+name,async()=>{
  const owner=user(),db=mockDb({users:[owner]});const helper=loader({db,fetchFn:async()=>({ok:false,status,json:async()=>({name})})})('api/send.js').sendWatchdogEmail;
  await assert.rejects(helper({toEmail:owner.email,report:{userEmail:owner.email}}),err=>err.deliveryDisposition===disposition);
});
