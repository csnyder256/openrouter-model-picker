// Regression tests for the /models <-> /benchmarks join key.
//
// `mergeModelsWithBenchmarks` used to key its benchmark indexes by the raw
// `model_permaslug` and look them up with the catalog's `canonical_slug`, on the
// assumption that the two endpoints spell a model the same way. They do not.
// Verified live on 2026-10-15 (462 catalog models, 348 Artificial Analysis rows,
// 325 OpenRouter rows), a `model_permaslug` is EITHER the dated canonical slug
// /models reports as `canonical_slug` (`openai/gpt-5.6-sol-20260922`) OR the
// plain catalog id /models reports as `id` (`openai/gpt-5.6-sol`). 27 rows ship
// in the id form -- all 14 usable `search_*` rows, 8 `gpqa_diamond` rows,
// 2 `tau_bench_verified_airline` rows and 1 Artificial Analysis row -- and every
// one of them was silently dropped.
//
// The cost was not a cosmetic empty cell. `searchAvg` is the `web-research`
// preset's `primaryMetric`, and it stayed null on 461 of the 462 live models,
// so that preset's "Best quality" mode had nothing to rank on and fell through
// to the context-length/id tie-break -- with the judge's top-15 shortlist sliced
// from that same arbitrary order. These fixtures use the live shapes verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeModelsWithBenchmarks, sortCandidates, findPreset } from "../lib/match.js";

// A /models row. `slug` is what /models calls `canonical_slug`; `id` is what it
// calls `id`, and the two differ by the dated suffix for every real model.
function catalogRow(id, slug) {
  return {
    id,
    canonical_slug: slug,
    name: id,
    context_length: 128000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: [],
  };
}

test("a gpqa row keyed by the catalog id joins the model that carries that id", () => {
  // The live shape: `openai/gpt-6-luna` is a catalog id whose canonical slug is
  // dated, and the benchmark row names the id.
  const models = [catalogRow("openai/gpt-6-luna", "openai/gpt-6-luna-20260922")];
  const orRows = [{ model_permaslug: "openai/gpt-6-luna", benchmark_type: "gpqa_diamond", accuracy: 0.9 }];

  const merged = mergeModelsWithBenchmarks(models, [], orRows);
  assert.equal(
    merged[0].benchmarks.gpqaAccuracy,
    0.9,
    "an id-keyed benchmark row must join the catalog row whose id it names"
  );
});

test("a benchmark row keyed by the dated canonical slug still joins exactly as before", () => {
  // The shape that already worked, kept as a guard against the resolution
  // rewriting a key that is already the join key.
  const models = [catalogRow("openai/gpt-6-luna", "openai/gpt-6-luna-20260922")];
  const orRows = [
    { model_permaslug: "openai/gpt-6-luna-20260922", benchmark_type: "gpqa_diamond", accuracy: 0.8 },
    { model_permaslug: "openai/gpt-6-luna-20260922", benchmark_type: "tau_bench_verified_airline", accuracy: 0.7 },
  ];
  const merged = mergeModelsWithBenchmarks(models, [], orRows);
  assert.equal(merged[0].benchmarks.gpqaAccuracy, 0.8);
  assert.equal(merged[0].benchmarks.tauBenchAccuracy, 0.7);
});

test("a key that is both a canonical slug and an id resolves to itself and still joins", () => {
  // `openrouter/auto` is the one live model whose canonical slug IS its id, so
  // its own search_hle row (the only search row that used to join) must keep
  // working.
  const models = [catalogRow("openrouter/auto", "openrouter/auto")];
  const orRows = [{ model_permaslug: "openrouter/auto", benchmark_type: "search_hle", primary_score: 0.5245 }];
  const merged = mergeModelsWithBenchmarks(models, [], orRows);
  assert.equal(merged[0].benchmarks.searchAvg, 0.5245);
});

test("an id-keyed search row populates searchAvg, which is what the web-research preset ranks on", () => {
  // Every one of the 14 usable live `search_*` rows is id-keyed, so before the
  // fix `searchAvg` was non-null on exactly one model in the whole catalog
  // (openrouter/auto) and the preset ranked nothing.
  const models = [
    catalogRow("openai/gpt-5.6-luna", "openai/gpt-5.6-luna-20260709"),
    catalogRow("acme/no-search-data", "acme/no-search-data-20260101"),
  ];
  const orRows = [
    { model_permaslug: "openai/gpt-5.6-luna", benchmark_type: "search_browsecomp", primary_score: 0.74 },
    { model_permaslug: "openai/gpt-5.6-luna", benchmark_type: "search_dsqa", primary_score: 0.874766 },
    { model_permaslug: "openai/gpt-5.6-luna", benchmark_type: "search_hle", primary_score: 0.71 },
    { model_permaslug: "openai/gpt-5.6-luna", benchmark_type: "search_widesearch", primary_score: 0.834223 },
  ];
  const merged = mergeModelsWithBenchmarks(models, [], orRows);
  const scored = merged.find((c) => c.id === "openai/gpt-5.6-luna");
  const unscored = merged.find((c) => c.id === "acme/no-search-data");

  // searchAvg is the mean of the search rows, read from `primary_score` --
  // the live search rows carry no `accuracy` field at all.
  const expected = (0.74 + 0.874766 + 0.71 + 0.834223) / 4;
  assert.equal(scored.benchmarks.searchAvg, expected);
  // The model with no search row stays unmeasured, never zero.
  assert.equal(unscored.benchmarks.searchAvg, null);

  // The user-visible consequence: "Best quality" for the web-research preset now
  // ranks by search performance instead of falling through to the tie-break.
  const preset = findPreset("web-research");
  assert.equal(preset.primaryMetric, "searchAvg");
  assert.deepEqual(
    sortCandidates(merged, preset, "quality").map((c) => c.id),
    ["openai/gpt-5.6-luna", "acme/no-search-data"]
  );
});

