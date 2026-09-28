// The headless DOM the app-wiring tests drive. This is deliberately small and
// deliberately dumb: the point is to run the REAL `app.js` (and the real
// `lib/or-client.js` fetch plumbing) against a page whose nodes are inspectable
// and whose network is a promise the test decides when to settle.
//
// It is not a browser and does not pretend to be one. Nothing here simulates
// layout, events beyond the two listeners the app registers, or a renderer. If
// a test needs a browser, it is the wrong test for this file.

// A DOM element with just enough surface for the app: text/HTML, classList,
// hidden/disabled, a listener registry, and an optional set of preset
// `querySelectorAll` results. No parents, no styles, no layout.
export class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
      toString: () => [...this.classList._set].join(" "),
    };
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    // Preset results for `querySelectorAll`, for the one table-header case.
    this.allResults = [];
    this._text = "";
    this._html = "";
  }

  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }

  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  querySelectorAll() { return this.allResults; }
  querySelector(selector) {
    if (selector === "#results-table tbody") return this.tbody || null;
    if (selector === "#results-table thead") return this.thead || null;
    return null;
  }
  closest() { return null; }

  // Fire the handlers the app registered, exactly as a browser would: the
  // dispatch returns as soon as the listeners have been invoked, and the async
  // work they kicked off settles later, when its promises do. Awaiting the
  // handler here would deadlock every test that settles a request afterwards,
  // because the handler is waiting on that same request.
  click() {
    for (const fn of this.listeners.get("click") || []) fn({ target: this });
    return Promise.resolve();
  }
}

// Every id `app.js` looks up. A missing one is a `null` in its `el` map, which
// the app is written to survive (the Stop button is guarded with `if`), but a
// test that needs one should fail loudly rather than silently measure nothing.
export const ELEMENT_IDS = [
  "api-key", "key-status", "forget-key", "task-preset", "task-desc", "free-only",
  "max-prompt", "max-completion", "quality-pref", "find-models", "stop-models",
  "query-status", "rec-panel", "recommendation", "results-panel", "results-count",
];

export function makeDom() {
  const elements = {};
  for (const id of ELEMENT_IDS) elements[id] = new FakeElement();
  elements.tbody = new FakeElement("tbody");
  elements.thead = new FakeElement("thead");

  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: (selector) => (selector === "#results-table tbody"
      ? elements.tbody
      : selector === "#results-table thead" ? elements.thead : null),
    createElement: (tag) => new FakeElement(tag),
    addEventListener: () => {},
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  return { elements, document, localStorage };
}

const scriptModules = new Map();
const cssModules = new Map();

/**
 * A `fetch` replacement whose responses are promises the test settles by hand.
 *
 * `requests` records every call in order with its label ("models", "bench" or
 * "judge") and the signal it was handed, so a test can assert what was asked
 * for and when. `resolve(label, payload)` settles every still-open request
 * carrying that label and returns how many it settled -- which is how a test
 * proves a request was NOT in flight, rather than guessing.
 *
 * A request whose signal is already aborted rejects immediately with an
 * `AbortError`, which is what a real fetch does; a request that is settled by
 * the test after its signal aborted still resolves, which is the transport
 * behaviour this whole file exists to survive.
 */
export function makeFetchStub() {
  const requests = [];
  const actions = [];
  let open = [];

  const labelFor = (url) => {
    const u = String(url);
    if (u.includes("/chat/completions")) return "judge";
    if (u.includes("/benchmarks")) return "bench";
    return "models";
  };

  const fetchStub = (url, init = {}) => {
    const label = labelFor(url);
    const signal = init.signal;
    actions.push({ label, signal, url: String(url) });
    const request = { label, signal, url: String(url) };
    requests.push(request);

    if (signal && signal.aborted) {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      return Promise.reject(err);
    }

    return new Promise((resolve) => {
      const entry = {
        label,
        resolve: (payload) => {
          request.settled = true;
          open = open.filter((o) => o !== entry);
          resolve({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
        },
      };
      open.push(entry);
      request.settle = entry.resolve;
    });
  };

  return {
    fetch: fetchStub,
    requests,
    actions,
    openRequests: () => open.slice(),
    pendingCount: (label) => open.filter((o) => o.label === label).length,
    // Settle every open request with this label; returns how many were settled.
    resolve(label, payload) {
      const targets = open.filter((o) => o.label === label);
      for (const target of targets) target.resolve(payload);
      return targets.length;
    },
    urls: () => actions.map((a) => a.url),
  };
}

/** A `/models` response body. `defs` are `{ id, ctx, out, params }`. */
export function modelsPayload(defs) {
  return {
    data: defs.map((d) => ({
      id: d.id,
      name: d.name ?? d.id,
      context_length: d.ctx ?? 128000,
      architecture: {
        input_modalities: d.in ?? ["text"],
        output_modalities: d.out ?? ["text"],
      },
      pricing: { prompt: d.promptPrice ?? "0", completion: d.completionPrice ?? "0" },
      supported_parameters: d.params ?? [],
    })),
  };
}

/** A `/chat/completions` response body carrying one message. */
export function judgePayload(text) {
  return { choices: [{ message: { content: text } }] };
}

// A free text-output model, which is what the judge's fallback ladder ranks.
export const FREE_MODEL = { id: "acme/judge:free", params: ["reasoning"] };

/** Flush pending microtasks (and one macrotask turn) so awaited work settles. */
export async function drain(turns = 25) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Import the real `app.js` with a global document/localStorage/fetch.
 *
 * Node's loader is not available inside a `node:vm` context, but `app.js` needs
 * nothing from Node: it is browser ESM importing two local modules. Assigning
 * the globals and importing by URL runs the app's real module graph, real
 * imports, real listeners -- the wiring under test is not simulated.
 *
 * `appPath` is passed explicitly so a test can point at the working tree's file
 * rather than whatever the loader resolves first.
 */
export async function startApp({ document, localStorage, fetch }) {
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.fetch = fetch;
  return import(new URL("../app.js", import.meta.url).href);
}

export { scriptModules, cssModules };
