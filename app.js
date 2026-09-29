import { initComparisons } from "./lib/comparisons-ui.js";
import { fetchModels, fetchBenchmarks, chatCompletion, OpenRouterError, isAbortError } from "./lib/or-client.js";
import { renderMarkdownLite, escapeHtml } from "./lib/markdown-lite.js";
import {
  TASK_PRESETS,
  findPreset,
  mergeModelsWithBenchmarks,
  filterByTask,
  filterByPriceCeiling,
  sortCandidates,
  rankFreeModels,
  rankForTask,
  nextFallbackModel,
  buildJudgeMessages,
  isRetryableJudgeStatus,
  resolveTaskDescription,
  JUDGE_ATTEMPT_LIMIT,
  beginSearch,
  isCurrentSearch,
  invalidateSearch,
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
  stopBtn: document.getElementById("stop-models"),
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

// One in-flight search at a time. Starting a new search claims a new epoch and
// aborts the previous run's network calls; the previous run's `.then`/`.catch`
// still fire -- sometimes as an abort, sometimes as the result it was already
// carrying -- and each one checks its own epoch before touching the DOM, so a
// superseded run can neither render a stale table/verdict nor overwrite the
// live run's status with its own error. Ownership is what does the work here;
// the abort is an optimization on top of it, because aborting a signal does not
// reliably settle a request that had already completed.
// Browser-only state, so it lives here rather than in lib/match.js: the epoch
// arithmetic it depends on is the pure, tested part.
let searchController = null;

function initApiKey() {
  try {
    const saved = localStorage.getItem(KEY_STORAGE);
    if (saved) { el.apiKey.value = saved; el.keyStatus.textContent = "Key loaded from this browser's local storage."; }
  } catch { el.keyStatus.textContent = "Browser storage unavailable. A key can be used for this session."; }
  el.apiKey.addEventListener("change", () => {
    try {
      if (el.apiKey.value) localStorage.setItem(KEY_STORAGE, el.apiKey.value);
      else localStorage.removeItem(KEY_STORAGE);
      el.keyStatus.textContent = el.apiKey.value ? "Key saved to this browser's local storage." : "Key forgotten.";
    } catch { el.keyStatus.textContent = "Key retained for this session only; browser storage unavailable."; }
  });
  el.forgetKey.addEventListener("click", () => {
    el.apiKey.value = "";
    try { localStorage.removeItem(KEY_STORAGE); el.keyStatus.textContent = "Key forgotten."; }
    catch { el.keyStatus.textContent = "Session key cleared. Stored keys cannot be removed while browser storage is unavailable."; }
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
    comparisons.addControl(tr, c);
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
// would download the whole model list twice. `signal` cancels all three when
// the search is superseded or stopped.
async function fetchAllData(apiKey, signal) {
  const [models, aaRows, orRows] = await Promise.all([
    fetchModels(apiKey, signal),
    fetchBenchmarks(apiKey, "artificial-analysis", signal),
    fetchBenchmarks(apiKey, "openrouter", signal),
  ]);
  return { merged: mergeModelsWithBenchmarks(models, aaRows, orRows), rawModels: models };
}

async function runJudge(apiKey, allModelsRaw, taskDescription, preferences, shortlist, signal) {
  // This judge receives text metadata, never the user's image or audio.
  // Catalog modality ordering is a heuristic; it does not measure judgment
  // quality or establish that a model can carry out the user's task.
  const ranked = rankForTask(rankFreeModels(allModelsRaw), preferences.preset);
  const tried = [];
  const messages = buildJudgeMessages(taskDescription, preferences, shortlist);
  let lastErr = null;
  for (let attempt = 0; attempt < JUDGE_ATTEMPT_LIMIT; attempt++) {
    const candidate = nextFallbackModel(ranked, tried);
    if (!candidate) break;
    tried.push(candidate.id);
    try {
      const result = await chatCompletion(apiKey, candidate.id, messages, signal);
      const text = result.choices?.[0]?.message?.content || "(empty response)";
      return { modelId: candidate.id, text, attempts: tried };
    } catch (err) {
      if (isAbortError(err, signal)) throw err; // cancelled: not a judge failure
      lastErr = err;
      if (err instanceof OpenRouterError && !isRetryableJudgeStatus(err.status)) {
        throw err;
      }
    }
  }
  // Say which part failed. A search that found models but no judge is a
  // different outcome from a search that found nothing, and the user's next
  // move differs: raise the quality bar versus just click again later. When
  // the first attempt died with a real HTTP error, report that error rather
  // than a vaguer summary of it.
  if (!ranked.length) {
    throw new Error("No free model was available to judge this request.");
  }
  throw new Error(
    `No free model answered after ${tried.length} attempt${tried.length === 1 ? "" : "s"} (${tried.join(", ")}).` +
      (lastErr ? ` Last error: ${lastErr.message}` : "")
  );
}

function setSearchButtons(running) {
  el.findBtn.disabled = running;
  if (el.stopBtn) el.stopBtn.hidden = !running;
}

async function onFindModels() {
  const apiKey = el.apiKey.value.trim();
  if (!apiKey) {
    el.queryStatus.textContent = "Enter your OpenRouter API key above first.";
    el.queryStatus.classList.add("err");
    return;
  }

  // Claim this run's epoch and take over the single in-flight slot. Anything
  // still running from a previous click is now superseded: its network calls
  // are aborted, and its DOM writes are dropped by the `isCurrentSearch`
  // checks below. Without this, two searches overlap and the loser's judge
  // answer lands under the winner's table.
  const epoch = beginSearch();
  if (searchController) searchController.abort();
  const controller = new AbortController();
  // The controller carries the epoch it owns, so Stop can revoke exactly the
  // run it is stopping without guessing which epoch is current.
  controller.epoch = epoch;
  searchController = controller;
  const signal = controller.signal;

  el.queryStatus.classList.remove("err");
  setSearchButtons(true);
  el.recPanel.hidden = true;
  el.resultsPanel.hidden = true;

  try {
    const prefs = readPreferences();
    if (!prefs.taskDescription) {
      el.queryStatus.textContent = "Describe the task in the text box first.";
      el.queryStatus.classList.add("err");
      return; // finally restores the buttons for this, the current, run
    }
    // Local, immediate feedback, then a long network wait. The status line is
    // written before any await so a slow fetch cannot leave the button
    // spinning with nothing to read; the later messages replace it because
    // they are only written by a run that still owns the epoch.
    el.queryStatus.textContent = "Fetching live model list and benchmark data…";
    const { merged, rawModels } = await fetchAllData(apiKey, signal);
    if (!isCurrentSearch(epoch)) return;

    let candidates = filterByTask(merged, prefs.preset);
    candidates = filterByPriceCeiling(candidates, prefs.maxPromptPerM, prefs.maxCompletionPerM);
    candidates = sortCandidates(candidates, prefs.preset, prefs.qualityPreference);

    comparisons.refresh(merged);
    lastCandidates = candidates;
    lastSortKey = null;
    renderTable(candidates);
    el.resultsPanel.hidden = false;
    if (!isCurrentSearch(epoch)) return;

    if (!candidates.length) {
      el.queryStatus.textContent = "No models matched. Try raising the price ceiling or a different task.";
      return;
    }

    el.queryStatus.textContent = `Found ${candidates.length} matching models. Asking a free model to judge the shortlist…`;
    const shortlist = candidates.slice(0, 15);
    const judged = await runJudge(apiKey, rawModels, prefs.taskDescription, prefs, shortlist, signal);
    if (!isCurrentSearch(epoch)) return;

    el.recommendation.innerHTML =
      `<div class="who">Judged by ${escapeHtml(judged.modelId)}${judged.attempts.length > 1 ? ` (after ${judged.attempts.length - 1} unavailable free model${judged.attempts.length > 2 ? "s" : ""})` : ""}. This judging call cost $0.</div>` +
      renderMarkdownLite(judged.text);
    el.recPanel.hidden = false;
    el.queryStatus.textContent = `Found ${candidates.length} matching models.`;
  } catch (err) {
    // A superseded or user-stopped run must not report anything: the abort is
    // the intended outcome of starting a new search, not a failure to surface.
    if (isAbortError(err, signal) || !isCurrentSearch(epoch)) return;
    console.error(err);
    el.queryStatus.textContent = `Error: ${err.message}`;
    el.queryStatus.classList.add("err");
    // The table is already on screen by the time the judge runs, so a judging
    // failure must not leave the old recommendation (or a stale "asking a free
    // model…" status) sitting next to a fresh, unrelated table.
    el.recPanel.hidden = true;
  } finally {
    // Only the newest run owns the buttons. An older run reaching its finally
    // must not re-enable "Find models" while the current one is still working.
    if (isCurrentSearch(epoch)) {
      setSearchButtons(false);
      if (searchController === controller) searchController = null;
    }
  }
}

function onStopSearch() {
  // Revoke the running search's ownership FIRST, while it is still the current
  // epoch, then abort its transport. The abort is what actually stops the
  // requests that are still in flight; the revocation is what keeps a response
  // that arrived anyway -- one the browser had already resolved before it
  // observed the abort, or a judge call answered mid-flight -- from writing,
  // because an abort does not un-resolve a completed response. After this the
  // stopped run fails every `isCurrentSearch` gate in its own catch/finally, so
  // it reports nothing and leaves the buttons to this handler.
  const stopped = searchController;
  if (stopped) invalidateSearch(stopped.epoch);
  if (stopped) stopped.abort();
  searchController = null;
  setSearchButtons(false);
  el.queryStatus.classList.remove("err");
  el.queryStatus.textContent = "Search stopped.";
}

initApiKey();
initTaskControls();
const comparisons = initComparisons(readPreferences);
initTableSort();
el.findBtn.addEventListener("click", onFindModels);
if (el.stopBtn) el.stopBtn.addEventListener("click", onStopSearch);
