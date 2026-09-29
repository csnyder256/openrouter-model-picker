import { comparison, validateComparison, shareFragment, parseFragment, explainRanking, comparisonCSV, readShortlists, writeShortlists, demoComparison, MAX_MODELS } from "./comparisons.js";
import { findPreset } from "./match.js";

const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
};
function download(filename, body, type) {
  const url = URL.createObjectURL(new Blob([body], {type}));
  const a = node("a"); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function initComparisons(readPreferences) {
  const root = document.getElementById("comparison-panel");
  if (!root || typeof root.querySelector !== "function") return { addControl() {}, refresh() {} };
  const contents = root.querySelector("#comparison-content");
  const status = root.querySelector("#comparison-status");
  const name = root.querySelector("#shortlist-name");
  const saved = root.querySelector("#saved-shortlists");
  const link = root.querySelector("#comparison-link");
  let doc = null, selected = new Map(), savedRows = [], activeSavedId = null;
  const message = (value, error=false) => { status.textContent=value;status.classList.toggle("err",error); };
  const guarded = fn => () => { try { fn(); } catch(err) { message(err.message,true); } };
  let storage;
  try { storage=window.localStorage;savedRows=readShortlists(storage); }
  catch(err) { storage=null; message("Browser storage unavailable or invalid: " + err.message + ". Sharing and exports still work.",true); }

  function refreshSaved() {
    saved.replaceChildren(node("option","Choose a saved shortlist"));
    saved.firstChild.value="";
    for (const row of savedRows) { const option=node("option",row.name);option.value=row.id;saved.append(option); }
    saved.value=activeSavedId||"";
  }
  function paint() {
    contents.replaceChildren();link.hidden=true;
    const buttons = root.querySelectorAll("[data-requires-models]");
    buttons.forEach(button=>button.disabled=!doc);
    if (!doc) { contents.append(node("p","Select models from search results, open a comparison link, or try the offline example.")); return; }
    contents.append(node("p","Unverified public snapshot · " + new Date(doc.createdAt).toLocaleString() + " · " + findPreset(doc.preferences.presetId).label,"status"));
    const wrap=node("div",null,"table-wrap"), table=node("table"), head=node("tr");
    ["Model","Input $/M","Output $/M","Context","Ranking explanation"].forEach(label=>head.append(node("th",label)));
    const thead=node("thead");thead.append(head);table.append(thead);
    const tbody=node("tbody");
    for(const model of doc.models) {
      const tr=node("tr"), identity=node("td"), title=node("strong",model.name);
      identity.append(title,node("span",model.id,"id"));
      const remove=node("button","Remove","secondary");remove.type="button";
      remove.addEventListener("click",()=>{ selected.delete(model.id);activeSavedId=null;doc=selected.size?comparison([...selected.values()],doc.preferences,doc.createdAt):null;paint();syncBoxes();refreshSaved(); });
      identity.append(remove);tr.append(identity);
      [model.pricing.promptPerM,model.pricing.completionPerM,model.contextLength].forEach(v=>tr.append(node("td",v==null?"Unknown":String(v),"num")));
      const reason=explainRanking(model,doc), detail=node("td"), summary=node("p",reason.explanation), list=node("ul");
      reason.warnings.forEach(w=>list.append(node("li",w)));
      const disclosure=node("details");disclosure.append(node("summary","Assumptions and limitations"),list);
      detail.append(summary,disclosure);tr.append(detail);tbody.append(tr);
    }
    table.append(tbody);wrap.append(table);contents.append(wrap);
    root.querySelector("#comparison-mode").value=doc.preferences.qualityPreference;
    root.querySelector("#comparison-preset").value=doc.preferences.presetId;
  }
  function syncBoxes() {
    document.querySelectorAll(".compare-model").forEach(box=>box.checked=selected.has(box.dataset.modelId));
  }
  function load(value) {
    doc=validateComparison(value);selected=new Map(doc.models.map(m=>[m.id,m]));paint();syncBoxes();
  }
  function rebuild() {
    activeSavedId=null;
    if(doc) doc=comparison([...selected.values()], {
      ...doc.preferences, presetId:root.querySelector("#comparison-preset").value,
      qualityPreference:root.querySelector("#comparison-mode").value
    },doc.createdAt);
    paint();refreshSaved();
  }
  for(const preset of document.querySelector("#task-preset").options) root.querySelector("#comparison-preset").append(preset.cloneNode(true));
  root.querySelector("#comparison-preset").addEventListener("change",rebuild);
  root.querySelector("#comparison-mode").addEventListener("change",rebuild);
  root.querySelector("#comparison-demo").addEventListener("click",()=>{activeSavedId=null;load(demoComparison());refreshSaved();message("Offline example: fictional models and illustrative measurements. No API request was made.");});
  root.querySelector("#comparison-clear").addEventListener("click",()=>{doc=null;selected.clear();activeSavedId=null;history.replaceState(null,"",location.pathname+location.search);paint();syncBoxes();refreshSaved();message("Comparison cleared.");});
  root.querySelector("#comparison-share").addEventListener("click",guarded(()=>{
    const url=new URL(location.href);url.hash=shareFragment(doc);
    link.value=url.href;link.hidden=false;link.focus();link.select();
    if(navigator.clipboard?.writeText) navigator.clipboard.writeText(url.href).then(()=>message("Comparison link copied. Only public metrics and preferences are included."),()=>message("Copy the selected link. Clipboard access was unavailable."));
    else message("Copy the selected link. Only public metrics and preferences are included.");
  }));
  root.querySelector("#comparison-json").addEventListener("click",guarded(()=>download("model-comparison.json",JSON.stringify(doc,null,2)+"\n","application/json")));
  root.querySelector("#comparison-csv").addEventListener("click",guarded(()=>download("model-comparison.csv",comparisonCSV(doc),"text/csv")));
  root.querySelector("#comparison-print").addEventListener("click",()=>window.print());
  root.querySelector("#shortlist-save").addEventListener("click",guarded(()=>{
    if(!storage) throw new Error("Browser storage is unavailable; export JSON to retain this comparison.");
    if(!name.value.trim()) throw new Error("Name this shortlist first.");
    const id=activeSavedId || crypto.randomUUID(), row={id,name:name.value.trim().slice(0,80),comparison:doc};
    const next=savedRows.filter(r=>r.id!==id).concat(row);
    writeShortlists(storage,next);savedRows=next;activeSavedId=id;refreshSaved();message("Shortlist saved in this browser.");
  }));
  saved.addEventListener("change",guarded(()=>{
    const row=savedRows.find(r=>r.id===saved.value);if(!row)return;
    activeSavedId=row.id;name.value=row.name;load(row.comparison);message("Saved snapshot loaded. Refresh the live catalog to check current data.");
  }));
  root.querySelector("#shortlist-rename").addEventListener("click",guarded(()=>{
    if(!activeSavedId || !name.value.trim()) throw new Error("Choose a saved shortlist and enter its new name.");
    const next=savedRows.map(r=>r.id===activeSavedId?{...r,name:name.value.trim().slice(0,80)}:r);
    writeShortlists(storage,next);savedRows=next;refreshSaved();message("Shortlist renamed.");
  }));
  root.querySelector("#shortlist-delete").addEventListener("click",guarded(()=>{
    if(!activeSavedId) throw new Error("Choose a saved shortlist first.");
    const next=savedRows.filter(r=>r.id!==activeSavedId);writeShortlists(storage,next);
    savedRows=next;activeSavedId=null;refreshSaved();message("Saved shortlist deleted; the open comparison is retained.");
  }));
  root.querySelector("#comparison-import").addEventListener("change",async(event)=>{
    const file=event.target.files[0];if(!file)return;
    try { if(file.size>24000)throw new Error("Comparison file is too large.");load(JSON.parse(await file.text()));activeSavedId=null;refreshSaved();message("Imported public snapshot. No API request was made."); }
    catch(err){message(err.message,true);}finally{event.target.value="";}
  });
  const openHash=()=>{try{const value=parseFragment(location.hash);if(value){activeSavedId=null;load(value);refreshSaved();message("Shared public snapshot opened. No API key or API request is needed.");}}catch(err){message(err.message,true);}};
  window.addEventListener("hashchange",openHash);refreshSaved();paint();openHash();

  return {
    addControl(row, model) {
      const td=node("td"), box=node("input");box.type="checkbox";box.className="compare-model";box.dataset.modelId=model.id;box.checked=selected.has(model.id);box.setAttribute("aria-label","Compare "+model.name);
      box.addEventListener("change",()=>{
        if(box.checked && !selected.has(model.id) && selected.size>=MAX_MODELS) {box.checked=false;message("Compare up to six models at a time.",true);return;}
        activeSavedId=null;
        if(box.checked) selected.set(model.id,model); else selected.delete(model.id);
        const prefs=readPreferences();doc=selected.size?comparison([...selected.values()],prefs,doc?.createdAt || new Date().toISOString()):null;
        paint();refreshSaved();message(selected.size+" model(s) selected.");
      });
      td.append(box);row.prepend(td);
    },
    refresh(models) {
      if(!doc)return;
      const byId=new Map(models.map(m=>[m.id,m])), missing=[];
      const next=doc.models.map(m=>{if(!byId.has(m.id))missing.push(m.id);return byId.get(m.id)||m;});
      // Never stamp old measurements with a fresh timestamp if a model disappeared.
      if(missing.length){message("Snapshot retained: absent from the current catalog: "+missing.join(", ")+". Remove these models before refreshing.",true);return;}
      load(comparison(next,doc.preferences));message("Selected model metrics refreshed from the current catalog.");
    }
  };
}
