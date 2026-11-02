/** Property-scoped evidence storage. Legacy records remain read-only and format-compatible. */
const { getDb } = require('./db');
const { createHash } = require('crypto');
const LEGACY_COLLECTION = 'metric_snapshots';
const COLLECTION_NAME = 'metric_snapshots_v2';
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validDate(value) {
 return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
}
function providerDate(provider, now = new Date()) { return shiftDate(now.toISOString().slice(0,10), provider === 'google_search_console' || provider === 'gsc' ? -2 : -1); }
function snapshotDocument(s) {
 if (!s.userEmail || !s.provider || !s.propertyRef || !validDate(s.date)) throw Error('Snapshot requires owner, provider, property and valid calendar date');
 return {userId:s.userId || null,userEmail:s.userEmail,provider:s.provider,propertyRef:String(s.propertyRef),date:s.date,
  metrics:s.metrics || {},dimensions:s.dimensions || {},...(s.dataQuality ? {dataQuality:s.dataQuality} : {}),updatedAt:new Date()};
}
async function saveMetricSnapshot(snapshot) { return saveMetricSnapshots([snapshot]); }
async function saveMetricSnapshots(snapshots) {
 if (!Array.isArray(snapshots) || !snapshots.length) return 0;
 const docs=snapshots.map(snapshotDocument);const db=await getDb();
 const ops=docs.map(doc=>({updateOne:{filter:{_id:createHash('sha256').update(JSON.stringify([doc.userEmail,doc.provider,doc.propertyRef,doc.date])).digest('hex')},
  update:{$set:doc,$setOnInsert:{createdAt:new Date()}},upsert:true}}));
 const result=await db.collection(COLLECTION_NAME).bulkWrite(ops,{ordered:false});
 return (result.upsertedCount || 0)+(result.modifiedCount || 0);
}
async function getMetricSnapshots({userId,userEmail,provider,propertyRef,startDate,endDate}) {
 if ((!userEmail && !userId) || !provider || !propertyRef) throw Error('Scoped snapshot owner, provider and property required');
 const query={...(userEmail?{userEmail}:{userId}),provider,propertyRef:String(propertyRef)};
 if(startDate || endDate) query.date={...(startDate?{$gte:startDate}:{}),...(endDate?{$lte:endDate}:{})};
 const db=await getDb();
 const legacy=await db.collection(LEGACY_COLLECTION).find(query).sort({date:1}).toArray();
 const current=await db.collection(COLLECTION_NAME).find(query).sort({date:1}).toArray();
 // A v2 record supersedes the same legacy date; duplicates within one store remain visible and ineligible.
 const replaced=new Set(current.map(row=>row.date));
 return [...legacy.filter(row=>!replaced.has(row.date)),...current].sort((a,b)=>a.date.localeCompare(b.date));
}
async function getLatestSnapshotDate(params) {
 const rows=await getMetricSnapshots(params);return rows.filter(row=>validDate(row.date)).at(-1)?.date || null;
}

/**
 * Shifts a YYYY-MM-DD date string by a given number of days.
 * @param {string} dateStr
 * @param {number} daysDelta
 * @returns {string} YYYY-MM-DD
 */
function shiftDate(dateStr, daysDelta) {
  if (!validDate(dateStr) || !Number.isInteger(daysDelta)) throw Error("Invalid calendar date shift");
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + daysDelta);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Calculates aggregate totals and averages for a slice of snapshot records.
 * @param {Array<object>} slice
 * @returns {object}
 */
