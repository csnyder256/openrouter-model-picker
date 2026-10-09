// Regression tests for the free-model judge ladder, driving the real `app.js`.
//
// `runJudge` walks the ranked free models until one *answers*. The failure this
// file exists for: a judge call that returned HTTP 200 with no usable prose was
// returned as the recommendation anyway, so the ladder stopped on exactly the
// free model that failed and the user saw the placeholder "(empty response)"
// where the verdict should be. A 200 is not an answer; the ladder must advance
// to the next free model, the same way it already advances past a 429 or a 403.
//
// These import the real app (real click handler, real `lib/match.js`, real
// `lib/or-client.js`) against a headless DOM whose `fetch` is a promise the
// test settles by hand.
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

// Two free text judges. FREE_MODEL declares reasoning support, so the ladder
// ranks it first; the backup is the rung it should fall through to.
const BACKUP_JUDGE = { id: "acme/backup:free", ctx: 64000 };

async function runUntilJudge() {
  const run = el["find-models"].click();
  await waitForPending("models");
  net.resolve("models", modelsPayload([FREE_MODEL, BACKUP_JUDGE]));
  net.resolve("bench", { data: [] });
  await waitForPending("judge");
  return run;
}

test("an empty judge response is not an answer: the ladder asks the next free model", async () => {
  resetPage();
  const run = await runUntilJudge();

  // The highest-ranked free judge answers 200 with an empty message.
  net.resolve("judge", judgePayload(""));

  // The app must treat that as a failed attempt and issue another judge call.
  await waitForPending("judge");
  net.resolve("judge", judgePayload("**Use acme/backup:free.** It actually answered."));
  await run;
  await drain(4);

  assert.equal(el["rec-panel"].hidden, false, "the verdict panel is shown once a judge really answers");
  assert.match(el["recommendation"].innerHTML, /Use acme\/backup:free/);
  assert.doesNotMatch(el["recommendation"].innerHTML, /empty response/, "the placeholder must never be the verdict");
  assert.match(el["recommendation"].innerHTML, /Judged by acme\/backup:free/);
  assert.match(el["recommendation"].innerHTML, /after 1 unavailable free model/);
  assert.equal(el["query-status"].classList.contains("err"), false, "a recovered ladder is not an error");
});

test("a 200 body carrying an error instead of a choice also advances the ladder", async () => {
  resetPage();
  const run = await runUntilJudge();

  net.resolve("judge", { error: { message: "upstream provider unavailable" } });
  await waitForPending("judge");
  net.resolve("judge", judgePayload("REAL-VERDICT"));
  await run;
  await drain(4);

  assert.match(el["recommendation"].innerHTML, /REAL-VERDICT/);
  assert.doesNotMatch(el["recommendation"].innerHTML, /upstream provider unavailable/, "a failed rung's error is not shown as the verdict");
  assert.equal(el["query-status"].classList.contains("err"), false);
});
