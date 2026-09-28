import { fetchModels, fetchBenchmarks, chatCompletion, OpenRouterError } from "./lib/or-client.js";
import { renderMarkdownLite, escapeHtml } from "./lib/markdown-lite.js";
import {
  TASK_PRESETS,
  findPreset,
  mergeModelsWithBenchmarks,
  filterByTask,
  filterByPriceCeiling,
  sortCandidates,
  rankFreeModels,
  nextFallbackModel,
  buildJudgeMessages,
  isRetryableJudgeStatus,
  resolveTaskDescription,
} from "./lib/match.js";

const KEY_STORAGE = "orpicker.apiKey";

const el = {
  apiKey: document.getElementById("api-key"),
  keyStatus: document.getElementById("key-status"),
  forgetKey: document.getElementById("forget-key"),
  taskPreset: document.getElementById("task-preset"),
  taskDesc: document.getElementById("task-desc"),
  freeOnly: document.getElementById("free-only"),
  maxPrompt: document.getElementById("max-prompt"),
  maxCompletion: document.getElementById("max-completion"),
  qualityPref: document.getElementById("quality-pref"),
  findBtn: document.getElementById("find-models"),
  queryStatus: document.getElementById("query-status"),
  recPanel: document.getElementById("rec-panel"),
  recommendation: document.getElementById("recommendation"),
  resultsPanel: document.getElementById("results-panel"),
  resultsCount: document.getElementById("results-count"),
  tbody: document.querySelector("#results-table tbody"),
  thead: document.querySelector("#results-table thead"),
};

let lastCandidates = [];
let lastSortKey = null;
let lastSortDir = 1;

function initApiKey() {
  const saved = localStorage.getItem(KEY_STORAGE);
  if (saved) {
    el.apiKey.value = saved;
    el.keyStatus.textContent = "Key loaded from this browser's local storage.";
  }
  el.apiKey.addEventListener("change", () => {
    if (el.apiKey.value) {
      localStorage.setItem(KEY_STORAGE, el.apiKey.value);
      el.keyStatus.textContent = "Key saved to this browser's local storage.";
    }
  });
  el.forgetKey.addEventListener("click", () => {
    localStorage.removeItem(KEY_STORAGE);
    el.apiKey.value = "";
    el.keyStatus.textContent = "Key forgotten.";
  });
}

function initTaskControls() {
  for (const preset of TASK_PRESETS) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.label;
    el.taskPreset.appendChild(opt);
  }
  el.taskPreset.value = "coding";
  const applyPresetHint = () => {
    const preset = findPreset(el.taskPreset.value);
    if (preset && preset.id !== "custom") el.taskDesc.value = preset.hint;
    else if (preset && preset.id === "custom" && !el.taskDesc.value) el.taskDesc.value = "";
  };
  el.taskPreset.addEventListener("change", applyPresetHint);
  applyPresetHint();

  el.freeOnly.addEventListener("change", () => {
    const disabled = el.freeOnly.checked;
    el.maxPrompt.disabled = disabled;
    el.maxCompletion.disabled = disabled;
    if (disabled) {
      el.maxPrompt.value = 0;
      el.maxCompletion.value = 0;
    } else {
      el.maxPrompt.value = "";
      el.maxCompletion.value = "";
    }
  });
}

function readPreferences() {
  const preset = findPreset(el.taskPreset.value);
  const maxPromptPerM = el.maxPrompt.value === "" ? null : Number(el.maxPrompt.value);
  const maxCompletionPerM = el.maxCompletion.value === "" ? null : Number(el.maxCompletion.value);
  return {
    preset,
    taskDescription: resolveTaskDescription(preset, el.taskDesc.value),
    maxPromptPerM,
    maxCompletionPerM,
    qualityPreference: el.qualityPref.value,
  };
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? null : o[k]), obj);
}

function fmtPrice(v) {
  return v == null ? "" : `$${v.toFixed(2)}`;
}
function fmtIndex(v) {
  return v == null ? "" : v.toFixed(1);
}
function fmtPct(v) {
  return v == null ? "" : `${(v * 100).toFixed(1)}%`;
}

function renderTable(candidates) {
  el.tbody.innerHTML = "";
  for (const c of candidates) {
    const tr = document.createElement("tr");
    // A model with $0 token pricing that is billed per artifact (per song,
    // per clip) gets no "free" badge, because that badge is a claim about
    // what the call costs and this call is not free. It gets its own marker
    // instead, so a $0.00 row that is not free never reads as a bug.
    const badge = c.isFree
      ? '<span class="free-badge">free</span>'
      : c.outOfBandPricing
        ? '<span class="metered-badge" title="Token price is $0, but this model bills per use. See its description.">metered</span>'
        : "";
    tr.innerHTML = `
      <td class="model">${escapeHtml(c.name)}${badge}<span class="id">${escapeHtml(c.id)}</span></td>
      <td class="num ${c.pricing.promptPerM == null ? "na" : ""}">${fmtPrice(c.pricing.promptPerM) || "?"}</td>
      <td class="num ${c.pricing.completionPerM == null ? "na" : ""}">${fmtPrice(c.pricing.completionPerM) || "?"}</td>
      <td class="num">${c.contextLength ? c.contextLength.toLocaleString() : ""}</td>
      <td class="num ${c.benchmarks.intelligenceIndex == null ? "na" : ""}">${fmtIndex(c.benchmarks.intelligenceIndex) || "n/a"}</td>
      <td class="num ${c.benchmarks.codingIndex == null ? "na" : ""}">${fmtIndex(c.benchmarks.codingIndex) || "n/a"}</td>
      <td class="num ${c.benchmarks.agenticIndex == null ? "na" : ""}">${fmtIndex(c.benchmarks.agenticIndex) || "n/a"}</td>
      <td class="num ${c.benchmarks.gpqaAccuracy == null ? "na" : ""}">${fmtPct(c.benchmarks.gpqaAccuracy) || "n/a"}</td>
      <td class="num ${c.benchmarks.tauBenchAccuracy == null ? "na" : ""}">${fmtPct(c.benchmarks.tauBenchAccuracy) || "n/a"}</td>
      <td class="num ${c.benchmarks.searchAvg == null ? "na" : ""}">${fmtPct(c.benchmarks.searchAvg) || "n/a"}</td>
    `;
    el.tbody.appendChild(tr);
  }
  el.resultsCount.textContent = `Showing ${candidates.length} model${candidates.length === 1 ? "" : "s"}.`;
}

