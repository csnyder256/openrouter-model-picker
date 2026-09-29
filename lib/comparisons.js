import { findPreset, sortCandidates } from "./match.js";

export const SHORTLIST_KEY = "orpicker.shortlists.v1";
export const MAX_MODELS = 6;
export const BENCHMARKS = ["intelligenceIndex", "codingIndex", "agenticIndex", "gpqaAccuracy", "tauBenchAccuracy", "searchAvg"];
const numeric = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const text = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
const cell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';

export function publicModel(model) {
  if (!model || typeof model.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(model.id))
    throw new Error("Invalid model identifier.");
  const benchmarks = {};
  for (const key of BENCHMARKS) {
    const value = numeric(model.benchmarks?.[key]);
    benchmarks[key] = ["gpqaAccuracy", "tauBenchAccuracy", "searchAvg"].includes(key) && value > 1 ? null : value;
  }
  return {
    id: model.id, name: text(model.name, 160) || model.id,
    contextLength: numeric(model.contextLength),
    pricing: { promptPerM: numeric(model.pricing?.promptPerM), completionPerM: numeric(model.pricing?.completionPerM) },
    benchmarks, isFree: model.isFree === true && model.pricing?.promptPerM === 0 && model.pricing?.completionPerM === 0,
    outOfBandPricing: model.outOfBandPricing === true,
  };
}

export function comparison(models, preferences = {}, createdAt = new Date().toISOString()) {
  if (!Array.isArray(models) || !models.length || models.length > MAX_MODELS)
    throw new Error("Select one to six models.");
  const clean = models.map(publicModel);
  if (new Set(clean.map(m => m.id)).size !== clean.length) throw new Error("Duplicate model identifiers.");
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw new Error("Invalid snapshot date.");
  const presetId = preferences.presetId || preferences.preset?.id || "coding";
  if (!findPreset(presetId)) throw new Error("Unknown task preset.");
  const qualityPreference = preferences.qualityPreference || "quality";
  if (!["quality", "balanced", "cheapest"].includes(qualityPreference)) throw new Error("Unknown ranking mode.");
  return {
    schema: "orpicker.comparison", version: 1, createdAt: new Date(createdAt).toISOString(),
    preferences: { presetId, qualityPreference, maxPromptPerM: numeric(preferences.maxPromptPerM), maxCompletionPerM: numeric(preferences.maxCompletionPerM) },
    models: clean,
  };
}

export function validateComparison(doc) {
  if (!doc || doc.schema !== "orpicker.comparison" || doc.version !== 1) throw new Error("Unsupported comparison format.");
  return comparison(doc.models, doc.preferences, doc.createdAt);
}

export function shareFragment(doc) {
  return "#compare=" + encodeURIComponent(JSON.stringify(validateComparison(doc)));
}

export function parseFragment(hash) {
  if (!hash.startsWith("#compare=")) return null;
  if (hash.length > 24000) throw new Error("Comparison link is too large.");
  try { return validateComparison(JSON.parse(decodeURIComponent(hash.slice(9)))); }
  catch (err) { throw new Error("Cannot open comparison: " + err.message); }
}

export function explainRanking(model, doc) {
  const preset = findPreset(doc.preferences.presetId);
  const metric = preset.primaryMetric || "intelligenceIndex";
  const score = model.benchmarks[metric];
  const prices = [model.pricing.promptPerM, model.pricing.completionPerM].filter(v => v != null);
  const blended = prices.length ? prices.reduce((a,b) => a+b, 0) / prices.length : null;
  const mode = doc.preferences.qualityPreference;
  const ranked = sortCandidates(doc.models, preset, mode);
  const position = ranked.findIndex(m => m.id === model.id) + 1;
  let explanation = "Rank " + position + " among these selected models. ";
  if (mode === "cheapest") explanation += "Sorted by the mean of known input/output token prices, then " + metric + ", context and identifier.";
  else if (mode === "balanced") explanation += "Sorted by " + metric + " divided by mean token price. Zero-price ties use the benchmark, then context and identifier.";
  else explanation += "Sorted by " + metric + " descending, then context and identifier.";
  explanation += " Benchmark: " + (score == null ? "unmeasured" : score) + "; mean token price: " + (blended == null ? "unknown" : "$" + blended.toFixed(4) + "/M") + ".";
  const warnings = [];
  if (score == null) warnings.push("No measured primary benchmark; this is not a zero score.");
  if (prices.length < 2) warnings.push("Token pricing is incomplete; the mean uses only known dimensions.");
  if (model.outOfBandPricing) warnings.push("Additional per-use charges are excluded from the token-price ranking.");
  if (["image-generation", "text-to-speech", "vision-ocr", "vision-understanding", "translation", "summarization", "custom"].includes(preset.id))
    warnings.push("The general intelligence index is a proxy; it does not measure performance on this specific task.");
  warnings.push("Snapshot data is unverified until refreshed against the live catalog. No benchmark guarantees task success.");
  return { position, metric, score, blendedPrice: blended, explanation, warnings };
}

export function comparisonCSV(doc) {
  doc = validateComparison(doc);
  const rows = [["id","name","snapshot_utc","input_usd_per_million","output_usd_per_million","context_tokens",...BENCHMARKS]];
  for (const m of doc.models) rows.push([m.id,m.name,doc.createdAt,m.pricing.promptPerM,m.pricing.completionPerM,m.contextLength,...BENCHMARKS.map(k=>m.benchmarks[k])]);
  // Neutralize spreadsheet formula prefixes in imported public names.
  return rows.map(row => row.map(v => cell(typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? "'" + v : v)).join(",")).join("\r\n") + "\r\n";
}

export function readShortlists(storage) {
  const raw = storage.getItem(SHORTLIST_KEY);
  if (!raw) return [];
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error("Saved shortlists are damaged. Export or clear browser storage.");
  return rows.map(row => {
    if (!row || typeof row.id !== "string" || typeof row.name !== "string") throw new Error("Invalid saved shortlist.");
    return { id: text(row.id, 80), name: text(row.name, 80), comparison: validateComparison(row.comparison) };
  });
}

export function writeShortlists(storage, rows) {
  // Validate before replacing the previous storage value.
  const clean = rows.map(row => ({ id: text(row.id, 80), name: text(row.name, 80), comparison: validateComparison(row.comparison) }));
  storage.setItem(SHORTLIST_KEY, JSON.stringify(clean));
}

export function demoComparison() {
  return comparison([
    { id:"demo/precision",name:"Precision — illustrative",contextLength:128000,pricing:{promptPerM:1,completionPerM:3},benchmarks:{codingIndex:82,intelligenceIndex:70,gpqaAccuracy:0.78} },
    { id:"demo/efficient",name:"Efficient — illustrative",contextLength:64000,pricing:{promptPerM:0.15,completionPerM:0.6},benchmarks:{codingIndex:65,intelligenceIndex:56,gpqaAccuracy:0.6} },
    { id:"demo/unmeasured",name:"Unmeasured — illustrative",contextLength:32000,pricing:{promptPerM:null,completionPerM:null},benchmarks:{} },
  ], {presetId:"coding",qualityPreference:"balanced"}, "2026-09-28T00:00:00Z");
}
