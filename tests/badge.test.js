
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeModelsWithBenchmarks } from "../lib/match.js";
import { escapeHtml } from "../lib/markdown-lite.js";

// renderTable is not exported (app.js is a browser entry that touches the DOM
// at import time), so this reproduces its badge decision exactly as shipped and
// asserts the property that matters: a model that bills per artifact must never
// render the "free" badge, whatever its token price says.
function badgeFor(c) {
  return c.isFree
    ? '<span class="free-badge">free</span>'
    : c.outOfBandPricing
      ? '<span class="metered-badge" title="Token price is $0, but this model bills per use. See its description.">metered</span>'
      : "";
}

function mergedFrom(model) {
  return mergeModelsWithBenchmarks([model], [], [])[0];
}

test("a $0-per-token model billed per clip renders the metered badge, never the free badge", () => {
  const c = mergedFrom({
    id: "google/lyria-3-clip-preview",
    canonical_slug: "google/lyria-3-clip-preview",
    name: "Google: Lyria 3 Clip Preview",
    description: "30 second duration clips are priced at $0.04 per clip.",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "audio"] },
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: [],
  });
  const badge = badgeFor(c);
  assert.match(badge, /metered-badge/);
  assert.doesNotMatch(badge, /free-badge/);

  // ...and the shipped cell markup, with the real escapeHtml, agrees.
  const cell = `<td class="model">${escapeHtml(c.name)}${badge}<span class="id">${escapeHtml(c.id)}</span></td>`;
  assert.match(cell, /metered/);
  assert.doesNotMatch(cell, /class="free-badge"/);
});

test("a genuinely free model still renders the free badge", () => {
  const c = mergedFrom({
    id: "openrouter/free",
    canonical_slug: "openrouter/free",
    name: "Free Models Router",
    description: "The simplest way to get free inference.",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: [],
  });
  assert.match(badgeFor(c), /free-badge/);
});

test("a paid model renders no badge at all", () => {
  const c = mergedFrom({
    id: "acme/paid",
    canonical_slug: "acme/paid",
    name: "Paid",
    description: "Costs money per token.",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000002", completion: "0.000002" },
    supported_parameters: [],
  });
  assert.equal(badgeFor(c), "");
});
