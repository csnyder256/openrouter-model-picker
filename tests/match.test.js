import { test } from "node:test";
import assert from "node:assert/strict";
import {
  perMillion,
  mergeModelsWithBenchmarks,
  filterByTask,
  filterByPriceCeiling,
  sortCandidates,
  rankFreeModels,
  nextFallbackModel,
  findPreset,
  buildJudgeMessages,
  isRetryableJudgeStatus,
  resolveTaskDescription,
  isTrulyFree,
  hasOutOfBandPricing,
} from "../lib/match.js";

test("perMillion converts per-token USD strings to per-million USD", () => {
  assert.equal(perMillion("0.0000025"), 2.5);
  assert.equal(perMillion("0"), 0);
  assert.equal(perMillion(undefined), null);
  assert.equal(perMillion(""), null);
});

test("perMillion treats a negative price as unknown, not as a real negative dollar figure", () => {
  // OpenRouter's own meta-routers (openrouter/auto, openrouter/fusion, etc.)
  // report pricing "-1" to mean "variable, priced by whichever model gets
  // picked" (confirmed live). A negative number is never a real price.
  assert.equal(perMillion("-1"), null);
  assert.equal(perMillion("-0.0001"), null);
});

test("mergeModelsWithBenchmarks joins on canonical_slug and never invents a zero", () => {
  const models = [
    {
      id: "acme/foo",
      canonical_slug: "acme/foo-20260101",
      name: "Foo",
      context_length: 1000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters: [],
    },
    {
      id: "acme/bar:free",
      canonical_slug: "acme/bar-20260101",
      name: "Bar",
      context_length: 2000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["reasoning"],
    },
  ];
  const aaRows = [{ model_permaslug: "acme/foo-20260101", intelligence_index: 50, coding_index: 60, agentic_index: 40 }];
  const orRows = [
    { model_permaslug: "acme/foo-20260101", benchmark_type: "gpqa_diamond", accuracy: 0.5 },
    { model_permaslug: "acme/foo-20260101", benchmark_type: "search_hle", accuracy: 0.3 },
    { model_permaslug: "acme/foo-20260101", benchmark_type: "search_dsqa", accuracy: 0.5 },
  ];

  const merged = mergeModelsWithBenchmarks(models, aaRows, orRows);
  const foo = merged.find((c) => c.id === "acme/foo");
  const bar = merged.find((c) => c.id === "acme/bar:free");

  assert.equal(foo.benchmarks.intelligenceIndex, 50);
  assert.equal(foo.benchmarks.codingIndex, 60);
  assert.equal(foo.benchmarks.gpqaAccuracy, 0.5);
  assert.equal(foo.benchmarks.searchAvg, 0.4); // mean of 0.3 and 0.5
  assert.equal(foo.pricing.promptPerM, 1);
  assert.equal(foo.isFree, false);

  // bar has zero benchmark coverage: every field must be null, not 0.
  assert.equal(bar.benchmarks.intelligenceIndex, null);
  assert.equal(bar.benchmarks.codingIndex, null);
  assert.equal(bar.benchmarks.gpqaAccuracy, null);
  assert.equal(bar.benchmarks.searchAvg, null);
  assert.equal(bar.isFree, true);
});

test("mergeModelsWithBenchmarks maps a meta-router's \"-1\" pricing sentinel to null, not a negative price", () => {
  const models = [
    {
      id: "openrouter/auto",
      canonical_slug: "openrouter/auto-20260101",
      name: "Auto Router",
      context_length: 2000000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "-1", completion: "-1" },
      supported_parameters: [],
    },
  ];
  const merged = mergeModelsWithBenchmarks(models, [], []);
  assert.equal(merged[0].pricing.promptPerM, null);
  assert.equal(merged[0].pricing.completionPerM, null);
  // and it must therefore be excluded from a free-only (ceiling 0) search,
  // the same as any other candidate with an unknown price.
  assert.equal(filterByPriceCeiling(merged, 0, 0).length, 0);
});

