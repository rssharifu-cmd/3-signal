// Network-isolated evidence regressions. Never import the production DB module or .env.
for(const key of Object.keys(process.env))if(/MONGODB|RESEND|GOOGLE_CLIENT|BING_CLIENT|JWT_SECRET|GEMINI|TAVILY|PADDLE|OAUTH_TOKEN/.test(key))delete process.env[key];
const blocked=()=>{throw Error('Network access blocked in evidence tests');};global.fetch=blocked;
require('net').Socket.prototype.connect=blocked;require('tls').connect=blocked;
for(const protocol of ['http','https']){require(protocol).request=blocked;require(protocol).get=blocked;}
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module');
const ROOT=path.resolve(__dirname,'..'),NOW='2026-11-01T12:00:00Z';
class Clock extends Date{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return Date.parse(NOW);}}
function matches(row,query){return Object.entries(query).every(([key,want])=>{const got=key.split('.').reduce((v,k)=>v?.[k],row);if(want&&typeof want==='object'&&!Array.isArray(want))return Object.entries(want).every(([op,val])=>op==='$gte'?got>=val:op==='$lte'?got<=val:op==='$ne'?got!==val:op==='$exists'?(got!==undefined)===val:false);return got===want;});}
function database(initial={}){
 const data=Object.fromEntries(Object.entries(initial).map(([k,v])=>[k,v.map(r=>({...r}))])),calls=[];
 return {data,calls,collection(name){const rows=data[name] ||= [];return {
 find(query){calls.push({name,op:'find',query});let found=rows.filter(r=>matches(r,query));return {sort(){found.sort((a,b)=>String(a.date).localeCompare(String(b.date)));return this;},async toArray(){return found.map(r=>({...r}));}};},
 async findOne(query){calls.push({name,op:'findOne',query});return rows.find(r=>matches(r,query)) || null;},
 async updateOne(query,update,{upsert=false}={}){calls.push({name,op:'updateOne',query});let row=rows.find(r=>matches(r,query));let inserted=false;if(!row&&upsert){row={...query,...update.$setOnInsert};rows.push(row);inserted=true;}if(row)Object.assign(row,update.$set);return {upsertedCount:inserted?1:0,modifiedCount:row&&!inserted?1:0};},
 async bulkWrite(ops){let inserted=0,modified=0;for(const op of ops){const r=await this.updateOne(op.updateOne.filter,op.updateOne.update,{upsert:true});inserted+=r.upsertedCount;modified+=r.modifiedCount;}return{upsertedCount:inserted,modifiedCount:modified};},
 async createIndex(){throw Error('Index mutation forbidden in evidence tests');},
 };}};
}
function loader({db=database(),overrides={},fetch=blocked}={}){
 const cache=new Map();function load(file){const absolute=path.resolve(ROOT,file);if(cache.has(absolute))return cache.get(absolute).exports;
 const mod={exports:{}};cache.set(absolute,mod);const actual=createRequire(absolute);
 const isolated=id=>{if(Object.hasOwn(overrides,id))return overrides[id];const resolved=actual.resolve(id);if(resolved===path.join(ROOT,'api/_lib/db.js'))return{getDb:async()=>db};if(resolved.startsWith(ROOT+path.sep)&&!resolved.includes(path.sep+'node_modules'+path.sep))return load(resolved);return actual(id);};
 const context=vm.createContext({console:{log(){},warn(){},error(){}},process,Buffer,URL,URLSearchParams,Date:Clock,fetch,AbortController,AbortSignal,setTimeout,clearTimeout});
 vm.runInContext('(function(require,module,exports){'+fs.readFileSync(absolute,'utf8')+'\n})',context,{filename:absolute})(isolated,mod,mod.exports);return mod.exports;
 }return load;
}
const metrics=loader()('api/_lib/metricSnapshots.js');
function rows(provider='google_search_console',days=56,anchor=metrics.providerDate(provider,new Date(NOW)),extra={}){
 return Array.from({length:days},(_,i)=>({userEmail:'owner@example.test',userId:'owner-id',provider,propertyRef:'property-A',date:metrics.shiftDate(anchor,i-days+1),metrics:provider==='google_analytics'?{sessions:100,users:70,totalUsers:70,newUsers:10,pageViews:150,conversions:10,ecommerceConfigured:true,purchaseCount:10,checkoutCount:20,addToCartCount:30,viewItemCount:60,revenue:100,currencyCode:'EUR',bounceRate:0.2,engagementRate:0.8,averageEngagementTime:30,funnelUnits:'events'}:{clicks:100,impressions:1000,position:3,crawlErrors:0,crawledPages:20},dimensions:{pages:[],queries:[],trafficSources:[],landingPages:[],events:[],devices:[],crawlIssues:[]},dataQuality:{daily:true,dimensions:{pages:true,queries:true,trafficSources:true,landingPages:true,events:true,devices:true,crawlIssues:true}},...extra}));
}
function windows(data){const end=data.at(-1).date;return Object.fromEntries([[1,'today_vs_yesterday'],[7,'last7_vs_prior7'],[28,'last28_vs_prior28']].map(([days,key])=>[key,metrics.buildWindow(data,metrics.shiftDate(end,-days+1),end,metrics.shiftDate(end,-2*days+1),metrics.shiftDate(end,-days),key)]));}
function findings(data){return loader()('api/_lib/anomalies.js').detectAnomalies({userId:'owner-id',comparisonWindows:{[data[0].provider]:windows(data)}});}
test('calendar validation rejects impossible dates and reverse ranges',()=>{assert.equal(metrics.validDate('2026-02-30'),false);assert.throws(()=>metrics.shiftDate('2026-02-30',1));assert.equal(metrics.getCalendarDaysInclusive('2026-11-01','2026-10-01'),0);});
for(const days of [1,7,28])test(days+'d comparisons require every day in both windows',()=>{
 const data=rows();const key=days===1?'today_vs_yesterday':days===7?'last7_vs_prior7':'last28_vs_prior28';assert.equal(windows(data)[key].eligible,true);
 for(const index of [data.length-1,data.length-days-1]){const missing=data.filter((_,i)=>i!==index);const end=data.at(-1).date;const window=metrics.buildWindow(missing,metrics.shiftDate(end,-days+1),end,metrics.shiftDate(end,-2*days+1),metrics.shiftDate(end,-days),key);assert.equal(window.eligible,false);assert.equal(window.changes.clicks.percent,null);}
});
test('two arbitrary snapshots cannot authorize weekly anomaly detection',()=>{const data=rows().filter((_,i)=>[0,55].includes(i));assert.equal(windows(data).last7_vs_prior7.eligible,false);assert.equal(findings(data).length,0);});
test('duplicate dates cannot replace a missing calendar day',()=>{const data=rows();data[54]={...data[53]};assert.equal(windows(data).last7_vs_prior7.eligible,false);});
test('mixed properties/providers/owners are ineligible',()=>{for(const field of ['propertyRef','provider','userEmail']){const data=rows();data[54][field]='foreign';assert.equal(windows(data).last7_vs_prior7.eligible,false);assert.equal(findings(data).length,0);}});
test('complete but stale windows never produce findings',()=>{const data=rows('google_search_console',56,'2026-10-20');assert.equal(windows(data).last7_vs_prior7.eligible,false);assert.equal(findings(data).length,0);});
test('unknown metrics remain null; no ecommerce accidentally inferred',()=>{const aggregate=metrics.aggregateMetrics(rows().map(s=>({...s,metrics:{clicks:0}})));assert.equal(aggregate.clicks,0);assert.equal(aggregate.sessions,null);assert.equal(aggregate.impressions,null);assert.equal(aggregate.revenue,null);assert.equal(aggregate.ecommerceConfigured,false);});
test('one missing metric day makes the period metric unknown, not a partial total',()=>{const data=rows();delete data[54].metrics.clicks;const w=windows(data).last7_vs_prior7;assert.equal(w.currentMetrics.clicks,null);assert.equal(w.changes.clicks.percent,null);assert.equal(findings(data).length,0);});
test('observed genuine zero traffic retains numeric zero and a valid decline',()=>{const data=rows();for(const s of data.slice(-7)){s.metrics={...s.metrics,clicks:0,impressions:0};}const w=windows(data).last7_vs_prior7;assert.equal(w.currentMetrics.clicks,0);assert.equal(w.changes.clicks.percent,-100);assert.ok(findings(data).some(f=>f.type==='organic_traffic_drop'));});
test('56 observed zero search days can support near-zero visibility; 7 cannot',()=>{const data=rows();for(const s of data){s.metrics.clicks=0;s.metrics.impressions=0;}assert.ok(findings(data).some(f=>f.type==='near_zero_search_visibility'));assert.equal(findings(data.slice(-7)).length,0);});
test('legacy fabricated zero placeholders do not become observed zero days',()=>{const data=rows();for(const s of data){s.metrics={clicks:0,impressions:0};delete s.dataQuality;}assert.equal(windows(data).last28_vs_prior28.currentMetrics.clicks,null);assert.equal(findings(data).length,0);});
test('zero baseline growth is undefined, zero-to-zero change is zero',()=>{assert.equal(metrics.computeChanges({clicks:10},{clicks:0}).clicks.percent,null);assert.equal(metrics.computeChanges({clicks:0},{clicks:0}).clicks.percent,0);});
test('rates use weighted fractions; item/purchase units cannot create a conversion rate',()=>{const data=rows('google_analytics',2);data[0].metrics.sessions=10;data[1].metrics.sessions=90;data[0].metrics.bounceRate=0;data[1].metrics.bounceRate=1;data.forEach(s=>s.metrics.funnelUnits='items');const m=metrics.aggregateMetrics(data);assert.equal(m.bounceRate,0.9);assert.equal(m.checkoutToPurchaseRate,null);assert.equal(m.userCountUnit,'user_days');});
test('missing or mixed currencies suppress revenue evidence, never assume dollars',()=>{for(const kind of ['missing','mixed','between']){const data=rows('google_analytics');data.slice(-7).forEach(s=>s.metrics.revenue=0);if(kind==='missing')data.forEach(s=>delete s.metrics.currencyCode);if(kind==='mixed')data.at(-1).metrics.currencyCode='USD';if(kind==='between')data.slice(-7).forEach(s=>s.metrics.currencyCode='USD');assert.equal(findings(data).some(f=>f.type==='ecommerce_revenue_drop'),false);}});
test('known EUR revenue finding preserves currency',()=>{const data=rows('google_analytics');data.slice(-7).forEach(s=>s.metrics.revenue=0);const f=findings(data).find(f=>f.type==='ecommerce_revenue_drop');assert.ok(f);assert.equal(f.evidence.currencyCode,'EUR');assert.match(f.evidence.context,/EUR/);assert.doesNotMatch(f.evidence.context,/\$/);});
test('partial dimension failure suppresses that group, preserves verified site finding',()=>{const data=rows();data.slice(-7).forEach(s=>s.metrics.clicks=0);data.at(-1).dataQuality.dimensions.pages=false;assert.equal(windows(data).last7_vs_prior7.currentDimensions.pages.length,0);assert.ok(findings(data).some(f=>f.scope==='site'));});
test('new properties write independently without altering legacy history or creating indexes',async()=>{
 const legacy=rows()[0],db=database({metric_snapshots:[legacy]}),m=loader({db})('api/_lib/metricSnapshots.js');
 await m.saveMetricSnapshots([legacy,{...legacy,propertyRef:'property-B'}]);assert.equal(db.data.metric_snapshots.length,1);assert.equal(db.data.metric_snapshots_v2.length,2);
 const selected=await m.getMetricSnapshots({userEmail:legacy.userEmail,provider:legacy.provider,propertyRef:'property-B'});assert.equal(selected.length,1);assert.equal(selected[0].propertyRef,'property-B');
 const superseded=await m.getMetricSnapshots({userEmail:legacy.userEmail,provider:legacy.provider,propertyRef:'property-A'});assert.equal(superseded.length,1);
 await assert.rejects(m.getMetricSnapshots({userEmail:legacy.userEmail}));
});
test('loadComparisonWindows uses provider latency rather than global latest cached date',async()=>{const data=rows(),db=database({metric_snapshots:data}),m=loader({db})('api/_lib/metricSnapshots.js');const w=await m.loadComparisonWindows({userEmail:data[0].userEmail,provider:data[0].provider,propertyRef:'property-A',targetDate:'2026-10-31'});assert.equal(w.targetDate,'2026-10-30');assert.equal(w.last28_vs_prior28.eligible,true);});
function pipeline({sources=['google_search_console'],stored=[],fetchers={},intelligence={},userExtra={}}={}){
 const user={_id:'owner-id',email:'owner@example.test',name:'Owner',active:true,profile:{websiteUrl:'https://store.example.test'},...userExtra};
 const db=database({users:[user],datasources:sources.map((provider,i)=>({_id:'source-'+i,userEmail:user.email,provider,status:'connected',encryptedRefreshToken:'synthetic',selectedProperty:{id:'property-A',url:'https://store.example.test'}})),metric_snapshots:stored});
 const calls=[];const fetcher=provider=>async args=>{calls.push(args);if(fetchers[provider] instanceof Error)throw fetchers[provider];return fetchers[provider] || rows(provider);};
 const overrides={'./gsc':{fetchGscPerformance:fetcher('google_search_console')},'./ga4':{fetchGa4Performance:fetcher('google_analytics')},'./bing':{fetchBingPerformance:fetcher('bing_webmaster')},
 './gscUrlInspection':{loadLatestUrlInspection:async()=>null,isInspectionDue:()=>false},'./plans':{getEntitlements:()=>({allowedProviders:['google_search_console','google_analytics','bing_webmaster'],urlInspection:false})},
 './intelligence':{interpretFindings:async()=>({status:'stable',headline:'All systems normal',priorityRankedFindings:[],...intelligence}),buildNoSourcesInterpretation:()=>({status:'no_sources'}),buildInsufficientDataInterpretation:()=>({status:'insufficient_data'})},
 './research':{fetchRssFeed:async()=>[],searchWeb:async()=>[],searchReddit:async()=>[],GOOGLE_SEARCH_CENTRAL_FEED:'https://example.test/feed'}};
 return {db,calls,run:loader({db,overrides})('api/_lib/generateDailyIntelligence.js').generateDailyIntelligence};
}
test('pipeline requires 14 fresh consecutive days, not two snapshots',async()=>{const p=pipeline({stored:rows().slice(-2)});const report=await p.run('owner-id',{skipFetch:true,dryRun:true});assert.equal(report.status,'insufficient_data');});
test('partial provider failure cannot claim all stable, successful provider still evaluated',async()=>{const p=pipeline({sources:['google_search_console','google_analytics'],fetchers:{google_analytics:Error('synthetic unavailable')}});const report=await p.run('owner-id',{dryRun:true});assert.equal(report.status,'insufficient_data');assert.equal(report.coverageIncomplete,true);assert.doesNotMatch(report.intelligence.headline,/all systems normal/i);assert.equal(report.fetchSummary.errors.length,1);assert.ok(report.comparisonWindows.google_search_console.last7_vs_prior7.eligible);});
test('partial history yields qualified no-finding report, not all stable',async()=>{const p=pipeline({stored:rows().slice(-14)});const r=await p.run('owner-id',{skipFetch:true,dryRun:true});assert.equal(r.status,'insufficient_data');assert.equal(r.coverageIncomplete,true);});
test('pipeline fetches both complete 28-day periods for every provider',async()=>{const p=pipeline({sources:['google_search_console','google_analytics','bing_webmaster']});await p.run('owner-id',{dryRun:true});assert.equal(p.calls.length,3);for(const call of p.calls)assert.equal(metrics.getCalendarDaysInclusive(call.startDate,call.endDate),56);});
test('pipeline preserves verified critical findings even if interpreter returns stable and omits them',async()=>{const data=rows();data.slice(-7).forEach(s=>s.metrics.clicks=0);const p=pipeline({sources:['google_search_console','google_analytics'],fetchers:{google_search_console:data,google_analytics:Error('synthetic failure')}});const report=await p.run('owner-id',{dryRun:true});assert.equal(report.status,'critical');assert.ok(report.findings.some(f=>f.severity==='critical'));assert.equal(report.intelligence.priorityRankedFindings.length,report.findings.length);});
test('wrong property, stale cache and empty provider output cannot authorize stability',async()=>{for(const which of ['foreign','stale','empty']){const stored=rows('google_search_console',56,which==='stale'?'2026-10-20':undefined);if(which==='foreign')stored.forEach(s=>s.propertyRef='property-B');const p=pipeline({stored,fetchers:{google_search_console:[]}});const report=await p.run('owner-id',{skipFetch:which!=='empty',dryRun:true});assert.equal(report.status,'insufficient_data',which);}});
test('no-source workflow still reports no_sources without unscoped snapshot reads',async()=>{const p=pipeline({sources:[]});assert.equal((await p.run('owner-id',{dryRun:true})).status,'no_sources');assert.equal(p.db.calls.some(c=>c.name.startsWith('metric_snapshots')),false);});