function aggregateMetrics(slice = []) {
 const rows=slice.map(s=>{
  const m=s.metrics || {};
  const core=s.provider==='google_analytics'?['sessions','users','pageViews']:['clicks','impressions'];
  // Legacy fabricated empty-result placeholders have no proof of an observed zero day.
  const legacyZero=!s.dataQuality && core.every(k=>m[k]===0);
  return legacyZero ? {} : m;
 });
 const sum=(name,alias)=>rows.length && rows.every(m=>name==='revenue'?typeof m[name]==='number'&&Number.isFinite(m[name]):finite(m[name] ?? (alias?m[alias]:undefined))) ? rows.reduce((n,m)=>n+(m[name] ?? m[alias]),0) : null;
 const out={count:slice.length};
 for(const name of ['clicks','impressions','sessions','newUsers','returningUsers','pageViews','conversions','viewItemCount','addToCartCount','checkoutCount','purchaseCount','revenue']) out[name]=sum(name);
 out.userCountUnit=slice.length===1?'users':'user_days';
 out.users=sum('users','totalUsers');out.totalUsers=out.users;
 const currencies=new Set(rows.map(m=>m.currencyCode));
 out.currencyCode=currencies.size===1 && /^[A-Z]{3}$/.test([...currencies][0] || '') ? [...currencies][0] : null;
 if(!out.currencyCode) out.revenue=null;
 const ratio=(n,d,scale=1)=>finite(n)&&finite(d)&&d>0?Number((n/d*scale).toFixed(4)):null;
 out.ctr=ratio(out.clicks,out.impressions);
 const weighted=(name,weight,max=Infinity)=>{
  if(!rows.length || rows.some(m=>!finite(m[weight]) || (m[weight]>0 && (!finite(m[name]) || m[name]>max))))return null;
  const denominator=rows.reduce((n,m)=>n+m[weight],0);
  return denominator>0?Number((rows.reduce((n,m)=>n+(m[weight]>0?m[name]*m[weight]:0),0)/denominator).toFixed(4)):null;
 };
 out.position=weighted('position','impressions');
 out.bounceRate=weighted('bounceRate','sessions',1);out.engagementRate=weighted('engagementRate','sessions',1);
 out.averageEngagementTime=weighted('averageEngagementTime','sessions');
 out.ecommerceConfigured=rows.length>0 && rows.every(m=>m.ecommerceConfigured===true);
 out.addToCartRate=ratio(out.addToCartCount,out.sessions,100);out.checkoutRate=ratio(out.checkoutCount,out.sessions,100);
 out.purchaseConversionRate=ratio(out.purchaseCount,out.sessions,100);out.checkoutToPurchaseRate=ratio(out.purchaseCount,out.checkoutCount,100);
 // Item counts divided by purchases/sessions are not event conversion percentages.
 if(!rows.length || !rows.every(m=>m.funnelUnits==='events')) for(const name of ['addToCartRate','checkoutRate','purchaseConversionRate','checkoutToPurchaseRate'])out[name]=null;
 for(const name of ['crawledPages','crawlErrors'])out[name]=sum(name);
 return out;
}

/**
 * Computes difference and percentage change between two metric states.
 * @param {object} curr
 * @param {object} prior
 * @returns {object}
 */
function computeChanges(curr, prior) {
  const diff = {};
  const metrics = [
    "clicks",
    "impressions",
    "ctr",
    "position",
    "sessions",
    "users",
    "totalUsers",
    "newUsers",
    "returningUsers",
    "pageViews",
    "conversions",
    "bounceRate",
    "engagementRate",
    "averageEngagementTime",
    "viewItemCount",
    "addToCartCount",
    "checkoutCount",
    "purchaseCount",
    "revenue",
    "addToCartRate",
    "checkoutRate",
    "purchaseConversionRate",
    "checkoutToPurchaseRate",
    "crawledPages",
    "crawlErrors",
  ];

  for (const m of metrics) {
    const cVal = curr[m];
    const pVal = prior[m];

    if (!(m==='revenue' ? typeof cVal==='number'&&Number.isFinite(cVal)&&typeof pVal==='number'&&Number.isFinite(pVal) : finite(cVal)&&finite(pVal))) {
      diff[m] = {
        current: cVal ?? null,
        prior: pVal ?? null,
        absolute: null,
        percent: null,
      };
      continue;
    }

    const absolute = Number((cVal - pVal).toFixed(2));
    let percent = 0;
    if (pVal > 0) {
      percent = Number((((cVal - pVal) / pVal) * 100).toFixed(2));
    } else if (cVal !== 0 || pVal !== 0) {
      percent = null; // Growth from a zero baseline has no finite percentage.
    }
    diff[m] = {
      current: cVal,
      prior: pVal,
      absolute,
      percent,
    };
  }

  return diff;
}

/**
 * Aggregates dimensions across a date window (pages, queries, channels, events, aiReferrals, landingPages).
 * @param {Array<object>} slice
 * @returns {object}
 */