test("an id-keyed row covers every catalog row that shares the resolved slug", () => {
  // `:batch` variants are separate catalog rows with the same canonical slug, so
  // one id-keyed benchmark row has to reach both -- the same coverage a
  // slug-keyed row already gives them.
  const models = [
    catalogRow("openai/gpt-5.6-sol", "openai/gpt-5.6-sol-20260709"),
    catalogRow("openai/gpt-5.6-sol:batch", "openai/gpt-5.6-sol-20260709"),
  ];
  const orRows = [{ model_permaslug: "openai/gpt-5.6-sol", benchmark_type: "gpqa_diamond", accuracy: 0.81 }];
  const merged = mergeModelsWithBenchmarks(models, [], orRows);
  assert.deepEqual(merged.map((c) => c.benchmarks.gpqaAccuracy), [0.81, 0.81]);
});

test("an Artificial Analysis row keyed by catalog id joins the same way", () => {
  // One live AA row ships in the id form: `deepseek/deepseek-chat` for the
  // catalog model whose canonical slug is `deepseek/deepseek-chat-v3`.
  const models = [catalogRow("deepseek/deepseek-chat", "deepseek/deepseek-chat-v3")];
  const aaRows = [{ model_permaslug: "deepseek/deepseek-chat", intelligence_index: 44, coding_index: 30, agentic_index: 12 }];
  const merged = mergeModelsWithBenchmarks(models, aaRows, []);
  assert.equal(merged[0].benchmarks.intelligenceIndex, 44);
  assert.equal(merged[0].benchmarks.codingIndex, 30);
  assert.equal(merged[0].benchmarks.agenticIndex, 12);
});

test("an id-keyed row never redirects to another model's series", () => {
  // `a/one` is a catalog id; `b/one` is a different model. Resolving the key
  // must map it to the canonical slug of the row that owns that id and nothing
  // else -- an id is not a licence to attach whatever slug looks similar.
  const models = [catalogRow("a/one", "a/one-20260101"), catalogRow("b/one", "b/one-20260202")];
  const orRows = [{ model_permaslug: "a/one", benchmark_type: "gpqa_diamond", accuracy: 0.5 }];
  const merged = mergeModelsWithBenchmarks(models, [], orRows);
  const a = merged.find((c) => c.id === "a/one");
  const b = merged.find((c) => c.id === "b/one");
  assert.equal(a.benchmarks.gpqaAccuracy, 0.5);
  assert.equal(b.benchmarks.gpqaAccuracy, null);
});

test("a benchmark key that names no catalog row stays unmatched and invents nothing", () => {
  // `unbiased/pareto`, `openai/gpt-5.3-chat-20260303` and
  // `inclusionai/ling-3.0-flash-fin-20260827` are live benchmark rows whose key
  // is neither a catalog id nor a canonical slug. An unresolvable key is not
  // evidence about any model, so every field must stay null rather than default
  // to 0 -- and no unrelated model may pick the row up.
  const models = [catalogRow("acme/real", "acme/real-20260101")];
  const orRows = [
    { model_permaslug: "unbiased/pareto", benchmark_type: "gpqa_diamond", accuracy: 0.99 },
    { model_permaslug: "inclusionai/ling-3.0-flash-fin-20260827", benchmark_type: "tau_bench_verified_airline", accuracy: 0.99 },
  ];
  const aaRows = [{ model_permaslug: "ai21/jamba-1-5-large", intelligence_index: 99 }];
  const merged = mergeModelsWithBenchmarks(models, aaRows, orRows);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].benchmarks, {
    intelligenceIndex: null,
    codingIndex: null,
    agenticIndex: null,
    gpqaAccuracy: null,
    tauBenchAccuracy: null,
    searchAvg: null,
  });
});

test("a catalog row with no canonical slug is joined by its id, unchanged", () => {
  // The fallback key when /models omits `canonical_slug` is the id, both for the
  // model's own lookup and for a benchmark row that names it.
  const models = [{ ...catalogRow("acme/noslug", undefined), canonical_slug: undefined }];
  const orRows = [{ model_permaslug: "acme/noslug", benchmark_type: "gpqa_diamond", accuracy: 0.42 }];
  const merged = mergeModelsWithBenchmarks(models, [], orRows);
  assert.equal(merged[0].canonicalSlug, "acme/noslug");
  assert.equal(merged[0].benchmarks.gpqaAccuracy, 0.42);
});

test("a malformed benchmark row does not disturb the join for well-formed ones", () => {
  const models = [catalogRow("acme/one", "acme/one-20260101")];
  const orRows = [
    { benchmark_type: "gpqa_diamond", accuracy: 0.1 }, // no model_permaslug at all
    { model_permaslug: "acme/one", benchmark_type: "gpqa_diamond", accuracy: 0.6 },
  ];
  const merged = mergeModelsWithBenchmarks(models, [], orRows);
  assert.equal(merged[0].benchmarks.gpqaAccuracy, 0.6);
});
