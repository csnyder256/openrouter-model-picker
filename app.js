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
  nextFallbackModel,
  buildJudgeMessages,
  isRetryableJudgeStatus,
  resolveTaskDescription,
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
// Milliseconds a finished-but-unclaimed run waited before its state was
// dropped; kept so Stop can tell "cancelled a live run" from "clicked after
// the run had already finished".
let finishedAt = null;

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
    tr.innerHTML = `
      <td class="model">${escapeHtml(c.name)}${c.isFree ? '<span class="free-badge">free</span>' : ""}<span class="id">${escapeHtml(c.id)}</span></td>
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
  const ranked = rankFreeModels(allModelsRaw);
  const tried = [];
  const messages = buildJudgeMessages(taskDescription, preferences, shortlist);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
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
  throw lastErr || new Error("No free model was available to judge this request.");
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
      `<div class="who">Judged by ${escapeHtml(judged.modelId)}${judged.attempts.length > 1 ? ` (after ${judged.attempts.length - 1} unavailable free model${judged.attempts.length > 2 ? "s" : ""})` : ""}. This call was free.</div>` +
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
      // Nothing owns the buttons at the end of a finished run. That is what
      // lets Stop tell "cancelled a live search" from "clicked just after it
      // finished", and say so instead of claiming a cancellation that never
      // happened.
      finishedAt = Date.now();
    }
  }
}

function onStopSearch() {
  // Revoke the running search's ownership FIRST, while it is still the current
  // epoch, then abort its transport. Both are needed and neither is sufficient:
  // the abort stops requests that can still be stopped, and the revocation is
  // what actually guarantees no later DOM write -- because `Signal.abort()`
  // settles a fetch that had already completed, a body already being read, or a
  // promise the browser resolved before it observed the abort. After this the
  // stopped run fails every `isCurrentSearch` gate and every `isAbortError`
  // check in its own catch/finally, so it reports nothing and leaves the
  // buttons to this handler.
  const stopped = searchController;
  const revoked = stopped ? invalidateSearch(stopped.epoch) : false;
  if (stopped) stopped.abort();
  searchController = null;
  // A run that finished microseconds before the click is not a cancellation.
  // `finishedAt` is wall-clock and only ever compared against itself, so a
  // clock that does not advance cannot make this read either way.
  const justFinished = typeof finishedAt === "number" && Date.now() === finishedAt;
  finishedAt = null;
  setSearchButtons(false);
  el.queryStatus.classList.remove("err");
  el.queryStatus.textContent = revoked || !justFinished
    ? "Search stopped."
    : "Search stopped. (It had already finished; nothing was cancelled.)";
}

initApiKey();
initTaskControls();
initTableSort();
el.findBtn.addEventListener("click", onFindModels);
if (el.stopBtn) el.stopBtn.addEventListener("click", onStopSearch);
