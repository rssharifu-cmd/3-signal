const {test}=require('node:test');
const assert=require('node:assert/strict');
const bcrypt=require('bcryptjs');
const {mockDb,loader,call,user,token,response}=require('./test-helpers/securityHarness');
function setup(initial={}) { const db=mockDb(initial),sent=[];const load=loader({db,fetchFn:async(url,options)=>{sent.push(JSON.parse(options.body));return response({id:'mock'});}}); return {db,sent,load,auth:load('api/auth.js')}; }
const post=(action,extra={})=>({email:null,body:{action,email:'owner@example.com',...extra}});
for (const passwordHash of ['', 'existing-hash']) test('S1 verified signup cannot replace password '+passwordHash,async()=>{
 const existing=user({passwordHash}),x=setup({users:[existing]});const r=await call(x.auth,post('signup',{password:'attacker-password'}));
 assert.equal(r.statusCode,202);assert.equal(r.body.token,undefined);assert.deepEqual(x.db.data.users,[existing]);assert.equal(x.sent.length,0);
});
test('pending signup sends fixed email, stores only hash, password set after single-use verification',async()=>{
 const x=setup(); const r=await call(x.auth,post('signup',{password:'attacker-password',html:'arbitrary'}));assert.equal(r.statusCode,202);assert.equal(r.body.token,undefined);
 const u=x.db.data.users[0];assert.equal(u.passwordHash,'');assert.equal(x.sent.length,1);assert.deepEqual(x.sent[0].to,['owner@example.com']);assert.equal(x.sent[0].html,undefined);
 const raw=x.sent[0].text.match(/#verify=([a-f0-9]{64})/)[1];assert.notEqual(u.verification.hash,raw);
 const done=await call(x.auth,post('complete_verification',{token:raw,password:'new strong password'}));assert.equal(done.statusCode,200);assert.ok(await bcrypt.compare('new strong password',u.passwordHash));assert.equal(u.verification,undefined);
 assert.equal((await call(x.auth,post('complete_verification',{token:raw,password:'different password'}))).statusCode,400);
 assert.equal((await call(x.auth,post('login',{password:'new strong password'}))).statusCode,200);
 assert.equal((await call(x.auth,post('login',{password:'wrong password'}))).statusCode,401);
 assert.equal((await call(x.auth,{method:'GET',bearer:done.body.token})).statusCode,200);
});
test('expired and weak-password verification cannot activate account',async()=>{
 const x=setup();await call(x.auth,post('signup'));const raw=x.sent[0].text.match(/#verify=([a-f0-9]{64})/)[1];
 assert.equal((await call(x.auth,post('complete_verification',{token:raw,password:'short'}))).statusCode,400);
 x.db.data.users[0].verification.expiresAt=new Date(0);
 assert.equal((await call(x.auth,post('complete_verification',{token:raw,password:'long enough password'}))).statusCode,400);assert.equal(x.db.data.users[0].emailVerifiedAt,undefined);
});
test('signup address limits and cooldown block repeated delivery and fail closed',async()=>{
 const x=setup();assert.equal((await call(x.auth,post('signup'))).statusCode,202);assert.equal((await call(x.auth,post('signup'))).statusCode,429);assert.equal(x.sent.length,1);
 const bad=loader({db:{collection(){throw Error('unavailable');}}})('api/auth.js');assert.equal((await call(bad,post('login',{password:'test'}))).statusCode,503);
});
test('unverified accounts and legacy/stale/wrong-purpose sessions denied across protected routes',async()=>{
 const old=user({emailVerifiedAt:undefined,authVersion:undefined});const x=setup({users:[old]});
 for(const file of ['api/auth.js','api/user.js','api/send.js','api/watchdog.js','api/datasources.js','api/admin-status.js']) assert.equal((await call(x.load(file),{method:file==='api/send.js'?'POST':'GET'})).statusCode,401,file);
 const good=setup({users:[user()]});
 for(const extra of [{purpose:undefined,av:undefined},{purpose:'oauth_state'},{purpose:'paddle_checkout_link'},{av:'stale'}]) assert.equal((await call(good.auth,{method:'GET',bearer:token(undefined,extra)})).statusCode,401);
 assert.equal((await call(good.auth,{method:'GET'})).statusCode,200);
});
for(const claiming of [true,false]) test('verified Google claim '+claiming+' preserves profile and invalidates unsafe credentials',async()=>{
 const existing=user({passwordHash:'existing-hash',...(claiming?{emailVerifiedAt:undefined,authVersion:undefined}:{})}),db=mockDb({users:[existing]});
 class OAuth2Client {async verifyIdToken(){return {getPayload:()=>({email:existing.email,email_verified:true,hd:'example.com',sub:'google-sub',name:'Owner'})};}}
 const auth=loader({db,overrides:{'google-auth-library':{OAuth2Client}}})('api/auth.js'); const r=await call(auth,post('google',{credential:'mock'}));assert.equal(r.statusCode,200);
 const u=db.data.users[0];assert.deepEqual(u.profile,existing.profile);assert.equal(u.passwordHash,claiming?'':'existing-hash');assert.equal(Boolean(u.configurationReviewRequired),claiming);
 if(claiming) assert.notEqual(u.authVersion,'fixture-version');else assert.equal(u.authVersion,'fixture-version');
});
test('unverified Google identity rejected before user mutation',async()=>{
 const db=mockDb();class OAuth2Client{async verifyIdToken(){return {getPayload:()=>({email:'owner@example.com',email_verified:false,sub:'sub'})};}}
 const r=await call(loader({db,overrides:{'google-auth-library':{OAuth2Client}}})('api/auth.js'),post('google',{credential:'mock'}));assert.equal(r.statusCode,401);assert.equal((db.data.users||[]).length,0);
});

function googleSetup(existing, identity) {
 const db=mockDb({users:existing?[existing]:[]}),sent=[];
 class OAuth2Client {async verifyIdToken(){return {getPayload:()=>identity};}}
 const load=loader({db,overrides:{'google-auth-library':{OAuth2Client}},fetchFn:async(_url,options)=>{sent.push(JSON.parse(options.body));return response({id:'mock'});}});
 return {db,sent,auth:load('api/auth.js')};
}
for(const legacy of [true,false]) test('P1 Google subject mismatch cannot overwrite '+(legacy?'legacy':'verified')+' binding',async()=>{
 const existing=user({googleSub:'established-sub',...(legacy?{emailVerifiedAt:undefined,authVersion:undefined}:{})});
 const x=googleSetup(existing,{email:existing.email,email_verified:true,hd:'example.com',sub:'different-sub'});
 const r=await call(x.auth,post('google',{credential:'mock'}));assert.equal(r.statusCode,403);assert.equal(r.body.token,undefined);assert.deepEqual(x.db.data.users,[existing]);
});
for(const kind of ['new','legacy','verified-unbound']) test('P1 recycled unmanaged email cannot claim '+kind+' account',async()=>{
 const existing=kind==='new'?null:user(kind==='legacy'?{emailVerifiedAt:undefined,authVersion:undefined}:{});
 const x=googleSetup(existing,{email:'owner@example.com',email_verified:true,sub:'old-unmanaged-sub'});
 const r=await call(x.auth,post('google',{credential:'mock'}));assert.equal(r.statusCode,401);assert.equal(r.body.error,'verification_required');assert.equal(r.body.token,undefined);
 assert.deepEqual(x.db.data.users,existing?[existing]:[]);assert.equal(x.sent.length,0);
});
for(const kind of ['gmail','workspace']) test('P1 authoritative '+kind+' safely migrates legacy account',async()=>{
 const email=kind==='gmail'?'owner@gmail.com':'owner@example.com';const existing=user({email,emailVerifiedAt:undefined,authVersion:undefined,passwordHash:'unsafe-old-password'});
 const x=googleSetup(existing,{email,email_verified:true,sub:'safe-sub',...(kind==='workspace'?{hd:'example.com'}:{})});
 const r=await call(x.auth,post('google',{credential:'mock'}));assert.equal(r.statusCode,200);assert.equal(x.db.data.users[0].passwordHash,'');assert.equal(x.db.data.users[0].googleSub,'safe-sub');assert.equal(x.db.data.users[0].inboxVerifiedAt,undefined);
});
test('P1 established verified unmanaged Google subject retains legitimate login',async()=>{
 const existing=user({googleSub:'established-sub',passwordHash:'preserve'});const x=googleSetup(existing,{email:existing.email,email_verified:true,sub:'established-sub'});
 assert.equal((await call(x.auth,post('google',{credential:'mock'}))).statusCode,200);assert.equal(x.db.data.users[0].authVersion,existing.authVersion);assert.equal(x.db.data.users[0].passwordHash,'preserve');
});
test('P1 legacy unmanaged Google login requires inbox proof then preserves its binding',async()=>{
 const existing=user({emailVerifiedAt:undefined,authVersion:undefined,googleSub:'established-sub',passwordHash:''});
 const x=googleSetup(existing,{email:existing.email,email_verified:true,sub:'established-sub'});
 assert.equal((await call(x.auth,post('google',{credential:'mock'}))).statusCode,401);
 await call(x.auth,post('request_verification'));const raw=x.sent[0].text.match(/#verify=([a-f0-9]{64})/)[1];
 const verified=await call(x.auth,post('complete_verification',{token:raw,password:'fresh owner password'}));assert.equal(verified.statusCode,200);
 assert.equal(x.db.data.users[0].googleSub,'established-sub');assert.equal((await call(x.auth,post('google',{credential:'mock'}))).statusCode,200);
});
test('P1 unsafe first Google link requires both fresh inbox proof and its owner session',async()=>{
 const x=googleSetup(null,{email:'owner@example.com',email_verified:true,sub:'new-sub'});
 await call(x.auth,post('signup'));const raw=x.sent[0].text.match(/#verify=([a-f0-9]{64})/)[1];
 const verified=await call(x.auth,post('complete_verification',{token:raw,password:'fresh owner password'}));assert.equal(verified.statusCode,200);
 assert.ok(x.db.data.users[0].inboxVerifiedAt);assert.equal((await call(x.auth,post('google',{credential:'mock'}))).statusCode,401);
 const linked=await call(x.auth,{email:'owner@example.com',bearer:verified.body.token,body:{action:'google',credential:'mock'}});assert.equal(linked.statusCode,200);assert.equal(x.db.data.users[0].googleSub,'new-sub');assert.equal(x.db.data.users[0].authProvider,'both');
 assert.equal((await call(x.auth,post('google',{credential:'mock'}))).statusCode,200);
});
for(const reason of ['expired','missing-proof','stale-session','foreign-session']) test('P1 unsafe first Google link rejects '+reason,async()=>{
 const existing=user({inboxVerifiedAt:reason==='missing-proof'?undefined:new Date(Date.now()-(reason==='expired'?31*60000:0))});
 const x=googleSetup(existing,{email:existing.email,email_verified:true,sub:'unsafe-sub'});
 if(reason==='foreign-session')x.db.data.users.push(user({_id:'222222222222222222222222',email:'other@example.com'}));
 const r=await call(x.auth,{email:'owner@example.com',bearer:token(reason==='foreign-session'?'other@example.com':'owner@example.com',reason==='stale-session'?{av:'stale'}:{}),body:{action:'google',credential:'mock'}});
 assert.equal(r.statusCode,reason==='foreign-session'?403:401);assert.equal(x.db.data.users[0].googleSub,undefined);
});
test('P1 concurrent first Google bindings cannot overwrite each other',async()=>{
 const existing=user(),db=mockDb({users:[existing]});
 class OAuth2Client {async verifyIdToken({idToken}){return {getPayload:()=>({email:existing.email,email_verified:true,hd:'example.com',sub:idToken})};}}
 const h=loader({db,overrides:{'google-auth-library':{OAuth2Client}}})('api/auth.js');
 const results=await Promise.all(['first-sub','second-sub'].map(credential=>call(h,post('google',{credential}))));
 assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);assert.equal(db.data.users[0].googleSub,'first-sub');
});
