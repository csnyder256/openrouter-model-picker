// The results table is the app's primary user-visible surface for price, so the
// formatting rule that matters -- "$0.00" is a claim of free, and a nonzero
// price must never be shown as it -- is pinned here against the real `app.js`
// `renderTable`, not just against the pure formatter in `tests/match.test.js`.
//
// The case that motivates the file: `~deepseek/deepseek-flash-latest` declares
// a prompt price of $0.0038/M and a completion price of $0.60/M (live
// /api/v1/models, 2026-10-10, 458 models). `toFixed(2)` renders the prompt side
// as "$0.00", so the row read as if its input were free. It is not.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeDom, makeFetchStub, modelsPayload, judgePayload, FREE_MODEL, drain, startApp } from "./dom-harness.mjs";

const dom = makeDom();
const net = makeFetchStub();
await startApp({ document: dom.document, localStorage: dom.localStorage, fetch: net.fetch });

const el = dom.elements;

function resetPage() {
  el["api-key"].value = "sk-test-key";
  el["task-desc"].value = "Write, complete, or generate code.";
  el["task-preset"].value = "coding";
  el["quality-pref"].value = "quality";
  // A paid search: no ceiling, so the tiny-price model is a candidate.
  el["free-only"].checked = false;
  el["max-prompt"].value = "";
  el["max-completion"].value = "";
  el["query-status"].textContent = "";
  el["query-status"].classList.remove("err");
  el["rec-panel"].hidden = true;
  el["results-panel"].hidden = true;
  el["results-count"].textContent = "";
  el["find-models"].disabled = false;
  el["stop-models"].hidden = true;
  el.tbody.innerHTML = "";
  el.tbody.children.length = 0;
  net.requests.length = 0;
  net.actions.length = 0;
}

async function waitForPending(label, turns = 50) {
  for (let i = 0; i < turns; i++) {
    if (net.pendingCount(label) > 0) return;
    await drain(1);
  }
  assert.fail(`no ${label} request was in flight; asked for: ${net.urls().join(", ")}`);
}

// Run a full search to completion, returning the rendered rows.
async function runToTable() {
  const run = el["find-models"].click();
  await waitForPending("models");
  net.resolve("models", modelsPayload([
    { id: "~deepseek/deepseek-flash-latest", name: "DeepSeek: DeepSeek Flash Latest", ctx: 1048576, promptPrice: "0.0000000038", completionPrice: "0.0000006" },
    FREE_MODEL,
  ]));
  net.resolve("bench", { data: [] });
  await waitForPending("judge");
  net.resolve("judge", judgePayload("verdict"));
  await run;
  await drain(4);
  return el.tbody.children;
}

function rowFor(rows, needle) {
  const row = rows.find((r) => r.innerHTML.includes(needle));
  assert.ok(row, `a row containing "${needle}" was rendered`);
  return row;
}

test("a nonzero price below half a cent renders as its real price, never $0.00", async () => {
  resetPage();
  const rows = await runToTable();
  assert.equal(rows.length, 2, "both models rendered a row");

  const tiny = rowFor(rows, "deepseek");
  assert.match(tiny.innerHTML, /\$0\.0038/, "the prompt column shows $0.0038, not $0.00");
  assert.match(tiny.innerHTML, /\$0\.60/, "the completion column is unchanged");
  // "$0.00" must not appear as a standalone price anywhere in this row.
  assert.doesNotMatch(tiny.innerHTML, /\$0\.00(?!\d)/, "no column claims this paid model's input is free");
});

test("a genuinely free model still renders $0.00 with the free badge", async () => {
  resetPage();
  const rows = await runToTable();
  const free = rowFor(rows, "acme/judge");
  assert.match(free.innerHTML, /\$0\.00/, "a real zero is still shown as $0.00");
  assert.match(free.innerHTML, /free-badge/);
});
