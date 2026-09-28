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
// `m.id.endsWith(":free")` looks like proof that a model costs nothing. It
// is not. OpenRouter's own catalog prices by token budget string, and a free
// model reports its prompt price as the literal "0". A model whose id ends in
// `:free` while its pricing says otherwise would walk into the fallback ladder
// claiming to be free and bill the user for the judge call this app promises
// costs nothing. A missing or unparseable price is not evidence of free either
// -- the ladder ranks raw /models rows, which carry raw pricing strings, not
// the merged candidate shape, so this cannot assume `pricing.promptPerM`
// exists. Only a declared price of exactly 0 counts as free; anything else is
// left out of the ladder, where `rankFreeModels` has always left out models it
// cannot call for free.
function isDeclaredFree(m) {
  const pricing = m && m.pricing;
  if (!pricing) return false;
  if (pricing.promptPerM !== undefined || pricing.completionPerM !== undefined) {
    return pricing.promptPerM === 0 && pricing.completionPerM === 0;
  }
  return perMillion(pricing.prompt) === 0 && perMillion(pricing.completion) === 0;
}

export function rankFreeModels(models) {
  return (models || [])
    .filter((m) => typeof m.id === "string" && m.id.endsWith(":free"))
    // Only text-output models can judge prose at all. A model whose architecture
    // declares its outputs and does NOT include "text" is excluded outright: an
    // absent/null `architecture` is missing data, but a declared list without
    // "text" is a positive claim that this model cannot answer in prose, and
    // asking it to wastes a ladder rung on a request that can only fail. A
    // declared list that IS `[]` is treated as undeclared rather than as a
    // declaration of "outputs nothing", because no real model outputs nothing.
    .filter((m) => {
      const declared = m.architecture ? m.architecture.output_modalities : null;
      return Array.isArray(declared) && declared.length === 0 ? true : !Array.isArray(declared) || declared.includes("text");
    })
    .filter(isDeclaredFree)
    .slice()
    .sort((a, b) => {
      const ra = (a.supported_parameters || []).includes("reasoning") ? 1 : 0;
      const rb = (b.supported_parameters || []).includes("reasoning") ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return (b.context_length || 0) - (a.context_length || 0);
    });
}

// How many free judges one search is worth. Five sequential chat completions
// is already a long wait for a request whose whole point is "which model should
// I use"; the sixth and later would only be reached when the free roster has
// several broken or refusing entries, and at that point the honest answer is to
// report what was tried rather than keep the user staring at a spinner.
export const JUDGE_ATTEMPT_LIMIT = 5;

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

// The shortlist reaches the judge as one line per candidate, and a newline,
// carriage return or Unicode line separator inside a model name or description
// (third-party strings from OpenRouter's /models payload) would emit a second
// line the judge reads as a genuine extra candidate -- carrying whatever price
// and benchmark text that string's author typed. Left-to-right/right-to-left
// overrides are just as bad in a single line: they reorder or hide characters
// in the rendered prompt, so what the judge "sees" is not what was sent.
const BIDI_AND_INVISIBLE = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// C0/C1 control characters except tab, which the whitespace squeeze folds to a
// space. This includes \n and \r, so the collapse below cannot be defeated by
// an exotic line ending.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Collapse a third-party string to one inert line, then cut it to length. The
// order matters: flattening after the cut would let content past the boundary
// survive, and a backtick left in place can open a code span that swallows the
// rest of the field. This is the judge-side counterpart of the escapeHtml()
// treatment renderTable already gives the table's own name and id cells.
function oneLine(value, maxLength) {
  if (typeof value !== "string") return "";
  const flat = value
    .replace(BIDI_AND_INVISIBLE, "")
    .replace(CONTROL_CHARS, "")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*#>\s]+/, "");
  if (maxLength && flat.length > maxLength) return `${flat.slice(0, maxLength)}…`;
  return flat;
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
    const name = oneLine(c.name) || oneLine(c.id);
    const note = oneLine(c.description, 200);
    return `- ${name} (${oneLine(c.id)}): ${price}. Benchmarks: ${metrics.length ? metrics.join(", ") : "none reported"}.${note ? ` ${note}` : ""}`;
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
