// The benchmark join for OpenRouter's rolling "latest" aliases.
//
// `mergeModelsWithBenchmarks` joins `/models` to `/benchmarks` on
// `canonical_slug === model_permaslug`. That key works for every ordinary row,
// because `canonical_slug` is the dated slug the benchmark series is published
// under. The rolling `~…-latest` aliases are the exception: they are real,
// priced, selectable rows whose `canonical_slug` is their own id, so the join
// found nothing and every benchmark field landed null -- the table read "n/a"
// in all six columns, "Best quality" sank them to the bottom of every sort, and
// the judge prompt said "Benchmarks: none reported" for a model the same
// catalog measures in full.
//
// The catalog does say which model each alias stands for, in `alias_target`,
// and that pointer is a catalog id rather than a benchmark permaslug, so it has
// to be resolved through the catalog the join was built from.
//
// Live shapes below are copied from `/api/v1/models` on 2026-10-14 (462 rows,
// 19 of them `~`-prefixed, every one of the 19 carrying a resolvable
// `alias_target` whose name matches its target row's name exactly).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aliasBenchmarkSlug,
  buildJudgeMessages,
  candidatePromptLine,
  findPreset,
  mergeModelsWithBenchmarks,
  perMillion,
  sortCandidates,
} from "../lib/match.js";

// The alias row, verbatim in shape and value from the live catalog.
const LUNA_ALIAS = {
  id: "~openai/gpt-luna-latest",
  canonical_slug: "~openai/gpt-luna-latest",
  name: "OpenAI: GPT Luna Latest",
  description: "This model always redirects to the latest model in the GPT Luna family.",
  alias_target: { name: "OpenAI: GPT-6 Luna", slug: "openai/gpt-6-luna" },
  context_length: 1050000,
  architecture: { input_modalities: ["file", "image", "text"], output_modalities: ["text"] },
  pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0.00000001" },
  supported_parameters: ["reasoning"],
};

// The row the alias points at. Its `canonical_slug` is dated, which is the slug
// the benchmark series is actually published under.
const LUNA_TARGET = {
  id: "openai/gpt-6-luna",
  canonical_slug: "openai/gpt-6-luna-20260922",
  name: "OpenAI: GPT-6 Luna",
  description: "GPT-6 Luna is the fast, cost-efficient model in OpenAI's GPT-6 series.",
  context_length: 1050000,
  architecture: { input_modalities: ["file", "image", "text"], output_modalities: ["text"] },
  pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0.00000001" },
  supported_parameters: ["reasoning"],
};

const TARGET_SLUG = "openai/gpt-6-luna-20260922";

const AA_FOR_TARGET = [
  { model_permaslug: TARGET_SLUG, intelligence_index: 62, coding_index: 58, agentic_index: 44 },
];
const OR_FOR_TARGET = [
  { model_permaslug: TARGET_SLUG, benchmark_type: "gpqa_diamond", accuracy: 0.81 },
  { model_permaslug: TARGET_SLUG, benchmark_type: "tau_bench_verified_airline", accuracy: 0.7 },
  { model_permaslug: TARGET_SLUG, benchmark_type: "search_avg", primary_score: 0.55 },
];

const byId = (merged) => new Map(merged.map((m) => [m.id, m]));

test("a rolling alias inherits the measurements of the model its alias_target names", () => {
  // The defect: the alias's own canonical_slug is `~openai/gpt-luna-latest`,
  // which no benchmark row is ever keyed by, so all six fields were null.
  const merged = byId(mergeModelsWithBenchmarks([LUNA_ALIAS, LUNA_TARGET], AA_FOR_TARGET, OR_FOR_TARGET));
  const alias = merged.get("~openai/gpt-luna-latest");
  const target = merged.get("openai/gpt-6-luna");

  assert.deepEqual(alias.benchmarks, target.benchmarks, "the alias reads exactly what the model it names reads");
  assert.deepEqual(alias.benchmarks, {
    intelligenceIndex: 62,
    codingIndex: 58,
    agenticIndex: 44,
    gpqaAccuracy: 0.81,
    tauBenchAccuracy: 0.7,
    searchAvg: 0.55,
  });

  // Identity, price and free-ness come from the alias's own row, untouched: the
  // alias is a row in its own right, only its measurements are inherited.
  assert.equal(alias.canonicalSlug, "~openai/gpt-luna-latest");
  assert.equal(alias.name, "OpenAI: GPT Luna Latest");
  assert.deepEqual(alias.pricing, {
    promptPerM: perMillion("0.0000001"),
    completionPerM: perMillion("0.0000005"),
  });
  assert.equal(alias.contextLength, 1050000);
  assert.equal(alias.isFree, false);
});