test("filterByTask enforces modality requirements", () => {
  const candidates = [
    { id: "a", inputModalities: ["text"], outputModalities: ["text"] },
    { id: "b", inputModalities: ["text", "image"], outputModalities: ["text"] },
    { id: "c", inputModalities: ["text"], outputModalities: ["text", "audio"] },
  ];
  const ocr = findPreset("vision-ocr");
  const tts = findPreset("text-to-speech");
  const coding = findPreset("coding");

  assert.deepEqual(filterByTask(candidates, ocr).map((c) => c.id), ["b"]);
  assert.deepEqual(filterByTask(candidates, tts).map((c) => c.id), ["c"]);
  assert.deepEqual(filterByTask(candidates, coding).map((c) => c.id), ["a", "b", "c"]);
});

test("filterByPriceCeiling excludes models priced above the ceiling and models with unknown price", () => {
  const candidates = [
    { id: "free", pricing: { promptPerM: 0, completionPerM: 0 } },
    { id: "cheap", pricing: { promptPerM: 1, completionPerM: 2 } },
    { id: "pricey", pricing: { promptPerM: 10, completionPerM: 20 } },
    { id: "unknown", pricing: { promptPerM: null, completionPerM: null } },
  ];
  const freeOnly = filterByPriceCeiling(candidates, 0, 0);
  assert.deepEqual(freeOnly.map((c) => c.id), ["free"]);

  const under5 = filterByPriceCeiling(candidates, 5, 5);
  assert.deepEqual(under5.map((c) => c.id), ["free", "cheap"]);

  const noCeiling = filterByPriceCeiling(candidates, null, null);
  assert.equal(noCeiling.length, 4);
});

test("sortCandidates: quality puts highest metric first and sinks unmeasured models", () => {
  const preset = findPreset("coding");
  const candidates = [
    { id: "no-data", benchmarks: { codingIndex: null }, pricing: {} },
    { id: "low", benchmarks: { codingIndex: 30 }, pricing: {} },
    { id: "high", benchmarks: { codingIndex: 90 }, pricing: {} },
  ];
  const sorted = sortCandidates(candidates, preset, "quality");
  assert.deepEqual(sorted.map((c) => c.id), ["high", "low", "no-data"]);
});

test("sortCandidates: cheapest sorts by blended price ascending", () => {
  const preset = findPreset("coding");
  const candidates = [
    { id: "mid", benchmarks: {}, pricing: { promptPerM: 5, completionPerM: 5 } },
    { id: "free", benchmarks: {}, pricing: { promptPerM: 0, completionPerM: 0 } },
    { id: "expensive", benchmarks: {}, pricing: { promptPerM: 20, completionPerM: 20 } },
  ];
  const sorted = sortCandidates(candidates, preset, "cheapest");
  assert.deepEqual(sorted.map((c) => c.id), ["free", "mid", "expensive"]);
});

test("sortCandidates: balanced favors quality-per-dollar over raw quality", () => {
  const preset = findPreset("coding");
  const candidates = [
    { id: "expensive-and-great", benchmarks: { codingIndex: 90 }, pricing: { promptPerM: 20, completionPerM: 20 } },
    { id: "free-and-decent", benchmarks: { codingIndex: 60 }, pricing: { promptPerM: 0, completionPerM: 0 } },
  ];
  const sorted = sortCandidates(candidates, preset, "balanced");
  assert.equal(sorted[0].id, "free-and-decent");
});

test("sortCandidates: balanced breaks ties between multiple free candidates by raw metric, never NaN-orders them", () => {
  // A quality-per-dollar ratio is Infinity for every $0 candidate, and
  // Infinity minus Infinity is NaN, which is not a valid comparator result.
  // This is the app's own default (free-only), so it must rank correctly.
  const preset = findPreset("coding");
  const candidates = [
    { id: "free-low", benchmarks: { codingIndex: 20 }, pricing: { promptPerM: 0, completionPerM: 0 } },
    { id: "free-high", benchmarks: { codingIndex: 90 }, pricing: { promptPerM: 0, completionPerM: 0 } },
    { id: "free-mid", benchmarks: { codingIndex: 50 }, pricing: { promptPerM: 0, completionPerM: 0 } },
  ];
  const sorted = sortCandidates(candidates, preset, "balanced");
  assert.deepEqual(
    sorted.map((c) => c.id),
    ["free-high", "free-mid", "free-low"]
  );
});

