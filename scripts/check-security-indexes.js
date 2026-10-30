// Read-only metadata inspection. Never reads customer documents or creates indexes.
const REQUIREMENTS={users:[{key:{email:1},unique:true}],oauth_attempts:[{key:{expiresAt:1},expireAfterSeconds:0}],auth_rate_limits:[{key:{expiresAt:1},expireAfterSeconds:0}],email_send_guards:[]};
function sameKey(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function analyze(name,indexes){
 const issues=[];
 if(!indexes.some(i=>sameKey(i.key,{_id:1}))) issues.push('missing standard _id index');
 for(const needed of REQUIREMENTS[name]||[]) {
  if(!indexes.some(i=>sameKey(i.key,needed.key)&&(!needed.unique||i.unique===true)&&(!needed.unique||!i.sparse&&!i.partialFilterExpression)&& (needed.expireAfterSeconds===undefined||i.expireAfterSeconds===needed.expireAfterSeconds)&&(!i.collation||i.collation.locale==='simple'))) issues.push('missing/incompatible '+JSON.stringify(needed));
 }
 for(const i of indexes) {
  if(i.unique&&!sameKey(i.key,{_id:1})&&!(name==='users'&&sameKey(i.key,{email:1}))) issues.push('unexpected unique index '+i.name);
  if(i.expireAfterSeconds!==undefined&&!((name==='oauth_attempts'||name==='auth_rate_limits')&&sameKey(i.key,{expiresAt:1}))) issues.push('unexpected TTL index '+i.name);
  if(i.partialFilterExpression&&i.expireAfterSeconds!==undefined) issues.push('partial TTL does not cover all records '+i.name);
 }
 return issues;
}
async function inspect(db){const results={};for(const name of Object.keys(REQUIREMENTS)){
 const collections=await db.listCollections({name},{nameOnly:false}).toArray();
 if(!collections.length){results[name]=['collection missing; explicit index provisioning approval required'];continue;}
 const metadata=collections[0];const issues=analyze(name,await db.collection(name).listIndexes().toArray());
 if(metadata.options?.capped||metadata.options?.timeseries||metadata.options?.validator||metadata.options?.collation) issues.push('collection options require manual compatibility review');
 results[name]=issues;
} return results;}
async function main(){
 if(process.env.APP_ENV!=='staging'||process.env.SECURITY_INDEX_CHECK_ACK!=='isolated-staging-only'||!process.env.MONGODB_URI_STAGING||!/^sharflow_staging(?:_[a-z0-9]+)?$/.test(process.env.STAGING_DATABASE_NAME||'')) throw Error('Explicit isolated staging configuration required; no production fallback.');
 const {MongoClient}=require('mongodb');const client=new MongoClient(process.env.MONGODB_URI_STAGING,{serverSelectionTimeoutMS:5000});
 try{await client.connect();const results=await inspect(client.db(process.env.STAGING_DATABASE_NAME));console.log(JSON.stringify(results,null,2));if(Object.values(results).some(x=>x.length))process.exitCode=1;}finally{await client.close();}
}
if(require.main===module)main().catch(()=>{console.error('Read-only index check failed. Verify isolated staging configuration and metadata permissions.');process.exitCode=1;});
module.exports={analyze,inspect};
