// Pure, DOM-free, fetch-free logic: everything here is unit-testable with
// node:test and reused as-is by the browser app. No external dependencies.

export const TASK_PRESETS = [
  { id: "coding", label: "Coding", hint: "Write, complete, or generate code.", primaryMetric: "codingIndex" },
  { id: "code-review", label: "Code Review", hint: "Review, critique, or find bugs in existing code.", primaryMetric: "codingIndex" },
  { id: "general-chat", label: "General Chat / Assistant", hint: "Open-ended conversation and general assistance.", primaryMetric: "intelligenceIndex" },
  { id: "reasoning-math", label: "Reasoning / Math", hint: "Multi-step reasoning, math, graduate-level problem solving.", primaryMetric: "gpqaAccuracy" },
  { id: "agentic-tools", label: "Agentic / Tool Use", hint: "Multi-turn tool use and autonomous task completion.", primaryMetric: "tauBenchAccuracy" },
  { id: "web-research", label: "Web Search / Research", hint: "Research questions that need a live web lookup.", primaryMetric: "searchAvg" },
  { id: "vision-ocr", label: "OCR / Document Extraction", hint: "Read text out of images, scans, or PDFs.", requireInput: ["image"], primaryMetric: "intelligenceIndex" },
  { id: "vision-understanding", label: "Image Understanding (Vision)", hint: "Describe, classify, or answer questions about images.", requireInput: ["image"], primaryMetric: "intelligenceIndex" },
  { id: "image-generation", label: "Image Generation", hint: "Generate or edit images from a text prompt.", requireOutput: ["image"], primaryMetric: null },
  { id: "text-to-speech", label: "Text-to-Speech / Audio", hint: "Generate spoken audio from text.", requireOutput: ["audio"], primaryMetric: null },
  { id: "translation", label: "Translation", hint: "Translate text between languages.", primaryMetric: "intelligenceIndex" },
  { id: "summarization", label: "Summarization", hint: "Condense long documents or transcripts.", primaryMetric: "intelligenceIndex" },
  { id: "custom", label: "Custom task…", hint: "Describe your own task below.", primaryMetric: "intelligenceIndex" },
];

export function findPreset(id) {
  return TASK_PRESETS.find((p) => p.id === id) || null;
}

// --- Search epochs -------------------------------------------------------
//
// A "Find models" run is not atomic. It awaits three fetches, then up to
// `JUDGE_ATTEMPT_LIMIT` sequential judge completions, and the page stays
// interactive the whole time, so a second run can start while the first is
// still in flight. Each run needs a way to tell whether it is still the one
// the user is waiting for before it writes to the DOM.
//
// The epoch is that token: a monotonically increasing number, one per run.
// `beginSearch` claims the next epoch and returns it; every write is gated on
// `isCurrentSearch`, so an abandoned run renders nothing. This is a pure
// value/counter, not shared mutable UI state, which is why it is testable
// here rather than buried in app.js's wiring.
//
// Note what this is NOT: it never cancels a request, and it is deliberately
// independent of any AbortController. Superseding a run is a UI decision; the
// abort is only an optimization layer on top of it.
let nextSearchEpoch = 1;

export function beginSearch() {
  return nextSearchEpoch++;
}

// Revoke `epoch`'s ownership without handing out a new one. This is what Stop
// needs and `beginSearch` cannot express: Stop ends the run the user is waiting
// for and starts nothing, so a stopped run must stop being current while the
// counter stays put -- otherwise "current" would still mean "the newest run
// ever started", which is exactly the run that was just cancelled.
//
// Without this, aborting the transport is the only thing Stop does, and the
// transport is not reliable enough to carry the guarantee: a fetch that had
// already completed, a response body still being read, a promise the browser
// resolves before it observes the abort, or a `chat/completions` that answers
// mid-flight all resolve after Stop and then pass an `isCurrentSearch` gate
// that never changed. Revoking ownership first means every later DOM write is
// dropped no matter how the request ends.
export function invalidateSearch(epoch) {
  const wasCurrent = isCurrentSearch(epoch);
  if (wasCurrent) nextSearchEpoch++;
  // Returns whether this call revoked a live run. `false` means the epoch was
  // already stale -- nothing was cancelled -- which is what lets Stop report a
  // click that landed after the run had finished instead of claiming a
  // cancellation that never happened.
  return wasCurrent;
}

