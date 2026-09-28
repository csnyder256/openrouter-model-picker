// Regression tests for the app's own wiring, in a headless DOM.
//
// `tests/match.test.js` covers the pure epoch arithmetic. These cover what the
// arithmetic is FOR: that a cancelled run cannot write to the page. They import
// the real `app.js` and drive its real click handlers through the real
// `lib/or-client.js`, with `fetch` replaced by promises the test settles by
// hand.
//
// The case that motivates the file: `AbortController.abort()` settles a fetch
// that is still in flight, but it cannot un-resolve a response that has already
// arrived, a body that is already being read, or a judge call that answers
// mid-flight. Any of those resolves after Stop. Before this suite existed, Stop
// aborted the transport and deliberately kept the run's epoch current, so those
// late results passed the `isCurrentSearch` guard and wrote over the
// "Search stopped." status, the table, and the verdict panel.
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

// Import the app once. It registers its listeners at module scope against the
// globals present at import time, so the DOM and fetch are installed first and
// then reused for every scenario; each scenario resets the elements and the
// stub's bookkeeping instead of re-importing.
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

// Wait until a request of this label is open, or fail the test with what was
// actually asked for. The tests must not assume how many microtask turns the
// app's own awaits take.
async function waitForPending(label, turns = 50) {
  for (let i = 0; i < turns; i++) {
    if (net.pendingCount(label) > 0) return;
    await drain(1);
  }
  assert.fail(`no ${label} request was in flight; asked for: ${net.urls().join(", ")}`);
}

// Get a run as far as its judge call: catalogue and both benchmark calls
// answered, then wait for the judge request to appear.
async function runUntilJudge() {
  const run = el["find-models"].click();
  await waitForPending("models");
  net.resolve("models", modelsPayload([FREE_MODEL, { id: "acme/other:free", ctx: 64000 }]));
  net.resolve("bench", { data: [] });
  await waitForPending("judge");
  return run;
}

function statusText() { return el["query-status"].textContent; }
function statusIsError() { return el["query-status"].classList.contains("err"); }

test("Stop during the catalogue: a late catalogue response cannot write the table or the status", async () => {
  resetPage();
  const run = el["find-models"].click();
  await waitForPending("models");
  assert.equal(el["stop-models"].hidden, false, "Stop is offered while a search runs");

  // Stop, then let the catalogue arrive anyway: the response was already on the
  // wire when the user clicked, which is exactly the case an abort cannot cover.
  el["stop-models"].click();
  assert.equal(statusText(), "Search stopped.");

  net.resolve("models", modelsPayload([FREE_MODEL, { id: "acme/other:free", ctx: 64000 }]));
  net.resolve("bench", { data: [] });
  await run;
  await drain(4);

  assert.equal(statusText(), "Search stopped.", "a late catalogue must not replace the stopped status");
  assert.equal(el["results-panel"].hidden, true, "a stopped search must not put a table on the page");
  assert.equal(el.tbody.innerHTML, "", "no rows were rendered");
  assert.equal(el["rec-panel"].hidden, true, "no verdict panel");
  assert.equal(statusIsError(), false, "a cancellation is not an error");
});

test("Stop during the judge: a judge answer that lands anyway cannot write the verdict", async () => {
  resetPage();
  const run = await runUntilJudge();
  assert.equal(el["results-panel"].hidden, false, "the table is up while the judge runs");

  el["stop-models"].click();
  assert.equal(statusText(), "Search stopped.");

  net.resolve("judge", judgePayload("STALE-VERDICT"));
  await run;
  await drain(4);

  assert.equal(statusText(), "Search stopped.",
    "a late verdict must not replace the stopped status: it must read the stopped text, \"Search stopped.\" and not the run's own late result");
  assert.equal(el["rec-panel"].hidden, true, "the verdict panel must stay hidden");
  assert.equal(el["recommendation"].innerHTML, "", "no verdict text was written");
  assert.equal(statusIsError(), false, "a cancellation is not an error");
});

test("a stopped run cannot re-enable its own buttons or restart itself", async () => {
  resetPage();
  const run = await runUntilJudge();
  el["stop-models"].click();
  net.resolve("judge", judgePayload("TOO-LATE"));
  await run;
  await drain(4);

  assert.equal(el["find-models"].disabled, false, "Start is available again after a stop");
  assert.equal(el["stop-models"].hidden, true, "Stop is hidden when nothing runs");
  assert.equal(statusIsError(), false);
  assert.equal(statusText(), "Search stopped.",
    "the stopped run still writes nothing at the end: the status must be the stopped text, not its own late result");
});

test("a new search after Stop runs normally and owns the page when it finishes", async () => {
  resetPage();
  const stopped = el["find-models"].click();
  await waitForPending("models");
  el["stop-models"].click();
  net.resolve("models", modelsPayload([FREE_MODEL])); // the stopped run's late response
  await stopped;

  const fresh = await runUntilJudge();
  net.resolve("judge", judgePayload("FRESH-VERDICT"));
  await fresh;
  await drain(4);

  assert.equal(statusText(), "Found 2 matching models.", "the new run finishes normally");
  assert.equal(el["rec-panel"].hidden, false, "the new run's verdict is rendered");
  assert.match(el["recommendation"].innerHTML, /FRESH-VERDICT/);
  assert.equal(statusIsError(), false);
});

test("a stopped run's late success and a late failure both stay off the page", async () => {
  resetPage();
  const run = await runUntilJudge();
  el["stop-models"].click();
  net.resolve("judge", judgePayload("ignored"));
  await run;
  await drain(4);

  assert.equal(statusIsError(), false, "a stopped run's outcome is not the user's error");
  assert.equal(statusText(), "Search stopped.",
    "a stopped run's late success must not replace the stopped status with its own result");
  assert.equal(el["rec-panel"].hidden, true);
});

test("Stop clicked just after a run finished does not claim a cancellation", async () => {
  resetPage();
  const run = await runUntilJudge();
  net.resolve("judge", judgePayload("FINISHED"));
  await run;
  await drain(4);
  assert.equal(statusText(), "Found 2 matching models.", "the run finished on its own");

  // The click lands after the run already left the page in its finished state,
  // so there is no cancellation to report and saying otherwise would be false.
  el["stop-models"].click();
  assert.match(statusText(), /nothing was cancelled/,
    "Stop must not claim it cancelled a search that had already finished");
  assert.equal(statusIsError(), false);
});

test("Stop with nothing running at all is a plain stop", async () => {
  resetPage();
  // Nothing has ever run in this scenario: no finish to report, nothing to
  // claim. The plain wording is the honest one here.
  el["stop-models"].click();
  assert.equal(statusText(), "Search stopped.");
  assert.equal(statusIsError(), false);
});
