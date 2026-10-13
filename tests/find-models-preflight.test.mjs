// Regression tests for what a "Find models" click does *before* it is allowed
// to start a search.
//
// The README states the contract this file pins: "Only one search runs at a
// time. Starting a new search supersedes the previous one, so a slower earlier
// search cannot render its table or verdict over a newer one." A click that
// cannot start a search is not a new search, so it must not supersede the run
// that is already going -- and it must not clear the table and verdict the user
// is currently reading.
//
// The defect: `onFindModels` checked the API key *before* it claimed a search
// epoch, but checked the task description *after* claiming one, aborting the
// in-flight run and hiding `#results-panel` / `#rec-panel` on the way. So the
// one click that could never start a search -- Find models with the custom
// preset selected and its description left empty, the only configuration that
// yields no task description at all -- destroyed the page the user was reading
// and killed a search that was still running.
//
// These drive the real `app.js` in the same headless DOM the cancellation suite
// uses, so the ordering under test is the shipped one.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeDom,
  makeFetchStub,
  modelsPayload,
  judgePayload,
  FREE_MODEL,
  drain,
  startApp,
} from "./dom-harness.mjs";

const dom = makeDom();
const net = makeFetchStub();
await startApp({ document: dom.document, localStorage: dom.localStorage, fetch: net.fetch });

const el = dom.elements;

function resetPage() {
  el["api-key"].value = "sk-test-key";
  el["task-desc"].value = "Write, complete, or generate code.";
  el["task-preset"].value = "coding";
  el["quality-pref"].value = "quality";
  el["free-only"].checked = true;
  el["max-prompt"].value = "0";
  el["max-completion"].value = "0";
  el["query-status"].textContent = "";
  el["query-status"].classList.remove("err");
  el["rec-panel"].hidden = true;
  el["recommendation"].innerHTML = "";
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

// Drive a search to completion: catalogue and both benchmark calls answered,
// then the judge, so the page is holding a finished table and verdict.
async function runFinishedSearch(verdict = "VERDICT") {
  const run = el["find-models"].click();
  await waitForPending("models");
  net.resolve("models", modelsPayload([FREE_MODEL, { id: "acme/other:free", ctx: 64000 }]));
  net.resolve("bench", { data: [] });
  await waitForPending("judge");
  net.resolve("judge", judgePayload(verdict));
  await run;
  await drain(4);
}

// The one configuration with no task description at all: the custom preset's
// own hint is a placeholder, so `resolveTaskDescription` refuses to substitute
// it, and the field was left empty.
function chooseCustomWithNoDescription() {
  el["task-preset"].value = "custom";
  el["task-desc"].value = "";
}

function statusText() { return el["query-status"].textContent; }
function statusIsError() { return el["query-status"].classList.contains("err"); }

test("a Find models click that cannot start a search keeps the results on the page", async () => {
  resetPage();
  await runFinishedSearch();
  assert.equal(el["results-panel"].hidden, false, "precondition: a table is on the page");
  assert.equal(el["rec-panel"].hidden, false, "precondition: a verdict is on the page");
  assert.equal(el.tbody.children.length, 2, "precondition: two rows are rendered");

  chooseCustomWithNoDescription();
  const before = net.requests.length;
  await el["find-models"].click();
  await drain(4);

  assert.equal(net.requests.length, before, "a click that cannot start a search starts no request");
  assert.match(statusText(), /Describe the task/, "the click explains why it did nothing");
  assert.equal(statusIsError(), true, "and it is styled as an error, because the click did nothing");
  assert.equal(el["results-panel"].hidden, false,
    "the table the user was reading must survive a click that started no search");
  assert.equal(el["rec-panel"].hidden, false,
    "the verdict the user was reading must survive a click that started no search");
  assert.equal(el.tbody.children.length, 2, "the rows are untouched");
});

test("a Find models click that cannot start a search does not supersede the search already running", async () => {
  resetPage();
  const run = el["find-models"].click();
  await waitForPending("models");
  net.resolve("models", modelsPayload([FREE_MODEL, { id: "acme/other:free", ctx: 64000 }]));
  net.resolve("bench", { data: [] });
  await waitForPending("judge");
  assert.equal(el["stop-models"].hidden, false, "precondition: a search is running and stoppable");

  chooseCustomWithNoDescription();
  const before = net.requests.length;
  await el["find-models"].click();
  await drain(4);
  assert.equal(net.requests.length, before, "the rejected click starts no request of its own");

  // The running search still owns the page: its verdict lands normally, and the
  // status line it writes is not still wearing the rejected click's error.
  net.resolve("judge", judgePayload("STILL-RUNNING-VERDICT"));
  await run;
  await drain(4);

  assert.equal(el["rec-panel"].hidden, false, "the search that was already running still renders its verdict");
  assert.match(el["recommendation"].innerHTML, /STILL-RUNNING-VERDICT/);
  assert.equal(statusText(), "Found 2 matching models.", "the running search's own outcome is the final word");
  assert.equal(statusIsError(), false, "a finished search's status is not styled as an error");
});

test("a Find models click with no API key behaves the same way, on both counts", async () => {
  // The API key was already checked before the epoch was claimed, so this path
  // always behaved. It is pinned here so the two pre-flight checks cannot drift
  // apart again: both must leave the page and the running search alone.
  resetPage();
  await runFinishedSearch();
  el["api-key"].value = "";
  const before = net.requests.length;
  await el["find-models"].click();
  await drain(4);

  assert.equal(net.requests.length, before);
  assert.match(statusText(), /API key/);
  assert.equal(statusIsError(), true);
  assert.equal(el["results-panel"].hidden, false, "the table survives");
  assert.equal(el["rec-panel"].hidden, false, "the verdict survives");
});

test("a Find models click with no API key leaves a running search alone too", async () => {
  resetPage();
  const run = el["find-models"].click();
  await waitForPending("models");
  net.resolve("models", modelsPayload([FREE_MODEL, { id: "acme/other:free", ctx: 64000 }]));
  net.resolve("bench", { data: [] });
  await waitForPending("judge");

  el["api-key"].value = "";
  await el["find-models"].click();
  await drain(4);
  net.resolve("judge", judgePayload("KEYLESS-VERDICT"));
  await run;
  await drain(4);

  assert.match(el["recommendation"].innerHTML, /KEYLESS-VERDICT/,
    "clearing the key and clicking Find must not cancel the search already in flight");
  assert.equal(statusText(), "Found 2 matching models.");
});
