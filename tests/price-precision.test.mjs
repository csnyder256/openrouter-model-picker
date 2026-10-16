// The per-token -> per-million price conversion.
//
// `perMillion` is the single place the app turns OpenRouter's USD-per-token
// price strings into the USD-per-million numbers the table, the price ceiling,
// the judge prompt, the comparison panel and the JSON/CSV exports all use. The
// conversion is a decimal one, but `n * 1_000_000` is arithmetic in binary
// floating point, and the product is routinely not the decimal the catalog
// states.
//
// Measured against the live catalog on 2026-10-16 (465 models, 930 price
// dimensions, 202 distinct price strings): 139 dimensions landed off the
// stated decimal, and 11 of them landed *above* it. Two user-visible
// consequences, both reproduced below:
//
//   - `filterByPriceCeiling` compares the converted value to the number the
//     user typed, so a ceiling of exactly $0.57/M dropped the model priced at
//     exactly $0.57/M (`0.5700000000000001 <= 0.57` is false) -- for a model
//     the results table would have printed as "$0.57", with no indication it
//     had been excluded.
//   - the comparison panel prints the converted value as-is, and the JSON and
//     CSV exports write it verbatim, so a $0.20/M model read
//     "0.19999999999999998".
//
// The fixture strings below are verbatim from `/api/v1/models` on 2026-10-16.
// Expectations are computed with exact decimal string arithmetic, never with a
// second floating-point product, so a test can never agree with the defect it
// is guarding against.
import { test } from "node:test";
import assert from "node:assert/strict";

import { filterByPriceCeiling, mergeModelsWithBenchmarks, perMillion } from "../lib/match.js";
import { comparison, comparisonCSV } from "../lib/comparisons.js";

