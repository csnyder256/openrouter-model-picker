// The comparison report, as printed.
//
// `README.md` promises that "Print creates a comparison report". The panel puts
// each model's caveats -- the warnings `explainRanking` returns: an unmeasured
// primary benchmark is not a zero, incomplete token pricing, per-use charges
// excluded from the ranking, the general index being a proxy for the task, and
// the unverified-snapshot notice -- behind a `<details>` disclosure, because six
// rows of warnings is a wall of text on screen. A printed report is the artifact
// the reader keeps, so those caveats have to be *on* it, and a closed
// `<details>` prints shut.
//
// The print stylesheet tried to solve that with `#comparison-panel details > *
// { display:block }`, and that no longer does anything: current engines put
// everything after the `<summary>` in a `::details-content` pseudo-element and
// hide it with `content-visibility: hidden` (Chrome/Edge 131+, Firefox 143+,
// Safari 18.4+), which an author `display` declaration on the children cannot
// override. Measured against this page in Chrome 155 with print media emulated:
// with that rule applied the list's computed display is already `block`, the
// details' own box is exactly its summary's height (20px, with the list's own
// box 61px), and the list is not rendered. `content-visibility: visible` on the
// pseudo-element is what reveals it.
//
// What this file can check without a browser is the *contract*, in two halves:
// that the panel really does render the warnings inside a closed disclosure (so
// the print rule is load-bearing rather than decoration), and that the shipped
// print stylesheet still reveals a closed disclosure by the mechanism that
// works, inside `@media print` only -- the screen keeps the disclosure
// collapsed, which is the whole reason the rule lives in the print block.
// The rendering itself is a browser's business and was verified there; this
// file does not claim to test it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { initComparisons } from "../lib/comparisons-ui.js";
import { findPreset } from "../lib/match.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesheet = readFileSync(join(root, "styles.css"), "utf8");

// The declarations of the `@media print` block, comments removed.
function printBlock(source) {
  const start = source.indexOf("@media print");
  assert.notEqual(start, -1, "styles.css no longer has an @media print block");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i).replace(/\/\*[\s\S]*?\*\//g, "");
    }
  }
  throw new Error("unterminated @media print block");
}

const print = printBlock(stylesheet);
const withoutPrint = stylesheet.slice(0, stylesheet.indexOf("@media print"));

// ---------------------------------------------------------------------------
// The shipped print stylesheet
// ---------------------------------------------------------------------------

test("the print stylesheet reveals a closed disclosure with the mechanism that works", () => {
  // `::details-content { content-visibility: visible }` is the declaration that
  // reveals it; `display` on the children is not, which is what this test pins.
  assert.match(print, /#comparison-panel details::details-content\s*\{[^}]*content-visibility:\s*visible/);
  // The declaration is print-only: on screen the disclosure stays collapsed.
  assert.doesNotMatch(withoutPrint, /details::details-content/);
  assert.doesNotMatch(withoutPrint, /content-visibility:\s*visible/);
});

test("the print stylesheet still carries the display declaration for engines that need it", () => {
  // Kept, not replaced: on an engine that hides a closed details' content with
  // `display`, this is the declaration that works, and it is inert elsewhere.
  assert.match(print, /#comparison-panel details\s*>\s*\*\s*\{[^}]*display:\s*block/);
});

// ---------------------------------------------------------------------------
// The panel's markup, driven for real
//
// `initComparisons` reads `document`/`window`/`location` when it is called, so a
// small fake DOM is installed as globals first. It is a fake and says so: it
// exists to reach `paint()`, which is what builds the disclosures, and it does
// not pretend to be a browser.
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._listeners = new Map();
    this._text = "";
    this._html = "";
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.open = false;
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
      toggle: (c, force) => {
        const want = force === undefined ? !this.classList._set.has(c) : Boolean(force);
        if (want) this.classList._set.add(c); else this.classList._set.delete(c);
        return want;
      },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get options() { return this.children; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.children.push(c); }
  prepend(c) { this.children.unshift(c); }
  replaceChildren(...cs) { this.children = [...cs]; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  fire(type, extra = {}) {
    for (const fn of this._listeners.get(type) || []) fn({ target: this, ...extra });
  }
  setAttribute() {}
  getAttribute() { return null; }
  cloneNode() { return new FakeElement(this.tagName); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  select() {}
}

const PANEL_IDS = [
  "comparison-panel", "comparison-content", "comparison-status", "shortlist-name",
  "saved-shortlists", "comparison-link", "comparison-preset", "comparison-mode",
  "comparison-demo", "comparison-clear", "comparison-share", "comparison-json",
  "comparison-csv", "comparison-print", "shortlist-save", "shortlist-rename",
  "shortlist-delete", "comparison-import", "task-preset",
];

function installPanel() {
  const els = {};
  for (const id of PANEL_IDS) els[id] = new FakeElement();
  const root = els["comparison-panel"];
  root.querySelector = (selector) => {
    const m = /^#([\w-]+)$/.exec(selector);
    return m ? els[m[1]] || null : null;
  };
  root.querySelectorAll = () => [];
  const created = [];
  const document = {
    getElementById: (id) => els[id] || null,
    querySelector: (selector) => {
      const m = /^#([\w-]+)$/.exec(selector);
      return m ? els[m[1]] || null : null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => {
      const el = new FakeElement(tag);
      created.push(el);
      return el;
    },
    addEventListener: () => {},
  };
  const store = new Map();
  const window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    addEventListener: () => {},
  };
  const location = { hash: "", href: "https://example.test/app", pathname: "/app", search: "" };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.history = { replaceState: () => {} };
  // `navigator` and `location` are getter-only on Node's global, so they have to
  // be redefined rather than assigned. `crypto` is deliberately left alone: this
  // test never saves a shortlist.
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });
  Object.defineProperty(globalThis, "location", { value: location, configurable: true });
  globalThis.URL.createObjectURL = () => "blob:test";
  globalThis.URL.revokeObjectURL = () => {};
  return { els, created, root };
}

test("the panel renders each model's warnings inside a closed disclosure", () => {
  const panel = installPanel();
  initComparisons(() => ({
    preset: findPreset("coding"),
    taskDescription: "Write, complete, or generate code.",
    maxPromptPerM: 0,
    maxCompletionPerM: 0,
    qualityPreference: "balanced",
  }));

  // The offline example: fictional models, illustrative values, no network.
  panel.els["comparison-demo"].fire("click");

  const disclosures = panel.created.filter((el) => el.tagName === "DETAILS");
  assert.equal(disclosures.length, 3, "one disclosure per compared model");

  for (const disclosure of disclosures) {
    assert.equal(disclosure.open, false, "the disclosure ships closed: the print rule is what opens it");
    assert.equal(disclosure.children[0].tagName, "SUMMARY");
    assert.match(disclosure.children[0].textContent, /Assumptions and limitations/);
    const list = disclosure.children[1];
    assert.equal(list.tagName, "UL");
    assert.ok(list.children.length > 0, "the disclosure carries the warnings, so losing it loses real content");
  }

  // Every row carries the snapshot caveat, and the disclosure is where it lives.
  const warnings = disclosures.flatMap((d) => d.children[1].children.map((li) => li.textContent));
  assert.ok(warnings.some((w) => /unverified until refreshed against the live catalog/.test(w)),
    "the caveats are inside the disclosure, which is exactly what a printed report must not drop");
});
