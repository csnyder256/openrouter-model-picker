import test from "node:test";
import assert from "node:assert/strict";
import {comparison,validateComparison,shareFragment,parseFragment,explainRanking,comparisonCSV,readShortlists,writeShortlists,demoComparison,SHORTLIST_KEY} from "../lib/comparisons.js";

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
