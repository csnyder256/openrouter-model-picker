// The task-preset select and the task-description field.
//
// `lib/match.js` decides what counts as a task description (`resolveTaskDescription`)
// and owns the presets; `lib/task-preset.js` decides what the preset select does
// to the field. Both halves of the bug below are pinned here: the pure rule, and
// the app's real change handler driven through the same headless DOM the
// cancellation suite uses.
import { test } from "node:test";
import assert from "node:assert/strict";

import { TASK_PRESETS, findPreset } from "../lib/match.js";
import { nextTaskDescription } from "../lib/task-preset.js";
import { makeDom, startApp } from "./dom-harness.mjs";

const CODING_HINT = findPreset("coding").hint;
const CUSTOM_HINT = findPreset("custom").hint;

test("nextTaskDescription pre-fills the hint of every non-custom preset", () => {
  // The existing behaviour, preserved exactly: picking a real preset fills the
  // field with that preset's hint, whatever was in the field before.
  for (const preset of TASK_PRESETS) {
    if (preset.id === "custom") continue;
    assert.equal(nextTaskDescription(null, preset.id, ""), preset.hint, preset.id);
    assert.equal(nextTaskDescription("coding", preset.id, "something the user typed"), preset.hint, preset.id);
  }
});

test("switching to the custom preset clears the outgoing preset's hint instead of keeping it as the task", () => {
  // The defect: the field is pre-filled with the outgoing preset's hint, the
  // custom preset's branch only cleared an already-empty field, so the hint
  // survived and every later read treated it as the task the user described --
  // a custom search running the previous preset's task.
  assert.equal(nextTaskDescription("coding", "custom", CODING_HINT), "");
  assert.equal(nextTaskDescription("coding", "custom", `  ${CODING_HINT}  `), "");
  for (const preset of TASK_PRESETS) {
    if (preset.id === "custom") continue;
    assert.equal(nextTaskDescription(preset.id, "custom", preset.hint), "", preset.id);
  }
});

test("switching to the custom preset keeps text the user actually typed", () => {
  const typed = "Translate the release notes into Welsh and keep the tone dry.";
  assert.equal(nextTaskDescription("coding", "custom", typed), typed);
  // A hint the user then edited is the user's text, not the hint any more.
  assert.equal(nextTaskDescription("coding", "custom", CODING_HINT + " For Go."), CODING_HINT + " For Go.");
  // Nothing to clear when the field is already empty.
  assert.equal(nextTaskDescription("coding", "custom", ""), "");
  assert.equal(nextTaskDescription(null, "custom", ""), "");
});

test("the custom preset's own placeholder is never written into the field as a task", () => {
  // `resolveTaskDescription` refuses to substitute the custom hint as a task;
  // putting it in the field instead would defeat that, because a non-empty
  // field is read as the user's own description.
  assert.notEqual(CUSTOM_HINT, "");
  assert.notEqual(nextTaskDescription("coding", "custom", CODING_HINT), CUSTOM_HINT);
  assert.equal(nextTaskDescription("coding", "custom", CODING_HINT), "");
});

test("an unknown preset id leaves the field untouched", () => {
  assert.equal(nextTaskDescription("coding", "not-a-preset", "kept"), "kept");
  assert.equal(nextTaskDescription("not-a-preset", "custom", "kept"), "kept");
});

test("the app's real preset change handler clears a stale hint when the user picks Custom task", async () => {
  const dom = makeDom();
  const elements = dom.elements;
  // `fetch` is never reached: this scenario only changes a select.
  await startApp({
    document: dom.document,
    localStorage: dom.localStorage,
    fetch: () => Promise.reject(new Error("no request expected in this test")),
  });

  const select = elements["task-preset"];
  const desc = elements["task-desc"];
  const handlers = select.listeners.get("change") || [];
  assert.ok(handlers.length, "app.js registered a change handler on the task preset select");
  const changePreset = (id) => {
    select.value = id;
    for (const fn of handlers) fn({ target: select });
  };

  // Fresh load: coding is selected and its hint is pre-filled.
  assert.equal(select.value, "coding");
  assert.equal(desc.value, CODING_HINT);

  // The bug, through the real handler: choose Custom task without editing the
  // field, and the previous preset's hint must not survive as the task.
  changePreset("custom");
  assert.equal(desc.value, "", "a stale preset hint must not remain as the custom task");

  // The user's own text survives the same switch.
  changePreset("coding");
  assert.equal(desc.value, CODING_HINT);
  desc.value = "Summarise this incident report for a non-engineer.";
  changePreset("custom");
  assert.equal(desc.value, "Summarise this incident report for a non-engineer.");

  // A real preset still pre-fills its hint.
  changePreset("translation");
  assert.equal(desc.value, findPreset("translation").hint);
});
