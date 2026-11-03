const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),vm=require('vm');
const {loader,mockDb}=require('./test-helpers/securityHarness');
const email=loader({db:mockDb()})('api/send.js');
const app=fs.readFileSync(require('path').join(__dirname,'../js/app.js'),'utf8');
const code=app.slice(app.indexOf('function renderWatchdogReportHtml('),app.indexOf('\nfunction renderWatchdogReport(',app.indexOf('function renderWatchdogReportHtml(')));
const context=vm.createContext({escapeHtml:v=>String(v??'').replaceAll('<','&lt;'),getSavedForm:()=>({}),matchesUserPreferences:()=>true});vm.runInContext(code,context);
const renderers={email:report=>email.watchdogReportHtml({report}),dashboard:report=>context.renderWatchdogReportHtml(report)};
const base=()=>({status:'stable',findings:[],intelligence:{status:'stable',priorityRankedFindings:[]},userPreferences:[],storePerformance:{configured:true,sessions:null,users:null,revenue:100,currencyCode:'EUR',addToCartCount:10,checkoutCount:5,purchaseCount:1,checkoutToPurchaseRate:null}});
for(const [name,render]of Object.entries(renderers)){
 test(name+' preserves unknown sessions, currency and unsupported conversion',()=>{const html=render(base());assert.match(html,/Unknown sessions/);assert.match(html,/EUR 100/);assert.doesNotMatch(html,/\$100|All systems normal|steady|20\.0%|undefined%|NaN/i);assert.match(html,/Funnel conversion unavailable/);});
 test(name+' preserves genuine zeros and verified rate',()=>{const r=base();Object.assign(r.storePerformance,{sessions:0,users:0,revenue:0,checkoutToPurchaseRate:0});const html=render(r);assert.match(html,/0 sessions/);assert.match(html,/EUR 0/);assert.match(html,/Checkout conversion: 0\.0%/);});
 test(name+' missing currency and optional metrics remain unknown without crashing',()=>{const r=base();r.storePerformance={configured:true};const html=render(r);assert.match(html,/Unknown sessions/);assert.doesNotMatch(html,/\$|undefined%|NaN/);});
 test(name+' partial coverage retains canonical findings omitted by interpreter',()=>{const r=base();r.coverageIncomplete=true;r.status='critical';r.findings=[{id:'verified',severity:'critical',type:'organic_traffic_drop',title:'Verified decline',evidence:{context:'Observed decline',metric:'clicks'}}];const html=render(r);assert.match(html,/Monitoring evidence incomplete/);assert.match(html,/Verified decline/);assert.doesNotMatch(html,/All systems normal|steady funnel/i);});
 test(name+' multi-day users explicitly mean user-days',()=>{const r=base();Object.assign(r.storePerformance,{users:20,userCountUnit:'user_days'});assert.match(render(r),/20 user-days/);});
 test(name+' stable wording stays limited to evaluated periods',()=>{assert.doesNotMatch(render(base()),/All systems normal|all traffic sources|no significant drops|performance steady/i);});
}
test('email subject communicates incomplete coverage',()=>{const r=base();r.coverageIncomplete=true;assert.doesNotMatch(email.getWatchdogEmailSubject(r),/All systems normal/i);assert.match(email.getWatchdogEmailSubject(r),/baseline|incomplete/i);});
for(const [name,render]of Object.entries(renderers)){
 test(name+' legacy stable prose cannot reintroduce unsupported reassurance',()=>{const r=base();Object.assign(r.intelligence,{headline:'All systems normal',summary:'Store performance steady'});assert.doesNotMatch(render(r),/All systems normal|performance steady/i);});
 test(name+' partial evidence keeps critical alert prominent',()=>{const r=base();r.coverageIncomplete=true;r.status='critical';r.intelligence.status='critical';r.findings=[{id:'critical',severity:'critical',title:'Verified critical decline'}];const html=render(r);assert.match(html,/Critical Attention|CRITICAL ATTENTION/);assert.match(html,/Monitoring evidence incomplete/);assert.match(html,/Verified critical decline/);});
}