function apiResponse(data,ok=true){return{ok,status:ok?200:503,json:async()=>data,text:async()=>JSON.stringify(data)};}
test('GSC empty response produces no fabricated snapshot; explicit zero row is retained',async()=>{
 for(const zero of [false,true]){
  const load=loader({fetch:async(_url,options)=>{const body=JSON.parse(options.body);return apiResponse({rows:body.dimensions.length===1&&zero?[{keys:['2026-10-30'],clicks:0,impressions:0,ctr:0,position:0}]:[]});}});
  const result=await load('api/_lib/gsc.js').fetchGscPerformance({accessToken:'synthetic',propertyRef:'https://example.test',startDate:'2026-10-01',endDate:'2026-10-30'});
  assert.equal(result.length,zero?1:0);if(zero){assert.equal(result[0].metrics.clicks,0);assert.equal(result[0].dataQuality.daily,true);}
 }
});
test('GSC optional page failure is explicit while valid site totals remain usable',async()=>{
 const load=loader({fetch:async(_url,options)=>{const body=JSON.parse(options.body);if(body.dimensions.includes('page'))return apiResponse({error:'synthetic'},false);return apiResponse({rows:body.dimensions.length===1?[{keys:['2026-10-30'],clicks:10,impressions:100,ctr:0.1,position:2}]:[]});}});
 const result=await load('api/_lib/gsc.js').fetchGscPerformance({accessToken:'synthetic',propertyRef:'https://example.test'});assert.equal(result[0].dataQuality.dimensions.pages,false);assert.equal(result[0].metrics.clicks,10);
});
function ga4Response(body,{failure=null,empty=false,fallback=false,revenue=0,currency='EUR',sampled=false}={}){
 const names=body.metrics.map(m=>m.name),dimensions=body.dimensions.map(d=>d.name);
 if(failure==='ecommerce'&&names.includes('purchaseRevenue'))return apiResponse({},false);
 if(failure==='channels'&&dimensions.includes('sessionSource'))return apiResponse({},false);
 if(fallback&&names.includes('userEngagementDuration'))return apiResponse({},false);
 const metadata={currencyCode:currency,...(sampled?{samplingMetadatas:[{samplesReadCount:'1'}]}:{})};
 if(empty)return apiResponse({rows:[],metricHeaders:names.map(name=>({name})),metadata});
 if(dimensions.length===1){const values={sessions:0,totalUsers:0,newUsers:0,screenPageViews:0,engagementRate:0,bounceRate:0,userEngagementDuration:0,ecommercePurchases:1,purchaseRevenue:revenue,itemsAddedToCart:2,itemsCheckedOut:3,itemsViewed:5};return apiResponse({metricHeaders:names.map(name=>({name})),metadata,rows:[{dimensionValues:[{value:'20261031'}],metricValues:names.map(n=>({value:String(values[n]??0)}))}]});}
 return apiResponse({rows:[],rowCount:0,metadata});
}
for(const mode of ['empty','fallback','ecommerce','channels','sampled'])test('GA4 '+mode+' preserves unknown/failure provenance',async()=>{
 const load=loader({fetch:async(_url,options)=>ga4Response(JSON.parse(options.body),{empty:mode==='empty',fallback:mode==='fallback',failure:mode,sampled:mode==='sampled'})});
 const result=await load('api/_lib/ga4.js').fetchGa4Performance({accessToken:'synthetic',propertyRef:'properties/42'});
 if(mode==='empty'){assert.equal(result.length,0);return;}
 assert.equal(result[0].metrics.sessions,0);
 if(mode==='fallback'){assert.equal(result[0].metrics.newUsers,null);assert.equal(result[0].metrics.averageEngagementTime,null);}
 if(mode==='ecommerce'){assert.equal(result[0].metrics.revenue,null);assert.equal(result[0].metrics.conversions,null);assert.ok(result[0].dataQuality.warnings.length);}
 if(mode==='channels')assert.equal(result[0].dataQuality.dimensions.trafficSources,false);
 if(mode==='sampled')assert.equal(result[0].dataQuality.daily,false);
});
test('negative native revenue is preserved as money, not changed to missing or zero',async()=>{
 const load=loader({fetch:async(_url,options)=>ga4Response(JSON.parse(options.body),{revenue:-5})});
 const result=await load('api/_lib/ga4.js').fetchGa4Performance({accessToken:'synthetic',propertyRef:'properties/42'});
 assert.equal(result[0].metrics.revenue,-5);assert.equal(metrics.aggregateMetrics(result).revenue,-5);
});
test('Bing traffic failure cannot be hidden behind successful optional responses',async()=>{
 const load=loader({fetch:async url=>String(url).includes('GetRankAndTrafficStats')?apiResponse({},false):apiResponse({d:[]})});
 await assert.rejects(load('api/_lib/bing.js').fetchBingPerformance({accessToken:'synthetic',propertyRef:'https://example.test'}),/daily traffic request failed/);
});
test('Bing query/crawl-only dates do not invent zero daily traffic',async()=>{
 const load=loader({fetch:async url=>apiResponse({d:String(url).includes('GetQueryStats')?[{Date:'2026-10-31',Query:'test',Clicks:10,Impressions:100}]:[]})});
 assert.equal((await load('api/_lib/bing.js').fetchBingPerformance({accessToken:'synthetic',propertyRef:'https://example.test'})).length,0);
});
test('incomplete rerun preserves previous verified evidence as historical, never current',async()=>{
 const p=pipeline({fetchers:{google_search_console:Error('synthetic failure')}});
 const old={id:'verified',severity:'critical',confidence:0.95,evidence:{provider:'google_search_console',metric:'clicks'}};
 p.db.data.intelligence_reports=[{reportId:'previous',userEmail:'owner@example.test',targetDate:'2026-10-31',generatedAt:new Date('2026-10-31'),findings:[old]}];
 const report=await p.run('owner-id');assert.equal(report.status,'insufficient_data');assert.equal(report.findings.length,0);assert.equal(report.previousVerifiedEvidence.currentlyRevalidated,false);assert.equal(report.previousVerifiedEvidence.findings[0].id,old.id);
});