function aggregateDimensions(slice) {
  const pagesMap = new Map();
  const queriesMap = new Map();
  const channelsMap = new Map();
  const aiReferralsMap = new Map();
  const landingPagesMap = new Map();
  const eventsMap = new Map();
  const devicesMap = new Map();
  let latestCrawlIssues = [];

  for (const s of slice) {
    const dims = s.dimensions || {};

    // Crawl Issues (keep latest snapshot's crawlIssues list in the slice)
    if (Array.isArray(dims.crawlIssues) && dims.crawlIssues.length > 0) {
      latestCrawlIssues = dims.crawlIssues;
    }

    // Pages
    if (Array.isArray(dims.pages)) {
      for (const p of dims.pages) {
        const key = p.page || p.pagePath || "";
        if (!key) continue;
        const existing = pagesMap.get(key) || { page: key, clicks: 0, impressions: 0, pageViews: 0, sessions: 0, sumPos: 0, count: 0 };
        existing.clicks += p.clicks || 0;
        existing.impressions += p.impressions || 0;
        existing.pageViews += p.pageViews || 0;
        existing.sessions += p.sessions || 0;
        if (p.position) {
          existing.sumPos += p.position * (p.impressions || 1);
          existing.count += (p.impressions || 1);
        }
        pagesMap.set(key, existing);
      }
    }

    // Landing Pages
    if (Array.isArray(dims.landingPages)) {
      for (const lp of dims.landingPages) {
        const key = lp.page || lp.pagePath || "/";
        const existing = landingPagesMap.get(key) || { page: key, sessions: 0, users: 0, pageViews: 0, bounceRateSum: 0, count: 0 };
        existing.sessions += lp.sessions || 0;
        existing.users += lp.users || 0;
        existing.pageViews += lp.pageViews || 0;
        if (lp.bounceRate !== undefined) {
          if (finite(lp.bounceRate) && finite(lp.sessions)) { existing.bounceRateSum += lp.bounceRate * lp.sessions; existing.count += lp.sessions; }
        }
        landingPagesMap.set(key, existing);
      }
    }

    // Queries
    if (Array.isArray(dims.queries)) {
      for (const q of dims.queries) {
        const key = q.query || "";
        if (!key) continue;
        const existing = queriesMap.get(key) || { query: key, clicks: 0, impressions: 0, sumPos: 0, count: 0 };
        existing.clicks += q.clicks || 0;
        existing.impressions += q.impressions || 0;
        if (q.position) {
          existing.sumPos += q.position * (q.impressions || 1);
          existing.count += (q.impressions || 1);
        }
        queriesMap.set(key, existing);
      }
    }

    // Traffic Sources / Channels
    if (Array.isArray(dims.trafficSources)) {
      for (const ts of dims.trafficSources) {
        const channel = ts.channel || `${ts.source} / ${ts.medium}`;
        const existing = channelsMap.get(channel) || { channel, source: ts.source, medium: ts.medium, sessions: 0, users: 0 };
        existing.sessions += ts.sessions || 0;
        existing.users += ts.users || 0;
        channelsMap.set(channel, existing);
      }
    }

    // Verified AI Referrals
    if (Array.isArray(dims.aiReferrals)) {
      for (const ai of dims.aiReferrals) {
        const key = `${ai.platform || ai.source}`;
        const existing = aiReferralsMap.get(key) || { platform: ai.platform || "AI Referral", source: ai.source, medium: ai.medium, sessions: 0, users: 0 };
        existing.sessions += ai.sessions || 0;
        existing.users += ai.users || 0;
        aiReferralsMap.set(key, existing);
      }
    }

    // Events
    if (Array.isArray(dims.events)) {
      for (const ev of dims.events) {
        const key = ev.eventName || "";
        if (!key) continue;
        const existing = eventsMap.get(key) || { eventName: key, eventCount: 0 };
        existing.eventCount += ev.eventCount || 0;
        eventsMap.set(key, existing);
      }
    }

    // Devices
    if (Array.isArray(dims.devices)) {
      for (const dev of dims.devices) {
        const key = dev.device || "desktop";
        const existing = devicesMap.get(key) || { device: key, sessions: 0 };
        existing.sessions += dev.sessions || 0;
        devicesMap.set(key, existing);
      }
    }
  }

  // Top-N omissions are unknown, not zero. Compare a dimension entity only when it is observed
  // on every required day; an API-success flag alone does not establish entity-level completeness.
  const observedEveryDay=(map,source,keyOf,required)=>{
    for(const [key,value] of map.entries()) {
      const observed=slice.map(s=>(s.dimensions?.[source] || []).find(row=>keyOf(row)===key));
      if(!observed.every(row=>row && required.every(name=>finite(row[name])))){map.delete(key);continue;}
      if('sumPos' in value)value.positionUnknown=observed.some(row=>row.impressions>0 && (!finite(row.position)||row.position<=0));
      if('bounceRateSum' in value)value.bounceUnknown=observed.some(row=>row.sessions>0 && (!finite(row.bounceRate)||row.bounceRate>1));
      for(const metric of ['users','pageViews'])if(metric in value && !observed.every(row=>finite(row[metric])))value[metric]=null;
      if('users' in value)value.userCountUnit=slice.length===1?'users':'user_days';
    }
  };
  const search=slice[0]?.provider!=='google_analytics';
  observedEveryDay(pagesMap,'pages',p=>p.page || p.pagePath || '',search?['clicks','impressions']:['sessions']);
  observedEveryDay(queriesMap,'queries',q=>q.query || '',['clicks','impressions']);
  observedEveryDay(channelsMap,'trafficSources',t=>t.channel || (t.source+' / '+t.medium),['sessions']);
  observedEveryDay(aiReferralsMap,'aiReferrals',a=>String(a.platform || a.source),['sessions']);
  observedEveryDay(landingPagesMap,'landingPages',p=>p.page || p.pagePath || '/', ['sessions']);
  // Format summaries
  const pages = Array.from(pagesMap.values()).map((p) => ({
    page: p.page,
    clicks: p.clicks,
    impressions: p.impressions,
    ctr: p.impressions > 0 ? Number((p.clicks / p.impressions).toFixed(4)) : 0,
    position: !p.positionUnknown && p.count > 0 ? Number((p.sumPos / p.count).toFixed(1)) : null,
    pageViews: p.pageViews,
    sessions: p.sessions,
  })).sort((a, b) => b.clicks - a.clicks || b.pageViews - a.pageViews);

  const landingPages = Array.from(landingPagesMap.values()).map((lp) => ({
    page: lp.page,
    sessions: lp.sessions,
    users: lp.users,
    pageViews: lp.pageViews,
    bounceRate: !lp.bounceUnknown && lp.count > 0 ? Number((lp.bounceRateSum / lp.count).toFixed(4)) : null,
    userCountUnit: slice.length===1?"users":"user_days",
  })).sort((a, b) => b.sessions - a.sessions);

  const queries = Array.from(queriesMap.values()).map((q) => ({
    query: q.query,
    clicks: q.clicks,
    impressions: q.impressions,
    ctr: q.impressions > 0 ? Number((q.clicks / q.impressions).toFixed(4)) : 0,
    position: !q.positionUnknown && q.count > 0 ? Number((q.sumPos / q.count).toFixed(1)) : null,
  })).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  const channels = Array.from(channelsMap.values()).sort((a, b) => b.sessions - a.sessions);
  const aiReferrals = Array.from(aiReferralsMap.values()).sort((a, b) => b.sessions - a.sessions);
  const events = Array.from(eventsMap.values()).sort((a, b) => b.eventCount - a.eventCount);
  const devices = Array.from(devicesMap.values()).sort((a, b) => b.sessions - a.sessions);

  // Deduplicate latestCrawlIssues by URL
  const seenIssueUrls = new Set();
  const crawlIssues = [];
  for (const issue of latestCrawlIssues) {
    if (!issue || typeof issue !== "object") continue;
    const urlKey = String(issue.Url || issue.url || JSON.stringify(issue)).toLowerCase().trim();
    if (seenIssueUrls.has(urlKey)) continue;
    seenIssueUrls.add(urlKey);
    crawlIssues.push(issue);
  }

  return {
    pages,
    landingPages,
    queries,
    channels,
    aiReferrals,
    events,
    devices,
    crawlIssues,
  };
}