test("rankFreeModels only returns :free models, reasoning-capable ones first", () => {
  const models = [
    { id: "a/no-free", context_length: 999999, supported_parameters: ["reasoning"] },
    { id: "a/plain:free", context_length: 8000, supported_parameters: [] },
    { id: "a/reasoner:free", context_length: 4000, supported_parameters: ["reasoning"] },
    { id: "a/bigger-plain:free", context_length: 16000, supported_parameters: [] },
  ];
  const ranked = rankFreeModels(models);
  assert.deepEqual(
    ranked.map((m) => m.id),
    ["a/reasoner:free", "a/bigger-plain:free", "a/plain:free"]
  );
});

test("nextFallbackModel skips already-tried ids and returns null when exhausted", () => {
  const ranked = [{ id: "x:free" }, { id: "y:free" }];
  assert.equal(nextFallbackModel(ranked, []).id, "x:free");
  assert.equal(nextFallbackModel(ranked, ["x:free"]).id, "y:free");
  assert.equal(nextFallbackModel(ranked, ["x:free", "y:free"]), null);
});

test("isRetryableJudgeStatus: only 401 (bad key) stops the fallback ladder", () => {
  assert.equal(isRetryableJudgeStatus(401), false);
  assert.equal(isRetryableJudgeStatus(429), true); // rate limited
  assert.equal(isRetryableJudgeStatus(403), true); // model restricts itself to agentic callers (seen live)
  assert.equal(isRetryableJudgeStatus(404), true);
  assert.equal(isRetryableJudgeStatus(500), true);
});

test("resolveTaskDescription never substitutes the custom preset's own placeholder hint as a task", () => {
  const custom = findPreset("custom");
  const coding = findPreset("coding");
  assert.equal(resolveTaskDescription(custom, ""), "");
  assert.equal(resolveTaskDescription(custom, "   "), "");
  assert.equal(resolveTaskDescription(custom, "translate this legal contract"), "translate this legal contract");
  // a real preset's hint IS an actual task, so it's a fine fallback when cleared
  assert.equal(resolveTaskDescription(coding, ""), "Write, complete, or generate code.");
});

test("buildJudgeMessages includes the task, preferences, and every shortlisted model id", () => {
  const shortlist = [
    {
      id: "acme/foo",
      name: "Foo",
      description: "A test model.",
      pricing: { promptPerM: 1, completionPerM: 2 },
      benchmarks: { intelligenceIndex: 50, codingIndex: null, agenticIndex: null, gpqaAccuracy: null, tauBenchAccuracy: null, searchAvg: null },
    },
  ];
  const msgs = buildJudgeMessages("write a sorting function", { qualityPreference: "quality", maxPromptPerM: 0 }, shortlist);
  assert.equal(msgs.length, 2);
  assert.match(msgs[1].content, /write a sorting function/);
  assert.match(msgs[1].content, /acme\/foo/);
  assert.match(msgs[0].content, /Do not just output a score/);
});

test("buildJudgeMessages never describes a model with an unknown price as $0.00", () => {
  // openrouter/auto and similar meta-routers report a null (unknown, not
  // free) price. Telling the judge LLM "$0.00" would be a false claim.
  const shortlist = [
    {
      id: "openrouter/auto",
      name: "Auto Router",
      description: "Routes to whichever model fits.",
      pricing: { promptPerM: null, completionPerM: null },
      benchmarks: { intelligenceIndex: 80, codingIndex: null, agenticIndex: null, gpqaAccuracy: null, tauBenchAccuracy: null, searchAvg: null },
    },
  ];
  const msgs = buildJudgeMessages("write code", { qualityPreference: "quality" }, shortlist);
  assert.doesNotMatch(msgs[1].content, /\$0\.00/);
  assert.match(msgs[1].content, /unknown/);
});

// ---------------------------------------------------------------------------
// "Free" must mean one thing. Live evidence (2026-09-28, 458 models): the
// `:free` suffix and a $0/$0 token price disagree in both directions, and a
// per-artifact-billed model reports $0/$0 while charging per use.
// ---------------------------------------------------------------------------