test("coverage under the alias's own slug wins: the join is never redirected away from real data", () => {
  // If OpenRouter ever publishes a benchmark series for an alias directly, that
  // series is the alias's own measurement and must not be replaced by the
  // target's. The inheritance is conditional for exactly this reason.
  const own = [{ model_permaslug: "~openai/gpt-luna-latest", intelligence_index: 11, coding_index: 12 }];
  const merged = byId(mergeModelsWithBenchmarks([LUNA_ALIAS, LUNA_TARGET], [...own, ...AA_FOR_TARGET], OR_FOR_TARGET));
  assert.equal(merged.get("~openai/gpt-luna-latest").benchmarks.intelligenceIndex, 11);
  assert.equal(merged.get("~openai/gpt-luna-latest").benchmarks.codingIndex, 12);
  assert.equal(merged.get("openai/gpt-6-luna").benchmarks.intelligenceIndex, 62, "the target keeps its own row");
});

test("an OpenRouter-only alias still inherits when Artificial Analysis has no row for the target", () => {
  const merged = byId(mergeModelsWithBenchmarks([LUNA_ALIAS, LUNA_TARGET], [], OR_FOR_TARGET));
  const alias = merged.get("~openai/gpt-luna-latest");
  assert.equal(alias.benchmarks.gpqaAccuracy, 0.81);
  assert.equal(alias.benchmarks.tauBenchAccuracy, 0.7);
  assert.equal(alias.benchmarks.searchAvg, 0.55);
  assert.equal(alias.benchmarks.intelligenceIndex, null, "no AA row means no AA number, for the alias either");
});

test("a benchmark_type this app does not read is not coverage, so the alias still inherits", () => {
  const unreadable = [{ model_permaslug: "~openai/gpt-luna-latest", benchmark_type: "mystery_bench", accuracy: 0.9 }];
  const merged = byId(mergeModelsWithBenchmarks([LUNA_ALIAS, LUNA_TARGET], AA_FOR_TARGET, [...unreadable, ...OR_FOR_TARGET]));
  assert.equal(merged.get("~openai/gpt-luna-latest").benchmarks.codingIndex, 58);
});

test("an alias_target this catalog does not carry is not followed, and invents nothing", () => {
  // A pointer to a row that is not in the catalog is not evidence about any
  // model in it. Following it would mean guessing.
  const dangling = { ...LUNA_ALIAS, alias_target: { name: "Ghost", slug: "ghost/model" } };
  const merged = mergeModelsWithBenchmarks([dangling], AA_FOR_TARGET, OR_FOR_TARGET)[0];
  assert.deepEqual(merged.benchmarks, {
    intelligenceIndex: null,
    codingIndex: null,
    agenticIndex: null,
    gpqaAccuracy: null,
    tauBenchAccuracy: null,
    searchAvg: null,
  });
});

test("a row with no alias and no coverage still merges to nulls, never to zeros", () => {
  const plain = { ...LUNA_TARGET, id: "acme/nothing", canonical_slug: "acme/nothing-20260101" };
  delete plain.alias_target;
  const merged = mergeModelsWithBenchmarks([plain], AA_FOR_TARGET, OR_FOR_TARGET)[0];
  assert.deepEqual(merged.benchmarks, {
    intelligenceIndex: null,
    codingIndex: null,
    agenticIndex: null,
    gpqaAccuracy: null,
    tauBenchAccuracy: null,
    searchAvg: null,
  });
});

test("the inheritance can only add data: a covered row merges byte-for-byte as before", () => {
  // The safety property, stated as a test rather than a comment. A row with
  // coverage under its own slug must merge identically whether or not an alias
  // pointer is present -- including the alias row itself once it has its own
  // series. If this fails, the alias rule is capable of changing numbers that
  // were already right.
  const ownAliasRow = { model_permaslug: "~openai/gpt-luna-latest", intelligence_index: 11, coding_index: 12 };
  const covered = [LUNA_ALIAS, LUNA_TARGET, { ...LUNA_TARGET, id: "openai/gpt-6-luna:batch", canonical_slug: TARGET_SLUG }];
  const withAlias = mergeModelsWithBenchmarks(covered, [ownAliasRow, ...AA_FOR_TARGET], OR_FOR_TARGET);
  const withoutAlias = mergeModelsWithBenchmarks(
    covered.map((m) => { const copy = { ...m }; delete copy.alias_target; return copy; }),
    [ownAliasRow, ...AA_FOR_TARGET],
    OR_FOR_TARGET
  );
  assert.deepEqual(withAlias, withoutAlias);
  assert.equal(withAlias[0].benchmarks.codingIndex, 12, "the alias keeps its own series, not the target's 58");
});