/**
 * Calculates the number of calendar days between two YYYY-MM-DD dates inclusive.
 *
 * @param {string} startStr
 * @param {string} endStr
 * @returns {number}
 */
function getCalendarDaysInclusive(startStr,endStr) {
 if(!validDate(startStr)||!validDate(endStr)||endStr<startStr)return 0;
 return Math.round((Date.parse(endStr)-Date.parse(startStr))/86400000)+1;
}

/**
 * Builds comparison window data comparing a current period to its prior equivalent.
 *
 * @param {Array<object>} allSnapshots
 * @param {string} currStart
 * @param {string} currEnd
 * @param {string} priorStart
 * @param {string} priorEnd
 * @param {string} windowName
 * @returns {object}
 */
function buildWindow(allSnapshots, currStart, currEnd, priorStart, priorEnd, windowName, { fresh } = {}) {
  fresh = fresh ?? (currEnd === providerDate(allSnapshots[0]?.provider));
  const currentSlice = allSnapshots.filter((s) => s.date >= currStart && s.date <= currEnd).sort((a,b)=>a.date.localeCompare(b.date));
  const priorSlice = allSnapshots.filter((s) => s.date >= priorStart && s.date <= priorEnd).sort((a,b)=>a.date.localeCompare(b.date));

  const currentMetrics = aggregateMetrics(currentSlice);
  const priorMetrics = aggregateMetrics(priorSlice);
  const properties=new Set(allSnapshots.map(s=>s.propertyRef));
  const providers=new Set(allSnapshots.map(s=>s.provider));
  const owners=new Set(allSnapshots.map(s=>s.userEmail || s.userId));
  const isolated=properties.size===1 && Boolean([...properties][0]) && providers.size===1 && Boolean([...providers][0]) && owners.size===1 && Boolean([...owners][0]);
  const rangeComplete=(rows,start,end)=>{
   const days=getCalendarDaysInclusive(start,end);return days>0 && rows.length===days && new Set(rows.map(s=>s.date)).size===days && rows.every(s=>validDate(s.date)&&s.dataQuality?.daily!==false);
  };
  const currentComplete=rangeComplete(currentSlice,currStart,currEnd),priorComplete=rangeComplete(priorSlice,priorStart,priorEnd);
  const aligned=currentComplete && priorComplete && priorEnd===shiftDate(currStart,-1) &&
    getCalendarDaysInclusive(currStart,currEnd)===getCalendarDaysInclusive(priorStart,priorEnd) &&
    getCalendarDaysInclusive(currStart,currEnd)===({today_vs_yesterday:1,last7_vs_prior7:7,last28_vs_prior28:28}[windowName]);
  const eligible=isolated && fresh && aligned && currentComplete && priorComplete;
  if(!eligible) for(const metric of [currentMetrics,priorMetrics])for(const key of Object.keys(metric))if(key!=='count')metric[key]=null;
  const changes = computeChanges(currentMetrics, priorMetrics);
  for(const name of Object.keys(changes))if(!eligible || (name==='revenue' && currentMetrics.currencyCode!==priorMetrics.currencyCode)) changes[name]={...changes[name],absolute:null,percent:null};

  const currentDims = aggregateDimensions(currentSlice);
  const priorDims = aggregateDimensions(priorSlice);

  const dimensionKeys={pages:'pages',queries:'queries',channels:'trafficSources',aiReferrals:'trafficSources',landingPages:'landingPages',events:'events',devices:'devices',crawlIssues:'crawlIssues'};
  for(const [key,source] of Object.entries(dimensionKeys)) {
   if(![...currentSlice,...priorSlice].every(s=>s.dataQuality?.dimensions?.[source]===true && Array.isArray(s.dimensions?.[source]))) {currentDims[key]=[];priorDims[key]=[];}
  }
  const expectedDimensions=allSnapshots[0]?.provider==='google_analytics'?['trafficSources','landingPages','events','devices']:allSnapshots[0]?.provider==='google_search_console'?['pages','queries']:['queries','crawlIssues'];
  const dimensionsComplete=[...currentSlice,...priorSlice].length>0 && [...currentSlice,...priorSlice].every(s=>!s.dataQuality?.warnings?.length && expectedDimensions.every(key=>s.dataQuality?.dimensions?.[key]===true));
  // Daily series in current window for trend checking (sustained change detection)
  const dailySeries = currentSlice.map((s) => ({
    date: s.date,
    metrics: s.metrics || {},
  }));

  const currentCalendarDays = getCalendarDaysInclusive(currStart, currEnd);
  const priorCalendarDays = getCalendarDaysInclusive(priorStart, priorEnd);

  return {
    window: windowName,
    eligible,
    coverage: { fresh, isolated, aligned, currentComplete, priorComplete, dimensionsComplete, unitsCompatible: currentMetrics.revenue===null || priorMetrics.revenue===null || currentMetrics.currencyCode===priorMetrics.currencyCode },
    currentRange: {
      start: currStart,
      end: currEnd,
      days: currentCalendarDays,
      daysInRange: currentCalendarDays,
      snapshotsFoundInRange: currentSlice.length,
      snapshotsCount: currentSlice.length,
      missingDates: Array.from({length:currentCalendarDays},(_,i)=>shiftDate(currStart,i)).filter(date=>!currentSlice.some(s=>s.date===date)),
    },
    priorRange: {
      start: priorStart,
      end: priorEnd,
      days: priorCalendarDays,
      daysInRange: priorCalendarDays,
      snapshotsFoundInRange: priorSlice.length,
      snapshotsCount: priorSlice.length,
      missingDates: Array.from({length:priorCalendarDays},(_,i)=>shiftDate(priorStart,i)).filter(date=>!priorSlice.some(s=>s.date===date)),
    },
    currentMetrics,
    priorMetrics,
    changes,
    dailySeries,
    currentDimensions: eligible ? currentDims : {},
    priorDimensions: eligible ? priorDims : {},
  };
}