test("isTrulyFree reads the price, not the :free suffix", () => {
  // Priced $0/$0 with no suffix: stealth/space-bunny-alpha, openrouter/free.
  assert.equal(isTrulyFree({ id: "stealth/space-bunny-alpha", pricing: { prompt: "0", completion: "0" } }), true);
  // A :free id whose price is not zero would not be free, whatever it claims.
  assert.equal(isTrulyFree({ id: "acme/x:free", pricing: { prompt: "0.000001", completion: "0" } }), false);
  // Unknown price is not free: "unmeasured is not zero".
  assert.equal(isTrulyFree({ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } }), false);
  assert.equal(isTrulyFree({ id: "acme/y", pricing: {} }), false);
  assert.equal(isTrulyFree({ id: "acme/z" }), false);
});

test("hasOutOfBandPricing catches a $0-per-token model billed per artifact", () => {
  // google/lyria-3-pro-preview and lyria-3-clip-preview, verbatim shape.
  const lyriaPro = {
    id: "google/lyria-3-pro-preview",
    pricing: { prompt: "0", completion: "0" },
    description: "Full-length songs are priced at $0.08 per song. Lyria 3 is Google's family of music generation models.",
  };
  const lyriaClip = {
    id: "google/lyria-3-clip-preview",
    pricing: { prompt: "0", completion: "0" },
    description: "30 second duration clips are priced at $0.04 per clip.",
  };
  assert.equal(hasOutOfBandPricing(lyriaPro), true);
  assert.equal(hasOutOfBandPricing(lyriaClip), true);
  // $0/$0 with no per-use price in the description is genuinely free.
  assert.equal(
    hasOutOfBandPricing({ id: "openrouter/free", pricing: { prompt: "0", completion: "0" }, description: "The simplest way to get free inference." }),
    false
  );
  // A model that is not free at all is never "metered-free".
  assert.equal(
    hasOutOfBandPricing({ id: "acme/paid", pricing: { prompt: "0.000002", completion: "0.000002" }, description: "$5 per image." }),
    false
  );
});

test("mergeModelsWithBenchmarks badges a $0/$0 router with no :free suffix as free", () => {
  const models = [
    { id: "openrouter/free", canonical_slug: "openrouter/free", name: "Free Models Router", description: "Free inference.", context_length: 200000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
  ];
  const merged = mergeModelsWithBenchmarks(models, [], []);
  assert.equal(merged[0].isFree, true);
  assert.equal(merged[0].outOfBandPricing, false);
});

test("mergeModelsWithBenchmarks marks a per-artifact-billed $0/$0 model as metered, not free", () => {
  const models = [
    { id: "google/lyria-3-clip-preview", canonical_slug: "google/lyria-3-clip-preview", name: "Lyria 3 Clip",
      description: "30 second duration clips are priced at $0.04 per clip.", context_length: 1048576,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "audio"] },
      pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
  ];
  const merged = mergeModelsWithBenchmarks(models, [], []);
  assert.equal(merged[0].outOfBandPricing, true);
  // The badge must never say free on a model that bills per clip: isFree is
  // the app's whole claim about cost, so it absorbs the metered case.
  assert.equal(merged[0].isFree, false);
});

test("a free-only search excludes a metered $0/$0 model, but a positive ceiling still admits it", () => {
  const candidates = [
    { id: "openrouter/free", pricing: { promptPerM: 0, completionPerM: 0 }, outOfBandPricing: false },
    { id: "google/lyria-3-clip-preview", pricing: { promptPerM: 0, completionPerM: 0 }, outOfBandPricing: true },
    { id: "acme/cheap", pricing: { promptPerM: 1, completionPerM: 1 }, outOfBandPricing: false },
  ];
  // ceiling 0,0 is the app's "free models only" default: the $0.00 row that is
  // billed per clip must not be presented as free.
  assert.deepEqual(filterByPriceCeiling(candidates, 0, 0).map((c) => c.id), ["openrouter/free"]);
  // a $5 ceiling claims nothing about free, so the metered model is allowed
  // alongside the two $0 models and the $1 model.
  assert.deepEqual(filterByPriceCeiling(candidates, 5, 5).map((c) => c.id), ["openrouter/free", "google/lyria-3-clip-preview", "acme/cheap"]);
  // one-sided zero ceilings are not the free-only claim, so no metered filter.
  assert.equal(filterByPriceCeiling(candidates, 0, 5).length, 2);
});
