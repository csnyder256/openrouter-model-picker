// Regression tests for the comparison panel's own wiring.
//
// `tests/match.test.js` and `test/comparisons.test.js` cover the pure logic;
// neither drives `lib/comparisons-ui.js`, which is where the panel's controls
// are bound. The panel is the newest part of the product (v1.1.0) and the one
// place where a *second* set of preferences exists: the picker has "Task
// preset" / "Optimize for", and the panel has its own "Explain for task" /
// "Ranking". Those two must not fight.
//
// The case that motivates the file: `addControl` re-seeded the comparison from
// the picker on every checkbox toggle, so a user who set the panel's ranking to
// Cheapest and then ticked one more model watched it snap back to the picker's
// "Optimize for". The panel's controls are its own; only a brand new comparison
// is seeded from the picker.
//
// `initComparisons` reads `document`/`window`/`location` at call time (not at
// import time), so a small hand-built DOM is installed as globals first. This
// is deliberately not the app harness: it drives one module, not the whole app.
import { test } from "node:test";
import assert from "node:assert/strict";

import { initComparisons } from "../lib/comparisons-ui.js";
import { TASK_PRESETS, findPreset } from "../lib/match.js";

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._listeners = new Map();
    this._text = "";
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !this.classList._set.has(c) : Boolean(on);
        want ? this.classList._set.add(c) : this.classList._set.delete(c);
        return want;
      },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  appendChild(node) { this.children.push(node); return node; }
  cloneNode() {
    const copy = new FakeElement(this.tagName);
    copy.value = this.value; copy._text = this._text; copy.className = this.className;
    return copy;
  }
  setAttribute(key, value) { if (key === "aria-label") this.ariaLabel = value; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatchEvent(event) { for (const fn of this._listeners.get(event.type) || []) fn(event); return true; }
  click() { return this.dispatchEvent({ type: "click" }); }
  focus() {} select() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const PANEL_IDS = [
  "comparison-content", "comparison-status", "shortlist-name", "saved-shortlists", "comparison-link",
  "comparison-preset", "comparison-mode", "comparison-demo", "comparison-clear", "comparison-share",
  "comparison-json", "comparison-csv", "comparison-print", "shortlist-save", "shortlist-rename",
  "shortlist-delete", "comparison-import",
];

function buildEnvironment() {
  const bySelector = new Map();
  for (const id of PANEL_IDS) bySelector.set("#" + id, new FakeElement("div"));
  const root = new FakeElement("section");
  root.querySelector = (selector) => bySelector.get(selector) || null;
  root.querySelectorAll = () => [];

  const taskPreset = new FakeElement("select");
  taskPreset.options = TASK_PRESETS.map((preset) => {
    const option = new FakeElement("option");
    option.value = preset.id; option._text = preset.label;
    return option;
  });

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const document = {
    getElementById: (id) => (id === "comparison-panel" ? root : null),
    querySelector: (selector) => (selector === "#task-preset" ? taskPreset : null),
    querySelectorAll: () => [],
    createElement: (tag) => new FakeElement(tag),
  };

  return { root, bySelector, document, window: { localStorage, addEventListener() {} }, location: { hash: "" }, history: { replaceState() {} } };
}

// The picker's own settings, which the panel must NOT re-impose on an existing
// comparison. Deliberately different from the panel values used below.
const readPreferences = () => ({
  preset: findPreset("coding"),
  taskDescription: "Write code.",
  maxPromptPerM: 0,
  maxCompletionPerM: 0,
  qualityPreference: "quality",
});

function installEnvironment() {
  const env = buildEnvironment();
  globalThis.document = env.document;
  globalThis.window = env.window;
  globalThis.location = env.location;
  globalThis.history = env.history;
  return env;
}

const MODELS = [
  { id: "acme/one:free", name: "One", contextLength: 1000, pricing: { promptPerM: 0, completionPerM: 0 }, benchmarks: { codingIndex: 90, intelligenceIndex: 80 } },
  { id: "acme/two:free", name: "Two", contextLength: 2000, pricing: { promptPerM: 0, completionPerM: 0 }, benchmarks: { codingIndex: 70, intelligenceIndex: 60 } },
];

// Drive the real control the results table gets, exactly as `renderTable` does.
function toggleModel(api, model) {
  const row = new FakeElement("tr");
  api.addControl(row, model);
  const box = row.children[0].children[0];
  box.checked = !box.checked;
  box.dispatchEvent({ type: "change" });
  return box;
}

// Every text node the panel rendered, so a test can read the explanation
// without reaching into a fixed DOM shape.
function allText(element, out = []) {
  for (const child of element.children) {
    if (child._text) out.push(child._text);
    allText(child, out);
  }
  return out;
}

test("the panel's own task preset and ranking survive toggling a model", () => {
  const env = installEnvironment();
  const api = initComparisons(readPreferences);
  const mode = env.bySelector.get("#comparison-mode");
  const preset = env.bySelector.get("#comparison-preset");
  const contents = env.bySelector.get("#comparison-content");

  // The first selection has no comparison yet, so it is seeded from the picker.
  toggleModel(api, MODELS[0]);
  assert.equal(mode.value, "quality", "a fresh comparison starts from the picker's Optimize for");
  assert.equal(preset.value, "coding", "a fresh comparison starts from the picker's task preset");

  // The user now uses the panel's OWN controls.
  mode.value = "cheapest"; mode.dispatchEvent({ type: "change" });
  preset.value = "reasoning-math"; preset.dispatchEvent({ type: "change" });
  assert.match(allText(contents).join(" "), /gpqaAccuracy/, "the panel explains with the preset the user picked");

  // Selecting one more model must not silently undo either choice.
  toggleModel(api, MODELS[1]);
  assert.equal(mode.value, "cheapest", "toggling a model must not revert the panel's ranking");
  assert.equal(preset.value, "reasoning-math", "toggling a model must not revert the panel's task preset");
  assert.match(
    allText(contents).join(" "),
    /gpqaAccuracy/,
    "the rendered ranking still uses the preserved preset, not just the select's value"
  );

  // ...and unchecking one is the same interaction.
  const box = toggleModel(api, MODELS[1]);
  assert.equal(box.checked, false);
  assert.equal(mode.value, "cheapest", "unchecking must not revert the panel's ranking either");
  assert.equal(preset.value, "reasoning-math");
});

test("clearing and starting over seeds a new comparison from the picker again", () => {
  const env = installEnvironment();
  const api = initComparisons(readPreferences);
  const mode = env.bySelector.get("#comparison-mode");
  const preset = env.bySelector.get("#comparison-preset");

  toggleModel(api, MODELS[0]);
  mode.value = "cheapest"; mode.dispatchEvent({ type: "change" });
  preset.value = "reasoning-math"; preset.dispatchEvent({ type: "change" });

  env.bySelector.get("#comparison-clear").click();
  toggleModel(api, MODELS[0]);
  assert.equal(mode.value, "quality", "a cleared panel takes the picker's settings for its next comparison");
  assert.equal(preset.value, "coding");
});