test("inheriting for the alias leaves every other row in the merge untouched", () => {
  const withAlias = mergeModelsWithBenchmarks([LUNA_ALIAS, LUNA_TARGET], AA_FOR_TARGET, OR_FOR_TARGET);
  const withoutAlias = mergeModelsWithBenchmarks(
    [{ ...LUNA_ALIAS, alias_target: null }, LUNA_TARGET],
    AA_FOR_TARGET,
    OR_FOR_TARGET
  );
  assert.deepEqual(withAlias[1], withoutAlias[1], "the row the alias points at is merged identically");
  assert.equal(withAlias[0].benchmarks.codingIndex, 58, "...while the alias gained the target's measurements");
  assert.equal(withoutAlias[0].benchmarks.codingIndex, null);
});

test("a catalog that does not carry the target row cannot resolve the pointer, so nothing is inherited", () => {
  // Resolution is against the catalog this merge was handed, and nothing else.
  // Every one of the 19 live aliases resolves against the live catalog, so this
  // is the boundary case, not the normal one: a pointer with no target row is
  // not evidence, and guessing a slug from the alias's own name would be.
  const merged = mergeModelsWithBenchmarks([LUNA_ALIAS], AA_FOR_TARGET, OR_FOR_TARGET)[0];
  assert.equal(merged.benchmarks.intelligenceIndex, null);
  assert.equal(merged.benchmarks.gpqaAccuracy, null);
});

test("aliasBenchmarkSlug resolves a catalog id to that row's canonical slug, and refuses everything else", () => {
  const canonicalById = new Map([
    ["openai/gpt-6-luna", TARGET_SLUG],
    ["~openai/gpt-luna-latest", "~openai/gpt-luna-latest"],
  ]);
  assert.equal(aliasBenchmarkSlug(LUNA_ALIAS, canonicalById), TARGET_SLUG);

  // No pointer, an unusable pointer, an unresolvable pointer, or a pointer that
  // resolves back to the row's own slug: all mean "no redirect".
  assert.equal(aliasBenchmarkSlug(LUNA_TARGET, canonicalById), null);
  assert.equal(aliasBenchmarkSlug({ ...LUNA_ALIAS, alias_target: null }, canonicalById), null);
  assert.equal(aliasBenchmarkSlug({ ...LUNA_ALIAS, alias_target: { slug: "" } }, canonicalById), null);
  assert.equal(aliasBenchmarkSlug({ ...LUNA_ALIAS, alias_target: { slug: 42 } }, canonicalById), null);
  assert.equal(aliasBenchmarkSlug({ ...LUNA_ALIAS, alias_target: { slug: "ghost/model" } }, canonicalById), null);
  assert.equal(aliasBenchmarkSlug({ ...LUNA_ALIAS, alias_target: { slug: "~openai/gpt-luna-latest" } }, canonicalById), null);
  assert.equal(aliasBenchmarkSlug(LUNA_ALIAS, null), null, "no catalog means nothing to resolve against");
  assert.equal(aliasBenchmarkSlug(LUNA_ALIAS, { get: () => TARGET_SLUG }), null, "a Map is the contract");
});

test("the judge is told the alias's measurements instead of 'none reported'", () => {
  const alias = byId(mergeModelsWithBenchmarks([LUNA_ALIAS, LUNA_TARGET], AA_FOR_TARGET, OR_FOR_TARGET))
    .get("~openai/gpt-luna-latest");
  const line = candidatePromptLine(alias);
  assert.doesNotMatch(line, /none reported/);
  assert.match(line, /coding 58/);
  assert.match(line, /intelligence 62/);
  assert.match(line, /GPQA-Diamond 81\.0%/);

  const content = buildJudgeMessages("write code", { preset: findPreset("coding") }, [alias])[1].content;
  assert.match(content, /coding 58/);
  assert.doesNotMatch(content, /none reported/);
});

test("'Best quality' no longer sinks a measured alias below an unmeasured model", () => {
  // Discriminating on purpose: the unmeasured model has the larger context
  // window, so the context/length tie-break that catches an all-null row would
  // put it first. Only real inherited data can order the alias above it.
  const unmeasured = {
    id: "acme/unmeasured",
    canonical_slug: "acme/unmeasured-20260101",
    name: "Unmeasured",
    context_length: 2000000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000001", completion: "0.000003" },
    supported_parameters: [],
  };
  const merged = mergeModelsWithBenchmarks([LUNA_ALIAS, LUNA_TARGET, unmeasured], AA_FOR_TARGET, OR_FOR_TARGET);
  const ranked = sortCandidates(merged, findPreset("coding"), "quality");
  assert.deepEqual(ranked.map((m) => m.id), ["~openai/gpt-luna-latest", "openai/gpt-6-luna", "acme/unmeasured"]);
  assert.equal(ranked[0].benchmarks.codingIndex, 58);
  assert.equal(ranked[2].benchmarks.codingIndex, null, "the unmeasured row stays unmeasured, it is not scored zero");
});