test('missing per-entity day cannot be zero-filled into a page decline',()=>{
 const data=rows();for(const s of data)s.dimensions.pages=[{page:'/important',clicks:20,impressions:200,position:3}];
 data.slice(-7).forEach(s=>s.dimensions.pages[0].clicks=2);data.at(-1).dimensions.pages=[];
 const w=windows(data).last7_vs_prior7;assert.equal(w.currentDimensions.pages.length,0);
 assert.equal(findings(data).some(f=>f.scope==='page'),false);
});
test('fully observed dimension evidence still produces a verified page finding',()=>{
 const data=rows();for(const s of data)s.dimensions.pages=[{page:'/important',clicks:20,impressions:200,position:3}];data.slice(-7).forEach(s=>s.dimensions.pages[0].clicks=2);
 assert.ok(findings(data).some(f=>f.scope==='page'&&f.type==='organic_traffic_drop'));
});
test('coverage diagnostics name the exact missing comparison date',()=>{
 const data=rows();const missing=data[50].date;const remaining=data.filter(s=>s.date!==missing);const w=windows(remaining).last7_vs_prior7;
 assert.ok(w.currentRange.missingDates.includes(missing));
});

test('complete fresh healthy evidence retains a qualified stable result',async()=>{
 const p=pipeline();const report=await p.run('owner-id',{dryRun:true});assert.equal(report.status,'stable');assert.equal(report.coverageIncomplete,false);assert.doesNotMatch(report.intelligence.headline,/all systems normal/i);
});
test('unsupported native item funnel cannot authorize overall stable',async()=>{
 const data=rows('google_analytics');data.forEach(s=>s.metrics.funnelUnits='items');const p=pipeline({sources:['google_analytics'],fetchers:{google_analytics:data}});
 const report=await p.run('owner-id',{dryRun:true});assert.equal(report.coverageIncomplete,true);assert.equal(report.status,'insufficient_data');assert.equal(report.storePerformance.checkoutToPurchaseRate,null);
});
test('invalid/future report dates fail before fetching provider data',async()=>{
 for(const targetDate of ['2026-02-30','2026-11-02']){const p=pipeline();await assert.rejects(p.run('owner-id',{targetDate,dryRun:true}),/valid completed UTC day/);assert.equal(p.calls.length,0);}
});