function initTableSort() {
  el.thead.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-key]");
    if (!th) return;
    const key = th.dataset.key;
    lastSortDir = lastSortKey === key ? -lastSortDir : -1;
    lastSortKey = key;
    for (const h of el.thead.querySelectorAll("th")) h.classList.remove("sorted");
    th.classList.add("sorted");
    const sorted = lastCandidates.slice().sort((a, b) => {
      const va = getPath(a, key);
      const vb = getPath(b, key);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return lastSortDir * va.localeCompare(vb);
      return lastSortDir * (va - vb);
    });
    renderTable(sorted);
  });
}

// Three requests per search: /models once, plus one per benchmark source.
// The raw /models rows are returned too, because the judge's fallback ladder
// ranks free models from them; fetching the catalog a second time for that
// would download the whole model list twice.
async function fetchAllData(apiKey) {
  const [models, aaRows, orRows] = await Promise.all([
    fetchModels(apiKey),
    fetchBenchmarks(apiKey, "artificial-analysis"),
    fetchBenchmarks(apiKey, "openrouter"),
  ]);
  return { merged: mergeModelsWithBenchmarks(models, aaRows, orRows), rawModels: models };
}

async function runJudge(apiKey, allModelsRaw, taskDescription, preferences, shortlist) {
  const ranked = rankFreeModels(allModelsRaw);
  const tried = [];
  const messages = buildJudgeMessages(taskDescription, preferences, shortlist);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = nextFallbackModel(ranked, tried);
    if (!candidate) break;
    tried.push(candidate.id);
    try {
      const result = await chatCompletion(apiKey, candidate.id, messages);
      const text = result.choices?.[0]?.message?.content || "(empty response)";
      return { modelId: candidate.id, text, attempts: tried };
    } catch (err) {
      lastErr = err;
      if (err instanceof OpenRouterError && !isRetryableJudgeStatus(err.status)) {
        throw err;
      }
    }
  }
  throw lastErr || new Error("No free model was available to judge this request.");
}

async function onFindModels() {
  const apiKey = el.apiKey.value.trim();
  if (!apiKey) {
    el.queryStatus.textContent = "Enter your OpenRouter API key above first.";
    el.queryStatus.classList.add("err");
    return;
  }
  el.queryStatus.classList.remove("err");
  el.findBtn.disabled = true;
  el.recPanel.hidden = true;
  el.resultsPanel.hidden = true;

  try {
    const prefs = readPreferences();
    if (!prefs.taskDescription) {
      el.queryStatus.textContent = "Describe the task in the text box first.";
      el.queryStatus.classList.add("err");
      el.findBtn.disabled = false;
      return;
    }
    el.queryStatus.textContent = "Fetching live model list and benchmark data…";
    const { merged, rawModels } = await fetchAllData(apiKey);

    let candidates = filterByTask(merged, prefs.preset);
    candidates = filterByPriceCeiling(candidates, prefs.maxPromptPerM, prefs.maxCompletionPerM);
    candidates = sortCandidates(candidates, prefs.preset, prefs.qualityPreference);

    lastCandidates = candidates;
    lastSortKey = null;
    renderTable(candidates);
    el.resultsPanel.hidden = false;

    if (!candidates.length) {
      el.queryStatus.textContent = "No models matched. Try raising the price ceiling or a different task.";
      return;
    }

    el.queryStatus.textContent = `Found ${candidates.length} matching models. Asking a free model to judge the shortlist…`;
    const shortlist = candidates.slice(0, 15);
    const judged = await runJudge(apiKey, rawModels, prefs.taskDescription, prefs, shortlist);

    el.recommendation.innerHTML =
      `<div class="who">Judged by ${escapeHtml(judged.modelId)}${judged.attempts.length > 1 ? ` (after ${judged.attempts.length - 1} unavailable free model${judged.attempts.length > 2 ? "s" : ""})` : ""}. This judging call cost $0.</div>` +
      renderMarkdownLite(judged.text);
    el.recPanel.hidden = false;
    el.queryStatus.textContent = `Found ${candidates.length} matching models.`;
  } catch (err) {
    console.error(err);
    el.queryStatus.textContent = `Error: ${err.message}`;
    el.queryStatus.classList.add("err");
  } finally {
    el.findBtn.disabled = false;
  }
}

initApiKey();
initTaskControls();
initTableSort();
el.findBtn.addEventListener("click", onFindModels);
