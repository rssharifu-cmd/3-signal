const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {createRequire}=require('node:module');
test('configured AI credentials never enable network or SDK access for customer findings',async()=>{
 const file=path.resolve(__dirname,'../api/_lib/intelligence.js');
 let requests=0; const mod={exports:{}}; const actual=createRequire(file);
 const sandbox={module:mod,exports:mod.exports,process:{env:{GEMINI_API_KEY:'configured-but-unused',TAVILY_API_KEY:'configured-but-unused'}},console,Date,fetch:()=>{requests++;throw Error('No customer data may leave the interpreter');},require:id=>{if(id==='@google/genai')throw Error('AI SDK must not load');return actual(id);}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),sandbox,{filename:file});
 const finding={id:'drop',type:'organic_traffic_drop',severity:'warning',confidence:0.9,evidence:{query:'private-query',percentChange:-50},scope:{page:'https://example.test/private'}};
 const report=await mod.exports.interpretFindings({findings:[finding],userContext:{websiteUrl:'https://example.test'},externalResearch:[{private:'ignored'}]});
 assert.equal(report.aiCallSkipped,true);assert.equal(report.interpretationMode,'deterministic');assert.equal(report.priorityRankedFindings.length,1);assert.ok(report.recommendedActions.length);assert.equal(report.externalResearch.length,0);assert.equal(requests,0);
 const empty=await mod.exports.interpretFindings({findings:[]});assert.equal(empty.aiCallSkipped,true);assert.equal(requests,0);
});
