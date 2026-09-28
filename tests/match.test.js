import { test } from "node:test";
import assert from "node:assert/strict";
import {
  perMillion,
  mergeModelsWithBenchmarks,
  filterByTask,
  filterByPriceCeiling,
  sortCandidates,
  rankFreeModels,
  rankForTask,
  isTaskCompatible,
  nextFallbackModel,
  findPreset,
  buildJudgeMessages,
  candidatePromptLine,
  isRetryableJudgeStatus,
  resolveTaskDescription,
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

// --- judge-prompt hardening -------------------------------------------------

// A Unicode bidi override or zero-width character does not split a line, so the
// existing "one candidate per line" guard walks straight past it. It is worse
// than a newline: the judge (and Cade, in any log or diff of the request) reads
// characters in an order that is not the order that was sent. No real model
// name or description contains one, so the rule is erase, then truncate.
test("buildJudgeMessages erases bidi and zero-width characters instead of forwarding them to the judge", () => {
  const shortlist = [
    {
      id: "acme/evil",
      name: "\u202Ereversed\u202C",
      description: `ordinary model.\u202Ehidden\u200B\u200D\uFEFF tail`,
      pricing: { promptPerM: 0, completionPerM: 0 },
      benchmarks: { intelligenceIndex: 50, codingIndex: null, agenticIndex: null, gpqaAccuracy: null, tauBenchAccuracy: null, searchAvg: null },
    },
  ];
  const content = buildJudgeMessages("write code", { qualityPreference: "quality" }, shortlist)[1].content;

  for (const ch of ["\u202E", "\u202C", "\u200B", "\u200D", "\uFEFF"]) {
    assert.equal(content.includes(ch), false, `judge prompt still carries U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
  }
  // the visible text must survive the erasure, not be removed with it
  assert.match(content, /reversed/);
  assert.match(content, /ordinary model\./);
  assert.match(content, /hidden/);
});

test("buildJudgeMessages erases control characters that could restructure the prompt", () => {
  const shortlist = [
    {
      id: "acme/ctrl",
      name: "Ctrl\u0000Model\u0007",
      description: "bell\u0008backspace and a vertical tab\u000Bhere",
      pricing: { promptPerM: 0, completionPerM: 0 },
      benchmarks: {},
    },
  ];
  const content = buildJudgeMessages("write code", { qualityPreference: "quality" }, shortlist)[1].content;
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(content), false);
  assert.match(content, /CtrlModel/);
});

test("buildJudgeMessages keeps one candidate per line when a description carries a form feed", () => {
  // A form feed is not \n, so a naive newline check still sees one line, but it
  // is a line terminator to plenty of readers downstream.
  const shortlist = [
    { id: "a/one", name: "One", description: "first\u000Csecond", pricing: { promptPerM: 0, completionPerM: 0 }, benchmarks: {} },
  ];
  const content = buildJudgeMessages("write code", { qualityPreference: "quality" }, shortlist)[1].content;
  const candidateLines = content.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(candidateLines.length, 1);
});

test("candidatePromptLine truncates a description after flattening, not before", () => {
  // Truncating first would let a bidi override sitting just past the boundary
  // survive inside the kept slice. Flatten first, then cut: the emitted line is
  // never longer than the limit once its own prefix is accounted for.
  const long = "\u202E" + "x".repeat(199) + "\u202E" + "y".repeat(50);
  const line = candidatePromptLine({
    id: "a/long",
    name: "Long",
    description: long,
    pricing: { promptPerM: 0, completionPerM: 0 },
    benchmarks: {},
  });
  assert.equal(line.includes("\u202E"), false);
  const description = line.split(". ").slice(4).join(". ");
  assert.ok(description.length <= 200, `description slice is ${description.length} chars`);
});

// --- judge sees the constraints the shortlist was built under ---------------

// filterByTask already narrows the table to a preset's modality requirements,
// then buildJudgeMessages handed the judge a list with no statement of them.
// For a vision/OCR task that is a real failure mode: the judge is ranking
// models on benchmark numbers alone, with nothing telling it the task's only
// viable models are ones that can read an image.
test("buildJudgeMessages tells the judge the modality constraints the shortlist was filtered by", () => {
  const preset = findPreset("vision-ocr");
  const shortlist = [
    {
      id: "a/vision:free",
      name: "VisionFree",
      description: "Reads images.",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      pricing: { promptPerM: 0, completionPerM: 0 },
      benchmarks: { intelligenceIndex: 40, codingIndex: null, agenticIndex: null, gpqaAccuracy: null, tauBenchAccuracy: null, searchAvg: null },
    },
  ];
  const prefs = { qualityPreference: "quality", preset, maxPromptPerM: 0 };
  const msgs = buildJudgeMessages("read the totals off this invoice screenshot", prefs, shortlist);
  const system = msgs[0].content;

  assert.match(system, /must accept image input/);
  assert.match(system, /constraints, not preferences/);
  assert.match(msgs[1].content, /OCR/);
  // and the constraint must be stated as a constraint, never as "you may pick
  // a model outside this". The negative form is what keeps the judge honest.
  assert.doesNotMatch(system, /may recommend a model outside/);
});

test("buildJudgeMessages states an output-side requirement for a generation preset", () => {
  const preset = findPreset("text-to-speech");
  const shortlist = [
    {
      id: "a/tts:free",
      name: "TTSFree",
      description: "Speaks.",
      inputModalities: ["text"],
      outputModalities: ["text", "audio"],
      pricing: { promptPerM: 0, completionPerM: 0 },
      benchmarks: {},
    },
  ];
  const msgs = buildJudgeMessages("narrate this article", { qualityPreference: "quality", preset }, shortlist);
  assert.match(msgs[0].content, /must produce audio output/);
});

test("buildJudgeMessages adds no requirement text for a preset that has no modality requirement", () => {
  const preset = findPreset("coding");
  const msgs = buildJudgeMessages("write code", { qualityPreference: "quality", preset }, [
    { id: "a/x", name: "X", description: "y", pricing: {}, benchmarks: {} },
  ]);
  assert.doesNotMatch(msgs[0].content, /Hard requirements/);
  assert.match(msgs[1].content, /task preset: Coding/);
});

// --- the judge ladder considers modality -----------------------------------

test("isTaskCompatible treats an undeclared modality list as compatible, never as a limitation", () => {
  const preset = findPreset("vision-ocr");
  // an absent property is missing data, which this repo never turns into a claim
  assert.equal(isTaskCompatible({}, preset), true);
  // a present-but-empty list is also an absence of data, not a declared "none"
  assert.equal(isTaskCompatible({ inputModalities: [], outputModalities: [] }, preset), true);
  // declared-and-insufficient IS evidence
  assert.equal(isTaskCompatible({ inputModalities: ["text"], outputModalities: ["text"] }, preset), false);
  assert.equal(isTaskCompatible({ inputModalities: ["text", "image"], outputModalities: ["text"] }, preset), true);
  // a model that declares no input list at all but does declare an output list
  // is still missing data on the input side
  assert.equal(isTaskCompatible({ outputModalities: ["text"] }, preset), true);
  assert.equal(isTaskCompatible({ inputModalities: ["image"] }, preset), true);
});

test("rankForTask promotes image-capable free models above text-only ones for an OCR task", () => {
  const preset = findPreset("vision-ocr");
  // Order here is what rankFreeModels returns today: a capable text-only model
  // outranks a vision model on reasoning support plus context length.
  const ladder = [
    { id: "a/text-only:free", inputModalities: ["text"], outputModalities: ["text"] },
    { id: "b/vision:free", inputModalities: ["text", "image"], outputModalities: ["text"] },
  ];
  assert.deepEqual(rankForTask(ladder, preset).map((m) => m.id), ["b/vision:free", "a/text-only:free"]);
});

test("rankForTask preserves the incoming ranking within each group and never drops an entry", () => {
  // `c/undeclared:free` is ordered before the vision models to prove an absent
  // modality list is never relegated: it sorts with the models that can serve
  // the task, and the input order is kept inside each group.
  const preset = findPreset("vision-ocr");
  const ladder = [
    { id: "c/undeclared:free" },
    { id: "b/vision-high:free", inputModalities: ["text", "image"], outputModalities: ["text"] },
    { id: "a/text-only:free", inputModalities: ["text"], outputModalities: ["text"] },
    { id: "d/vision-low:free", inputModalities: ["text", "image"], outputModalities: ["text"] },
  ];
  const ranked = rankForTask(ladder, preset).map((m) => m.id);
  assert.deepEqual(ranked, ["c/undeclared:free", "b/vision-high:free", "d/vision-low:free", "a/text-only:free"]);
  assert.equal(ranked.length, ladder.length);
});

test("rankForTask is a no-op for a preset without modality requirements", () => {
  const ladder = [{ id: "a:free" }, { id: "b:free" }];
  assert.deepEqual(rankForTask(ladder, findPreset("coding")).map((m) => m.id), ["a:free", "b:free"]);
  assert.deepEqual(rankForTask(ladder, null).map((m) => m.id), ["a:free", "b:free"]);
});

test("rankForTask does not mutate the list it was given", () => {
  const preset = findPreset("vision-ocr");
  const ladder = [
    { id: "a/text-only:free", inputModalities: ["text"], outputModalities: ["text"] },
    { id: "b/vision:free", inputModalities: ["text", "image"], outputModalities: ["text"] },
  ];
  rankForTask(ladder, preset);
  assert.deepEqual(ladder.map((m) => m.id), ["a/text-only:free", "b/vision:free"]);
});

// The judge ladder is ranked from RAW /models rows, not merged candidates, and
// the two carry modality under different keys. A ranker that reads only the
// merged key sees "undeclared" on every real row and silently does nothing --
// which is why this is asserted against the raw shape and not just the merged
// one.
test("isTaskCompatible reads the raw /models architecture shape", () => {
  const preset = findPreset("vision-ocr");
  assert.equal(
    isTaskCompatible({ id: "a/text:free", architecture: { input_modalities: ["text"], output_modalities: ["text"] } }, preset),
    false
  );
  assert.equal(
    isTaskCompatible({ id: "b/vision:free", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }, preset),
    true
  );
  // no architecture at all is still missing data, not a limitation
  assert.equal(isTaskCompatible({ id: "c/unknown:free" }, preset), true);
  assert.equal(isTaskCompatible({ id: "d/empty:free", architecture: {} }, preset), true);
});

test("rankForTask promotes an image-capable raw /models row above a text-only one", () => {
  const preset = findPreset("vision-ocr");
  // exactly what rankFreeModels returns for the live roster: the text-only
  // model wins on reasoning support + context length, so it holds the top rung
  const ladder = [
    { id: "acme/text-only:free", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["reasoning"], context_length: 900000 },
    { id: "acme/vision-free:free", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: [], context_length: 32000 },
  ];
  assert.deepEqual(rankForTask(ladder, preset).map((m) => m.id), ["acme/vision-free:free", "acme/text-only:free"]);
});

test("rankForTask reads the declared output side on raw rows for a generation preset", () => {
  const preset = findPreset("image-generation");
  const ladder = [
    { id: "a/text-only:free", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { id: "b/image-out:free", architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] } },
  ];
  assert.deepEqual(rankForTask(ladder, preset).map((m) => m.id), ["b/image-out:free", "a/text-only:free"]);
});
