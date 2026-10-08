import test from "node:test";
import assert from "node:assert/strict";
import {comparison,validateComparison,shareFragment,parseFragment,explainRanking,comparisonCSV,readShortlists,writeShortlists,demoComparison,publicModel,SHORTLIST_KEY} from "../lib/comparisons.js";

test("sharing whitelists public data and opens a dated snapshot without private task or keys",()=>{
 const base=demoComparison(), doc=comparison(base.models.map(m=>({...m,apiKey:"secret",description:"private"})),{...base.preferences,taskDescription:"private task",apiKey:"secret"},base.createdAt);
 const link=shareFragment(doc), restored=parseFragment(link);
 assert.deepEqual(restored,doc);assert.doesNotMatch(decodeURIComponent(link),/secret|private|taskDescription|apiKey/);
 assert.equal(parseFragment("#other"),null);
});
test("malformed, duplicate, future schema and large imports are rejected",()=>{
 const base=demoComparison();
 for(const bad of [{...base,version:2},{...base,createdAt:"bad"},{...base,models:[base.models[0],base.models[0]]},{...base,preferences:{presetId:"unknown"}},{...base,models:[{id:"<script>"}]}]) assert.throws(()=>validateComparison(bad));
 assert.throws(()=>parseFragment("#compare=%not-json"));assert.throws(()=>parseFragment("#compare="+"x".repeat(24000)));
});
test("missing data stays missing and exact ranking formula is explained",()=>{
 const base=demoComparison();assert.equal(explainRanking(base.models[1],base).position,1);
 assert.equal(explainRanking(base.models[2],base).score,null);
 assert.match(explainRanking(base.models[2],base).warnings.join(" "),/not a zero/);
 const clean=comparison([{...base.models[0],benchmarks:{codingIndex:Infinity,gpqaAccuracy:2},pricing:{promptPerM:-1,completionPerM:NaN}}]);
 assert.equal(clean.models[0].pricing.promptPerM,null);assert.equal(clean.models[0].benchmarks.codingIndex,null);assert.equal(clean.models[0].benchmarks.gpqaAccuracy,null);
});
test("shortlist round trip and storage failure never replace earlier saved values",()=>{
 let data={};const storage={getItem:k=>data[k]??null,setItem:(k,v)=>{data[k]=v;}};
 writeShortlists(storage,[{id:"one",name:"Research",comparison:demoComparison()}]);
 assert.equal(readShortlists(storage)[0].name,"Research");
 const before=data[SHORTLIST_KEY];assert.throws(()=>writeShortlists(storage,[{id:"bad",comparison:{}}]));assert.equal(data[SHORTLIST_KEY],before);
 assert.throws(()=>writeShortlists({setItem(){throw Error("quota");}},[]),/quota/);
});
test("CSV escapes commas, quotes and spreadsheet formulas",()=>{
 const doc=demoComparison();doc.models[0].name='=HYPERLINK("bad"),test';
 const csv=comparisonCSV(doc);assert.match(csv,/"'=HYPERLINK\(""bad""\),test"/);assert.match(csv,/snapshot_utc/);
});

// OpenRouter marks its "latest" aliases with a leading `~`. They are real,
// priced, selectable models (18 of 467 live ids on 2026-10-08), so the id
// allowlist must accept them: before this, ticking any one of their compare
// boxes threw "Invalid model identifier." and left the panel unresponsive.
const LATEST_ALIAS_IDS=["~anthropic/claude-fable-latest","~anthropic/claude-haiku-latest","~anthropic/claude-opus-latest","~anthropic/claude-sonnet-latest","~deepseek/deepseek-flash-latest","~deepseek/deepseek-pro-latest","~deepseek/deepseek-v4-flash-latest","~google/gemini-flash-latest","~google/gemini-pro-latest","~moonshotai/kimi-latest","~openai/gpt-astra-latest","~openai/gpt-luna-latest","~openai/gpt-mini-latest","~openai/gpt-sol-latest","~openai/gpt-terra-latest","~x-ai/grok-latest","~z-ai/glm-flash-latest","~z-ai/glm-latest"];

test("a `~`-prefixed live 'latest' alias is a valid model id, not 'Invalid model identifier.'",()=>{
 const model={id:"~openai/gpt-luna-latest",name:"OpenAI: GPT Luna Latest",contextLength:200000,pricing:{promptPerM:0.1,completionPerM:0.5},benchmarks:{intelligenceIndex:70}};
 assert.equal(publicModel(model).id,"~openai/gpt-luna-latest");
 const doc=comparison([model],{presetId:"coding",qualityPreference:"quality"});
 assert.equal(doc.models[0].id,"~openai/gpt-luna-latest");
 // it must also survive the public share round-trip, so a snapshot containing it can be opened
 assert.equal(parseFragment(shareFragment(doc)).models[0].id,"~openai/gpt-luna-latest");
});
test("every live 'latest' alias id is accepted by the comparison gate",()=>{
 for(const id of LATEST_ALIAS_IDS) assert.equal(comparison([{id,pricing:{promptPerM:1,completionPerM:2}}],{}).models[0].id,id);
});
test("the id allowlist still rejects ids that are not real model identifiers",()=>{
 for(const id of ["~","~~x","x~y","~ openai/gpt","<script>","openai/gpt luna",'openai/gpt"x',".leading-dot","","a".repeat(201),null,42])
  assert.throws(()=>publicModel({id}),/Invalid model identifier/,String(id));
 assert.equal(publicModel({id:"anthropic/claude-3.5-sonnet"}).id,"anthropic/claude-3.5-sonnet");
});