/**
 * Loads comparison windows for a user and provider:
 * 1. Today vs Yesterday (1d vs prior 1d)
 * 2. Last 7 days vs Prior 7 days (7d vs prior 7d)
 * 3. Last 28 days vs Prior 28 days (28d vs prior 28d)
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} params.userEmail
 * @param {string} [params.provider]
 * @param {string} [params.targetDate] - YYYY-MM-DD anchor date (defaults to latest available)
 * @returns {Promise<object>}
 */
async function loadComparisonWindows({ userId, userEmail, provider, propertyRef, targetDate: explicitDate, now = new Date() }) {
  if(explicitDate && !validDate(explicitDate))throw Error("Invalid comparison anchor");
  const expectedDate=providerDate(provider,now);
  const targetDate=explicitDate ? (explicitDate<expectedDate?explicitDate:expectedDate) : expectedDate;
  if(!validDate(targetDate))throw Error('Invalid comparison anchor');
  const fresh=targetDate===expectedDate;

  // Define window date ranges based on targetDate (Day 0)
  // Window 1: 1d vs prior 1d
  const todayStart = targetDate;
  const todayEnd = targetDate;
  const yesterdayStart = shiftDate(targetDate, -1);
  const yesterdayEnd = shiftDate(targetDate, -1);

  // Window 2: 7d vs prior 7d
  const last7Start = shiftDate(targetDate, -6);
  const last7End = targetDate;
  const prior7Start = shiftDate(targetDate, -13);
  const prior7End = shiftDate(targetDate, -7);

  // Window 3: 28d vs prior 28d
  const last28Start = shiftDate(targetDate, -27);
  const last28End = targetDate;
  const prior28Start = shiftDate(targetDate, -55);
  const prior28End = shiftDate(targetDate, -28);

  // Load all snapshots from prior28Start up to targetDate
  const allSnapshots = await getMetricSnapshots({
    userId,
    userEmail,
    provider,
    propertyRef,
    startDate: prior28Start,
    endDate: targetDate,
  });

  const todayVsYesterday = buildWindow(
    allSnapshots,
    todayStart,
    todayEnd,
    yesterdayStart,
    yesterdayEnd,
    "today_vs_yesterday", {fresh}
  );

  const last7VsPrior7 = buildWindow(
    allSnapshots,
    last7Start,
    last7End,
    prior7Start,
    prior7End,
    "last7_vs_prior7", {fresh}
  );

  const last28VsPrior28 = buildWindow(
    allSnapshots,
    last28Start,
    last28End,
    prior28Start,
    prior28End,
    "last28_vs_prior28", {fresh}
  );

  return {
    targetDate,
    provider,
    propertyRef: String(propertyRef),
    totalSnapshotsLoaded: allSnapshots.length,
    today_vs_yesterday: todayVsYesterday,
    last7_vs_prior7: last7VsPrior7,
    last28_vs_prior28: last28VsPrior28,
  };
}

module.exports = {
  saveMetricSnapshot,
  saveMetricSnapshots,
  getMetricSnapshots,
  getLatestSnapshotDate,
  loadComparisonWindows,
  shiftDate,
  providerDate,
  validDate,
  computeChanges,
  aggregateMetrics,
  buildWindow,
  getCalendarDaysInclusive,
};
