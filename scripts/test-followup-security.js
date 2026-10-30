const {test}=require('node:test');const assert=require('node:assert/strict');
const {mockDb,loader,call,user,response}=require('./test-helpers/securityHarness');
const {analyze,inspect}=require('./check-security-indexes');
test('exact deployment origins reject suffix tricks and cross-environment origins',()=>{
 const o=loader()('api/_lib/origins.js');
 for(const bad of ['https://evil.vercel.app','https://evil.run.app','https://sharflow.online.evil.test','https://sharflow.online@evil.test','https://staging.sharflow.online','http://localhost:3000','https://www.sharflow.online'])assert.equal(o.isTrustedOrigin(bad),false,bad);
 assert.equal(o.isTrustedOrigin('https://sharflow.online'),true);
 assert.equal(o.getSafeReturnUrl('https://evil.test'),'/#sources');
});
test('staging callback and host-only cookie do not depend on NODE_ENV or hostile Host',async()=>{
 const previous=process.env.APP_ENV;process.env.APP_ENV='staging';try{
 const db=mockDb({users:[user()]});const h=loader({db})('api/oauth.js');
 const r=await call(h,{method:'GET',url:'/api/oauth?action=url&provider=bing_webmaster',headers:{host:'evil.vercel.app',origin:'https://staging.sharflow.online'}});
 assert.equal(r.statusCode,200);assert.equal(r.body.redirectUri,'https://staging.sharflow.online/api/oauth-callback');assert.match(r.headers['Set-Cookie'],/HttpOnly; Secure/);assert.doesNotMatch(r.headers['Set-Cookie'],/Domain=/);
 assert.equal((await call(h,{method:'GET',url:'/api/oauth?action=url&provider=bing_webmaster',headers:{origin:'https://sharflow.online'}})).statusCode,403);
 }finally{process.env.APP_ENV=previous;}
});
test('rate counters atomic parallel limit and no plaintext identity',async()=>{
 const db=mockDb();const {limit}=loader({db})('api/_lib/rateLimits.js');
 const results=await Promise.allSettled(Array.from({length:8},()=>limit(db,'test','private@example.com',3,60,new Date('2026-01-01T00:00:01Z'))));
 // All increments land before promises resume: conservative denial is acceptable, never over-admit.
 assert.ok(results.filter(r=>r.status==='fulfilled').length<=3);assert.equal(db.data.auth_rate_limits[0].count,8);assert.doesNotMatch(db.data.auth_rate_limits[0]._id,/private/);
});
test('untrusted forwarded IP cannot bypass socket-based limit',()=>{
 const {clientIp}=loader()('api/_lib/rateLimits.js');assert.equal(clientIp({socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'1.2.3.4','x-vercel-forwarded-for':'1.2.3.4'}}),'127.0.0.1');
});
test('login brute force limited without sending mail',async()=>{
 const db=mockDb({users:[user({passwordHash:''})]});let sent=0;const h=loader({db,fetchFn:async()=>{sent++;return response({});}})('api/auth.js');
 for(let i=0;i<5;i++) assert.equal((await call(h,{body:{action:'login',email:'owner@example.com',password:'wrong'}})).statusCode,401);
 assert.equal((await call(h,{body:{action:'login',email:'owner@example.com',password:'wrong'}})).statusCode,429);assert.equal(sent,0);
});
test('configuration review blocks checkout, monitoring, integrations and delivery',async()=>{
 const db=mockDb({users:[user({configurationReviewRequired:true})]});const l=loader({db});
 for(const file of ['api/user.js','api/watchdog.js','api/datasources.js','api/send.js']) assert.equal((await call(l(file),{body:{action:'checkout_token'}})).statusCode,403,file);
 assert.equal((await call(l('api/auth.js'),{method:'GET'})).statusCode,200);
});
test('internal delivery rejects unverified owner even without HTTP middleware',async()=>{
 const db=mockDb({users:[user({emailVerifiedAt:undefined})]});const send=loader({db})('api/send.js').sendWatchdogEmail;
 await assert.rejects(send({toEmail:'owner@example.com',report:{userEmail:'owner@example.com'}}),/Verified/);
});
test('index checker rejects legacy extra uniqueness and missing TTL',()=>{
 assert.ok(analyze('oauth_attempts',[{name:'_id_',key:{_id:1}},{name:'email_1_provider_1',key:{email:1,provider:1},unique:true}]).length>=2);
 assert.deepEqual(analyze('auth_rate_limits',[{key:{_id:1}},{key:{expiresAt:1},expireAfterSeconds:0}]),[]);
 assert.ok(analyze('users',[{key:{_id:1}},{key:{email:1},unique:true,sparse:true}]).length>0);
});
test('index checker uses metadata only, never creates or reads documents',async()=>{
 const seen=[];const db={listCollections:q=>({toArray:async()=>{seen.push(q.name);return [{name:q.name,options:{}}];}}),collection:name=>({listIndexes:()=>({toArray:async()=>[{key:{_id:1}},...(name==='users'?[{key:{email:1},unique:true}]:name==='email_send_guards'?[]:[{key:{expiresAt:1},expireAfterSeconds:0}])]})})};
 const results=await inspect(db);assert.equal(seen.length,4);assert.ok(Object.values(results).every(x=>x.length===0));
});

