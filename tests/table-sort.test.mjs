// Keyboard and assistive-tech coverage for the results table's sortable
// headers.
//
// Before this suite, the headers were plain `<th>` cells with a click handler:
// a mouse could sort, but a keyboard user could not sort at all, and a screen
// reader got no indication that the columns were sortable or which one was
// active. The shipped markup now makes every sortable header a real `<button>`
// inside a `<th scope="col" aria-sort="…">`, so the browser provides focus and
// Enter/Space activation, and `app.js` keeps `aria-sort` in step with what is
// actually rendered.
//
// These tests drive the real `app.js` against the shared headless DOM: a real
// search populates the table, then a header activation (the exact event the
// delegated `<thead>` handler sees) reorders the rows and updates the sort
// state. The last test pins the shipped markup itself, which is the part a
// behaviour test cannot observe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  makeDom,
  makeFetchStub,
  modelsPayload,
  judgePayload,
  drain,
  startApp,
  FakeElement,
} from "./dom-harness.mjs";

const dom = makeDom();
const net = makeFetchStub();
await startApp({ document: dom.document, localStorage: dom.localStorage, fetch: net.fetch });

const el = dom.elements;

// Build the shipped header shape. `closest` is what the app's delegated
// handler calls on the event target, so a sortable header answers for
// "th[data-key]" and the non-sortable one answers nothing.
function sortableHeader(key) {
  const th = new FakeElement("th");
  th.dataset.key = key;
  th.setAttribute("aria-sort", "none");
  th.closest = (selector) => (selector === "th[data-key]" && th.dataset.key != null ? th : null);
  return th;
}
function plainHeader() {
  const th = new FakeElement("th");
  th.closest = () => null;
  return th;
}

const nameHeader = sortableHeader("name");
const contextHeader = sortableHeader("contextLength");
const intelligenceHeader = sortableHeader("benchmarks.intelligenceIndex");
const compareHeader = plainHeader();

// `querySelectorAll` on the harness element returns this list, so the app's
// "clear the previous sort state" loop sees exactly the sortable headers.
el.thead.allResults = [nameHeader, contextHeader, intelligenceHeader];

// The exact event a real click or key press produces: the delegated handler
// runs on <thead> with the activated element as `target`.
function activateHeader(th) {
  for (const fn of el.thead.listeners.get("click") || []) fn({ target: th });
}

function rowIds() {
  return el.tbody.children.map((tr) => {
    const match = /class="id">([^<]+)</.exec(tr._html || "");
    return match ? match[1] : null;
  });
}

async function waitForPending(label, turns = 50) {
  for (let i = 0; i < turns; i++) {
    if (net.pendingCount(label) > 0) return;
    await drain(1);
  }
  assert.fail(`no ${label} request was in flight; asked for: ${net.urls().join(", ")}`);
}

const MODELS = [
  { id: "acme/alpha:free", name: "Alpha", ctx: 1000 },
  { id: "acme/bravo:free", name: "Bravo", ctx: 3000 },
  { id: "acme/charlie:free", name: "Charlie", ctx: 2000 },
];

async function runSearch() {
  el["api-key"].value = "sk-test-key";
  el["task-preset"].value = "coding";
  el["task-desc"].value = "Write, complete, or generate code.";
  el["quality-pref"].value = "quality";
  el["free-only"].checked = true;
  el["max-prompt"].value = "0";
  el["max-completion"].value = "0";
  el["rec-panel"].hidden = true;
  el["recommendation"].innerHTML = "";
  el["results-panel"].hidden = true;
  el.tbody.children.length = 0;
  el.tbody._html = "";
  for (const header of [nameHeader, contextHeader, intelligenceHeader]) {
    header.classList.remove("sorted");
    header.setAttribute("aria-sort", "none");
  }
  net.requests.length = 0;
  net.actions.length = 0;

  const run = el["find-models"].click();
  await waitForPending("models");
  net.resolve("models", modelsPayload(MODELS));
  net.resolve("bench", { data: [] });
  await waitForPending("judge");
  net.resolve("judge", judgePayload("Verdict text."));
  await run;
  await drain(6);
}

test("a header activation reorders the rows and reports the sort to assistive tech", async () => {
  await runSearch();

  // The default order is the search's own ranking: by the task metric, which is
  // unmeasured here, so it falls back to longest context first.
  assert.deepEqual(rowIds(), ["acme/bravo:free", "acme/charlie:free", "acme/alpha:free"]);

  // First activation of a column sorts descending, and says so.
  activateHeader(nameHeader);
  assert.deepEqual(rowIds(), ["acme/charlie:free", "acme/bravo:free", "acme/alpha:free"]);
  assert.equal(nameHeader.getAttribute("aria-sort"), "descending");
  assert.equal(nameHeader.classList.contains("sorted"), true);

  // Activating the same column again flips to ascending.
  activateHeader(nameHeader);
  assert.deepEqual(rowIds(), ["acme/alpha:free", "acme/bravo:free", "acme/charlie:free"]);
  assert.equal(nameHeader.getAttribute("aria-sort"), "ascending");
});

test("a new column takes the sort and clears the previous column's state", async () => {
  await runSearch();

  activateHeader(nameHeader);
  assert.equal(nameHeader.getAttribute("aria-sort"), "descending");

  activateHeader(contextHeader);
  assert.deepEqual(rowIds(), ["acme/bravo:free", "acme/charlie:free", "acme/alpha:free"]);
  assert.equal(contextHeader.getAttribute("aria-sort"), "descending");
  // The previously sorted column no longer claims to be sorted.
  assert.equal(nameHeader.getAttribute("aria-sort"), "none");
  assert.equal(nameHeader.classList.contains("sorted"), false);

  activateHeader(contextHeader);
  assert.deepEqual(rowIds(), ["acme/alpha:free", "acme/charlie:free", "acme/bravo:free"]);
  assert.equal(contextHeader.getAttribute("aria-sort"), "ascending");
});

test("the non-sortable Compare header is inert", async () => {
  await runSearch();
  const before = rowIds();

  activateHeader(compareHeader);
  assert.deepEqual(rowIds(), before, "an unsortable header must not reorder the table");

  // And it never takes sort state away from a real column.
  activateHeader(contextHeader);
  activateHeader(compareHeader);
  assert.deepEqual(rowIds(), ["acme/bravo:free", "acme/charlie:free", "acme/alpha:free"]);
  assert.equal(contextHeader.getAttribute("aria-sort"), "descending");
});

test("the shipped markup exposes sortable headers as buttons and status lines as live regions", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  const keys = [
    "name",
    "pricing.promptPerM",
    "pricing.completionPerM",
    "contextLength",
    "benchmarks.intelligenceIndex",
    "benchmarks.codingIndex",
    "benchmarks.agenticIndex",
    "benchmarks.gpqaAccuracy",
    "benchmarks.tauBenchAccuracy",
    "benchmarks.searchAvg",
  ];
  for (const key of keys) {
    const escaped = key.replace(/[.]/g, "\\.");
    assert.match(
      html,
      new RegExp(`<th scope="col" data-key="${escaped}"[^>]*aria-sort="none"><button type="button">`),
      `sortable header ${key} must be a scoped column header with aria-sort and a button`
    );
  }

  // The non-sortable first column carries no aria-sort and no button.
  assert.match(html, /<th scope="col">Compare<\/th>/);

  // The dynamic status lines announce their updates.
  assert.match(html, /id="key-status" role="status"/);
  assert.match(html, /id="query-status" role="status"/);
  assert.match(html, /id="results-count" role="status"/);
});