// Move a decimal point `places` to the right using string arithmetic. This is
// the exact answer the conversion is supposed to produce; doing it in floating
// point would reintroduce the very error under test.
function shiftDecimal(s, places) {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(String(s).trim());
  if (!m || (!m[1] && !m[2])) throw new Error("not a decimal: " + s);
  const digits = (m[1] || "") + (m[2] || "");
  const point = (m[1] || "").length + places;
  let out;
  if (point <= 0) out = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = digits.slice(0, point) + "." + digits.slice(point);
  return out.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

// The 11 live price dimensions whose binary product landed *above* the decimal
// the catalog states, which is the direction that can drop a model.
const INFLATED_LIVE_PRICES = [
  "0.0000000605",
  "0.000000177",
  "0.000000294",
  "0.000000304",
  "0.00000057",
  "0.000000825",
  "0.00000114",
  "0.00000198",
  "0.00000215",
  "0.00000228",
];

// Every distinct prompt/completion price string in the live catalog on
// 2026-10-16, minus the "-1" sentinel (which is not a price; see below).
const LIVE_PRICE_STRINGS = [
  "0", "0.00000001386", "0.0000000154", "0.000000017", "0.000000018",
  "0.000000021", "0.000000024", "0.00000002403", "0.000000025", "0.000000027",
  "0.000000029", "0.0000000296", "0.00000003", "0.000000035", "0.000000036",
  "0.0000000375", "0.00000004", "0.000000044", "0.00000005", "0.00000006",
  "0.0000000605", "0.0000000608", "0.000000063", "0.000000065", "0.00000007",
  "0.000000074", "0.000000075", "0.0000000765", "0.000000079", "0.00000008",
  "0.00000009", "0.000000091", "0.00000009375", "0.0000001", "0.00000011",
  "0.000000112", "0.00000012", "0.000000125", "0.00000013", "0.000000132",
  "0.000000136", "0.00000014", "0.00000015", "0.000000177", "0.00000018",
  "0.000000182", "0.0000001875", "0.000000195", "0.0000002", "0.000000201",
  "0.00000021", "0.0000002156", "0.000000225", "0.00000023", "0.00000024",
  "0.00000025", "0.000000255", "0.0000002574", "0.000000259", "0.00000026",
  "0.00000027", "0.00000028", "0.00000029", "0.000000294", "0.000000295",
  "0.0000003", "0.000000304", "0.00000032", "0.000000325", "0.00000033",
  "0.000000336", "0.00000035", "0.000000351", "0.00000036", "0.00000037",
  "0.000000375", "0.0000004", "0.00000041", "0.000000435", "0.00000045",
  "0.00000047", "0.0000005", "0.000000528", "0.00000055", "0.000000555",
  "0.00000057", "0.000000576", "0.00000059", "0.0000006", "0.00000062",
  "0.000000625", "0.00000064", "0.0000006468", "0.00000065", "0.0000006525",
  "0.00000066", "0.0000006712", "0.00000068", "0.0000007", "0.0000007047",
  "0.00000075", "0.00000078", "0.00000079", "0.0000008", "0.000000825",
  "0.000000834", "0.00000085", "0.00000087", "0.000000875", "0.0000009",
  "0.00000095", "0.00000095526", "0.000000966", "0.000000975", "0.000001",
  "0.00000102", "0.0000010287", "0.0000011", "0.000001125", "0.00000114",
  "0.00000115", "0.0000012", "0.00000125", "0.00000128", "0.0000014",
  "0.000001475", "0.0000015", "0.00000156", "0.0000016", "0.00000175",
  "0.0000018", "0.000001875", "0.0000019", "0.00000191052", "0.00000195",
  "0.00000198", "0.000002", "0.00000208", "0.00000209", "0.00000215",
  "0.0000022", "0.00000225", "0.00000228", "0.0000023", "0.0000024",
  "0.00000242", "0.0000025", "0.000002501", "0.0000026", "0.0000027",
  "0.0000028", "0.000003", "0.000003036", "0.0000032", "0.00000335",
  "0.00000341", "0.0000035", "0.0000036", "0.00000375", "0.000004",
  "0.00000405", "0.000004125", "0.00000425", "0.00000435", "0.0000044",
  "0.000004425", "0.0000045", "0.0000048", "0.000005", "0.000006",
  "0.000007", "0.0000075", "0.000008", "0.0000087", "0.0000088",
  "0.000009", "0.00001", "0.0000105", "0.0000114", "0.000011588",
  "0.000012", "0.0000125", "0.000014", "0.000015", "0.00002",
  "0.000021", "0.000025", "0.000028", "0.00003", "0.0000375",
  "0.00005", "0.00006", "0.000075", "0.00008", "0.000084",
  "0.00009", "0.00012", "0.00015", "0.000168", "0.00018",
  "0.0006",
];

test("perMillion returns the decimal the catalog states, not the binary product", () => {
  // The exact decimals these live strings denote. Hardcoded so this test pins
  // the expected values themselves, not just the string-shift helper.
  assert.equal(perMillion("0.00000057"), 0.57);
  assert.equal(perMillion("0.0000002"), 0.2);
  assert.equal(perMillion("0.00000228"), 2.28);
  assert.equal(perMillion("0.00000198"), 1.98);
  assert.equal(perMillion("0.000000825"), 0.825);
  assert.equal(perMillion("0.00000215"), 2.15);
  assert.equal(perMillion("0.00000114"), 1.14);
  assert.equal(perMillion("0.000000304"), 0.304);
  assert.equal(perMillion("0.000000294"), 0.294);
  assert.equal(perMillion("0.000000177"), 0.177);
  assert.equal(perMillion("0.0000000605"), 0.0605);

  // The raw products are what the app used to carry, and they are not those
  // decimals. Stated so a future "simplification" back to `n * 1e6` fails here.
  assert.notEqual(0.00000057 * 1_000_000, 0.57);
  assert.notEqual(0.00000228 * 1_000_000, 2.28);
  assert.ok(0.00000057 * 1_000_000 > 0.57, "the raw product is inflated above the stated decimal");
});

test("every distinct price string in the live catalog converts to its exact decimal", () => {
  assert.equal(LIVE_PRICE_STRINGS.length, 201, "the live catalog carried 201 distinct price strings besides the -1 sentinel");
  for (const s of LIVE_PRICE_STRINGS) {
    const expected = Number(shiftDecimal(s, 6));
    assert.equal(
      String(perMillion(s)),
      String(expected),
      `${s} per token must convert to exactly ${shiftDecimal(s, 6)} per million`
    );
  }
});

test("the conversion stays exact across magnitudes, not just the live ones", () => {
  // The catalog's own range is $0.01386 to $600 per million; this walks a wider
  // one so the rule is not tuned to today's numbers.
  let checked = 0;
  for (let zeros = 0; zeros <= 12; zeros++) {
    for (let mantissa = 1; mantissa <= 999; mantissa++) {
      const s = "0." + "0".repeat(zeros) + mantissa;
      assert.equal(
        String(perMillion(s)),
        String(Number(shiftDecimal(s, 6))),
        `${s} per token must convert to exactly ${shiftDecimal(s, 6)} per million`
      );
      checked++;
    }
  }
  assert.equal(checked, 13 * 999);
});

test("perMillion still treats missing, blank, unparseable and negative prices as unknown", () => {
  // The existing contract, unchanged by the rounding: a negative number is
  // OpenRouter's "variable price" sentinel, not a real price.
  assert.equal(perMillion(undefined), null);
  assert.equal(perMillion(null), null);
  assert.equal(perMillion(""), null);
  assert.equal(perMillion("   "), null);
  assert.equal(perMillion("abc"), null);
  assert.equal(perMillion("-1"), null);
  assert.equal(perMillion("-0.0001"), null);
  assert.equal(perMillion(Number.NaN), null);
  assert.equal(perMillion(Number.POSITIVE_INFINITY), null);
  // Zero must stay exactly zero: `isTrulyFree` and the free-only ceiling both
  // test it with `===`, so a rounded-away zero would make every model paid.
  assert.equal(perMillion("0"), 0);
  assert.equal(perMillion(0), 0);
  assert.equal(Object.is(perMillion("0"), 0), true);
});

test("a price ceiling equal to a model's own price admits that model", () => {
  // The defect, at the level the user meets it. Each ceiling below is the
  // decimal the catalog states for that model, typed into "Max prompt price";
  // before the fix every one of these models was silently dropped.
  const ceilingOf = {
    "0.00000057": 0.57,
    "0.00000228": 2.28,
    "0.00000198": 1.98,
    "0.000000825": 0.825,
    "0.00000215": 2.15,
    "0.00000114": 1.14,
    "0.000000304": 0.304,
    "0.000000294": 0.294,
    "0.000000177": 0.177,
    "0.0000000605": 0.0605,
  };

  for (const [perToken, ceiling] of Object.entries(ceilingOf)) {
    const merged = mergeModelsWithBenchmarks(
      [
        {
          id: "acme/at-the-ceiling",
          canonical_slug: "acme/at-the-ceiling-20260101",
          name: "At the ceiling",
          context_length: 128000,
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          pricing: { prompt: perToken, completion: "0.000001" },
          supported_parameters: [],
        },
        {
          id: "acme/over-the-ceiling",
          canonical_slug: "acme/over-the-ceiling-20260101",
          name: "Over the ceiling",
          context_length: 128000,
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          pricing: { prompt: "0.00001", completion: "0.000001" },
          supported_parameters: [],
        },
      ],
      [],
      []
    );

    const kept = filterByPriceCeiling(merged, ceiling, null).map((c) => c.id);
    assert.deepEqual(
      kept,
      ["acme/at-the-ceiling"],
      `a ceiling of $${ceiling}/M must admit the model priced at exactly $${ceiling}/M`
    );
  }
});

test("a model priced at the ceiling still appears in the results the ceiling filtered", () => {
  // The same thing one layer up: the row the table would have rendered as
  // "$0.57" is the row the ceiling must not have thrown away.
  const merged = mergeModelsWithBenchmarks(
    [
      {
        id: "moonshotai/kimi-k2",
        canonical_slug: "moonshotai/kimi-k2-20260101",
        name: "MoonshotAI: Kimi K2",
        context_length: 128000,
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        pricing: { prompt: "0.00000057", completion: "0.0000023" },
        supported_parameters: [],
      },
    ],
    [],
    []
  );
  const kept = filterByPriceCeiling(merged, 0.57, null);
  assert.equal(kept.length, 1);
  // ...and the price the row carries is the price the table prints.
  assert.equal(kept[0].pricing.promptPerM.toFixed(2), "0.57");
});

test("the comparison panel and its exports carry the clean price, not float noise", () => {
  // `publicModel` whitelists whatever the merged candidate carries, and the
  // panel renders it with `String(...)` while the CSV writes it verbatim, so a
  // noisy conversion reached the user's screen and their exported file.
  const merged = mergeModelsWithBenchmarks(
    [
      {
        id: "acme/two-tenths",
        canonical_slug: "acme/two-tenths-20260101",
        name: "Two Tenths",
        context_length: 128000,
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        pricing: { prompt: "0.0000002", completion: "0.0000015" },
        supported_parameters: [],
      },
      {
        id: "acme/kimi",
        canonical_slug: "acme/kimi-20260101",
        name: "Kimi",
        context_length: 128000,
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        pricing: { prompt: "0.00000057", completion: "0.0000023" },
        supported_parameters: [],
      },
    ],
    [],
    []
  );

  const doc = comparison(merged, { presetId: "coding", qualityPreference: "quality" });
  assert.equal(String(doc.models[0].pricing.promptPerM), "0.2");
  assert.equal(String(doc.models[0].pricing.completionPerM), "1.5");
  assert.equal(String(doc.models[1].pricing.promptPerM), "0.57");
  assert.equal(String(doc.models[1].pricing.completionPerM), "2.3");

  const csv = comparisonCSV(doc);
  assert.match(csv, /"0\.2","1\.5"/);
  assert.match(csv, /"0\.57","2\.3"/);
  assert.doesNotMatch(csv, /19999999999999998|5700000000000001|22999999999999998/);

  // The JSON export is `JSON.stringify(doc)`, so it inherits the same numbers.
  const json = JSON.stringify(doc);
  assert.doesNotMatch(json, /19999999999999998|5700000000000001/);
  assert.match(json, /"promptPerM":0\.2/);
});