test('legacy integration credentials blocked before token refresh',async()=>{
 const db=mockDb({users:[user({integrationResetAt:new Date()})],datasources:[{userEmail:'owner@example.com',provider:'bing_webmaster',encryptedRefreshToken:'untrusted-old-token'}]});
 const l=loader({db});await assert.rejects(l('api/_lib/oauthTokens.js').getBingAccessToken('owner@example.com'),/No Bing|Reconnect|connected/);
});
test('explicit profile review saves and restores protected access',async()=>{
 const db=mockDb({users:[user({configurationReviewRequired:true})]});const l=loader({db});
 assert.equal((await call(l('api/user.js'),{body:{profile:{websiteUrl:'https://store.example',summary:'Confirmed'},reviewConfirmed:true}})).statusCode,200);
 assert.equal(db.data.users[0].configurationReviewRequired,false);
 assert.equal((await call(l('api/user.js'),{body:{action:'checkout_token'}})).statusCode,200);
});
test('parallel verification completion issues only one session and clears legacy checkout token',async()=>{
 const db=mockDb({users:[user({emailVerifiedAt:undefined,authVersion:undefined,passwordHash:'old',pendingPaddleCheckoutToken:{token:'old'}})]});let raw;
 const l=loader({db,fetchFn:async(url,options)=>{raw=JSON.parse(options.body).text.match(/#verify=([a-f0-9]{64})/)[1];return response({});}}),h=l('api/auth.js');
 await call(h,{body:{action:'signup',email:'owner@example.com'}});
 const options={body:{action:'complete_verification',token:raw,password:'safe new password'}};
 const results=await Promise.all([call(h,options),call(h,options)]);assert.deepEqual(results.map(x=>x.statusCode).sort(),[200,400]);
 assert.equal(db.data.users[0].pendingPaddleCheckoutToken,undefined);assert.equal(db.data.users[0].configurationReviewRequired,true);
});
test('new enrollment and review gates do not expose token hashes or version in public response',async()=>{
 const db=mockDb({users:[user({verification:{hash:'sensitive'},pendingPaddleCheckoutToken:{token:'sensitive'}})]});const r=await call(loader({db})('api/auth.js'),{method:'GET'});
 assert.equal(r.statusCode,200);for(const key of ['passwordHash','verification','authVersion','pendingPaddleCheckoutToken'])assert.equal(r.body.user[key],undefined);
});

test('direct monitoring pipeline refuses unverified or review-required accounts before source reads',async()=>{
 for(const extra of [{emailVerifiedAt:undefined},{configurationReviewRequired:true}]) {
  const db=mockDb({users:[user(extra)]});const pipeline=loader({db})('api/_lib/generateDailyIntelligence.js');
  await assert.rejects(pipeline.generateDailyIntelligence('owner@example.com'),/Verified and reviewed/);
  assert.ok(db.calls.every(c=>c.name==='users'&&c.op==='findOne'));
 }
});