// Is `epoch` still the newest run? A search that has been superseded by a
// later `beginSearch()`, or revoked by `invalidateSearch()`, is still
// *running* -- its fetches have not necessarily stopped -- but its results are
// no longer what the user asked for.
export function isCurrentSearch(epoch) {
  return epoch === nextSearchEpoch - 1;
}

// The custom preset's own hint ("Describe your own task below.") is a
// placeholder instruction, not a task, so it must never be substituted in
// as if the user had typed it. Every other preset's hint IS a real task
// description and is a fine fallback if the field was cleared.
export function resolveTaskDescription(preset, rawText) {
  const trimmed = (rawText || "").trim();
  if (trimmed) return trimmed;
  return preset && preset.id !== "custom" ? preset.hint : "";
}

// OpenRouter prices are USD-per-token strings. The UI and the price ceiling
// both work in USD-per-million-tokens, which is the unit humans reason in.
// OpenRouter uses "-1" as a sentinel for "variable, priced by whichever
// underlying model gets picked" on its own meta-routers (openrouter/auto,
// openrouter/fusion, etc., verified live). A negative number is never a
// real price, so it is treated the same as missing: unknown, not free.
export function perMillion(pricePerTokenStr) {
  if (pricePerTokenStr === undefined || pricePerTokenStr === null || pricePerTokenStr === "") return null;
  const n = Number(pricePerTokenStr);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

// Join /models rows with /benchmarks rows on canonical_slug === model_permaslug.
// A model with no benchmark coverage still gets a candidate: every benchmark
// field is left null rather than defaulted to 0, so "no data" is never
// confused with "measured and bad" (the same discipline RAG-OS's own registry
// applies to harness metrics it cannot observe).
export function mergeModelsWithBenchmarks(models, aaRows, orRows) {
  const aaBySlug = new Map((aaRows || []).map((r) => [r.model_permaslug, r]));
  const orBySlug = new Map();
  for (const r of orRows || []) {
    if (!orBySlug.has(r.model_permaslug)) orBySlug.set(r.model_permaslug, {});
    const bucket = orBySlug.get(r.model_permaslug);
    if (r.benchmark_type === "gpqa_diamond") bucket.gpqaAccuracy = r.accuracy;
    else if (r.benchmark_type === "tau_bench_verified_airline") bucket.tauBenchAccuracy = r.accuracy;
    else if (typeof r.benchmark_type === "string" && r.benchmark_type.startsWith("search_")) {
      bucket.search = bucket.search || {};
      bucket.search[r.benchmark_type.slice("search_".length)] = r.primary_score ?? r.accuracy ?? null;
    }
  }

  return (models || []).map((m) => {
    const slug = m.canonical_slug || m.id;
    const aa = aaBySlug.get(slug);
    const or = orBySlug.get(slug) || {};
    const searchVals = or.search ? Object.values(or.search).filter((v) => typeof v === "number") : [];
    const arch = m.architecture || {};
    return {
      id: m.id,
      canonicalSlug: slug,
      name: m.name || m.id,
      description: m.description || "",
      contextLength: m.context_length ?? null,
      inputModalities: arch.input_modalities || [],
      outputModalities: arch.output_modalities || [],
      supportedParameters: m.supported_parameters || [],
      isFree: typeof m.id === "string" && m.id.endsWith(":free"),
      pricing: {
        promptPerM: perMillion(m.pricing && m.pricing.prompt),
        completionPerM: perMillion(m.pricing && m.pricing.completion),
      },
      benchmarks: {
        intelligenceIndex: aa ? aa.intelligence_index ?? null : null,
        codingIndex: aa ? aa.coding_index ?? null : null,
        agenticIndex: aa ? aa.agentic_index ?? null : null,
        gpqaAccuracy: or.gpqaAccuracy ?? null,
        tauBenchAccuracy: or.tauBenchAccuracy ?? null,
        searchAvg: searchVals.length ? searchVals.reduce((a, b) => a + b, 0) / searchVals.length : null,
      },
    };
  });
}

function hasAny(list, wanted) {
  if (!wanted || !wanted.length) return true;
  return wanted.some((w) => (list || []).includes(w));
}

export function filterByTask(candidates, preset) {
  if (!preset) return candidates;
  return candidates.filter(
    (c) => hasAny(c.inputModalities, preset.requireInput) && hasAny(c.outputModalities, preset.requireOutput)
  );
}

// A ceiling of null/undefined means "no ceiling". A ceiling of 0 means
// free-only, which is the app's default. A candidate with an unknown price
// (null) is excluded from a priced search, since "unknown" cannot be proven
// to satisfy a ceiling.
export function filterByPriceCeiling(candidates, maxPromptPerM, maxCompletionPerM) {
  return candidates.filter((c) => {
    const okPrompt = maxPromptPerM == null || (c.pricing.promptPerM != null && c.pricing.promptPerM <= maxPromptPerM);
    const okCompletion =
      maxCompletionPerM == null || (c.pricing.completionPerM != null && c.pricing.completionPerM <= maxCompletionPerM);
    return okPrompt && okCompletion;
  });
}

function blendedPrice(c) {
  const vals = [c.pricing.promptPerM, c.pricing.completionPerM].filter((v) => typeof v === "number");
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// "Best quality" sorts by the task's primary benchmark metric (missing data
// sinks to the bottom, it is never treated as a zero). "Cheapest" sorts by
// blended price ascending. "Balanced" ranks by quality-per-dollar so a model
// twice as expensive still needs to be meaningfully better to rank above one
// that is merely well-measured and cheap.
export function sortCandidates(candidates, preset, qualityPreference) {
  const metric = preset && preset.primaryMetric;
  const list = candidates.slice();
  const metricOf = (c) => (metric ? c.benchmarks[metric] : null);

  if (qualityPreference === "cheapest") {
    list.sort((a, b) => {
      const pa = blendedPrice(a), pb = blendedPrice(b);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pa - pb;
    });
    return list;
  }

  if (qualityPreference === "balanced") {
    // A quality-per-dollar ratio is Infinity for every free ($0) candidate
    // with a measured metric, and Infinity minus Infinity is NaN, not a
    // valid comparator result, so two free candidates must never reach the
    // subtraction below: their tie is broken by raw metric value instead.
    // This is the app's own default configuration (free-only), so getting
    // it wrong here silently defeats "Balanced" for the common case.
    const ratioOf = (c) => {
      const m = metricOf(c);
      const p = blendedPrice(c);
      if (m == null || p == null) return null;
      return p === 0 ? Infinity : m / p;
    };
    list.sort((a, b) => {
      const ra = ratioOf(a), rb = ratioOf(b);
      if (ra == null && rb == null) return 0;
      if (ra == null) return 1;
      if (rb == null) return -1;
      if (ra === rb) {
        const ma = metricOf(a), mb = metricOf(b);
        if (ma == null && mb == null) return 0;
        if (ma == null) return 1;
        if (mb == null) return -1;
        return mb - ma;
      }
      return rb - ra;
    });
    return list;
  }

  // "quality" (default): highest metric first, undated last.
  list.sort((a, b) => {
    const ma = metricOf(a), mb = metricOf(b);
    if (ma == null && mb == null) return 0;
    if (ma == null) return 1;
    if (mb == null) return -1;
    return mb - ma;
  });
  return list;
}

// Free models, ranked by a capability proxy (reasoning support, then context
// length) so the fallback ladder tries the more capable judges first. This is
// deliberately dynamic rather than a hardcoded model-id list, since the
// `:free` roster changes as OpenRouter adds and retires models.
export function rankFreeModels(models) {
  return (models || [])
    .filter((m) => typeof m.id === "string" && m.id.endsWith(":free"))
    .filter((m) => (m.architecture ? m.architecture.output_modalities?.includes("text") : true))
    .slice()
    .sort((a, b) => {
      const ra = (a.supported_parameters || []).includes("reasoning") ? 1 : 0;
      const rb = (b.supported_parameters || []).includes("reasoning") ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return (b.context_length || 0) - (a.context_length || 0);
    });
}

export function nextFallbackModel(rankedFreeModels, triedIds) {
  const tried = new Set(triedIds || []);
  return rankedFreeModels.find((m) => !tried.has(m.id)) || null;
}

// Only a bad API key (401) is unfixable by trying the next free model.
// Everything else is worth advancing the fallback ladder for: 429 rate
// limits, a 403 because this particular free model restricts itself to
// "agentic harness" callers (observed live from thinkingmachines/inkling-
// small:free), a 404, or a 5xx.
export function isRetryableJudgeStatus(status) {
  return status !== 401;
}

// The prompt sent to the free judge model. Deliberately asks for prose
// reasoning and trade-offs rather than a bare numeric score.
export function buildJudgeMessages(taskDescription, preferences, shortlist) {
  const lines = shortlist.map((c) => {
    const b = c.benchmarks;
    const metrics = [];
    if (b.intelligenceIndex != null) metrics.push(`intelligence ${b.intelligenceIndex}`);
    if (b.codingIndex != null) metrics.push(`coding ${b.codingIndex}`);
    if (b.agenticIndex != null) metrics.push(`agentic ${b.agenticIndex}`);
    if (b.gpqaAccuracy != null) metrics.push(`GPQA-Diamond ${(b.gpqaAccuracy * 100).toFixed(1)}%`);
    if (b.tauBenchAccuracy != null) metrics.push(`tau-bench-airline ${(b.tauBenchAccuracy * 100).toFixed(1)}%`);
    if (b.searchAvg != null) metrics.push(`search avg ${(b.searchAvg * 100).toFixed(1)}%`);
    // A null price (OpenRouter's own meta-routers, e.g. openrouter/auto,
    // report "variable, depends on the model picked") must never render as
    // $0.00: that would tell the judge the model is free when its real
    // price is unknown, which is exactly the "unmeasured is not zero"
    // mistake this app's own design notes warn against.
    const fmtPrice = (v) => (v == null ? "unknown" : `$${v.toFixed(2)}/M`);
    const price = `${fmtPrice(c.pricing.promptPerM)} in, ${fmtPrice(c.pricing.completionPerM)} out`;
    return `- ${c.name} (${c.id}): ${price}. Benchmarks: ${metrics.length ? metrics.join(", ") : "none reported"}. ${c.description.slice(0, 200)}`;
  });

  const prefLine = [
    preferences.maxPromptPerM != null ? `max prompt price $${preferences.maxPromptPerM}/M tokens` : null,
    preferences.maxCompletionPerM != null ? `max completion price $${preferences.maxCompletionPerM}/M tokens` : null,
    preferences.qualityPreference ? `optimizing for: ${preferences.qualityPreference}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  return [
    {
      role: "system",
      content:
        "You are a model-selection assistant. You are given a shortlist of real, currently-available AI models with their live OpenRouter pricing and benchmark data. Recommend the best fit for the user's task and stated preferences. Explain your reasoning in plain prose: name the model you recommend, why it beats the runner-up for THIS task, and any real trade-off (price, latency, missing benchmark coverage, modality limits). Do not just output a score. Keep it to a few short paragraphs. Only recommend models from the shortlist given.",
    },
    {
      role: "user",
      content: `Task: ${taskDescription}\nPreferences: ${prefLine || "none stated"}\n\nCandidate models:\n${lines.join("\n")}`,
    },
  ];
}