test('overlapping or unequal periods cannot be compared',()=>{
 const data=rows(),end=data.at(-1).date;
 const w=metrics.buildWindow(data,metrics.shiftDate(end,-6),end,metrics.shiftDate(end,-7),metrics.shiftDate(end,-1),'last7_vs_prior7');assert.equal(w.eligible,false);assert.equal(w.coverage.aligned,false);
});
test('missing daily query positions do not create a ranking change',()=>{
 const data=rows();for(const s of data)s.dimensions.queries=[{query:'example',clicks:10,impressions:200,position:3}];data.slice(-7).forEach(s=>s.dimensions.queries[0].position=8);delete data[45].dimensions.queries[0].position;
 assert.equal(findings(data).some(f=>f.type==='ranking_position_drop'),false);
});
test('daily landing bounce rates are session-weighted and absent rates stay unknown',()=>{
 const data=rows('google_analytics');for(const s of data)s.dimensions.landingPages=[{page:'/',sessions:10,users:5,pageViews:20,bounceRate:0}];data.at(-1).dimensions.landingPages[0]={page:'/',sessions:90,users:20,pageViews:100,bounceRate:1};
 assert.equal(windows(data).last7_vs_prior7.currentDimensions.landingPages[0].bounceRate,0.6);
 delete data.at(-1).dimensions.landingPages[0].bounceRate;assert.equal(windows(data).last7_vs_prior7.currentDimensions.landingPages[0].bounceRate,null);
});
