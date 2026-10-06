// Direct coverage for `lib/or-client.js`, the thin fetch wrappers every network
// call in the app goes through.
//
// The app-wiring suite (`app-cancellation.test.mjs`) exercises this module, but
// through `dom-harness.mjs`'s fake response, whose `json()` and `text()` are
// independent stubs. A real `Response` shares ONE body stream between them, and
// that difference hid a real defect in the error path: it called `res.json()`
// first and fell back to `res.text()`, but the Fetch API rejects a second read
// of an already-consumed body, so the server's detail came back empty on every
// non-JSON error page -- an nginx 502, a Cloudflare interstitial, a plain-text
// rate-limit notice -- and the status line read "502 Bad Gateway: ". That is
// the vague error the README promises not to show ("the status line names every
// model tried and the last real error").
//
// These tests build real `Response` objects, so the one-shot body semantics are
// the platform's, not a stub's. No network access is made: `fetch` is replaced
// for the duration of each test.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchModels,
  fetchBenchmarks,
  chatCompletion,
  isAbortError,
  OpenRouterError,
} from "../lib/or-client.js";

const BASE = "https://openrouter.ai/api/v1";

// Replace `globalThis.fetch` with a recorder for the duration of one test.
// `node:test` runs the tests in a file sequentially, so this global swap cannot
// race another test.
function withFetch(responder, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

const json = (body, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });

const errorPage = (body, status, statusText) =>
  new Response(body, { status, statusText, headers: { "Content-Type": "text/html" } });

test("fetchModels returns body.data and sends the key as a bearer token", async () => {
  await withFetch(() => json({ data: [{ id: "acme/one" }] }), async (calls) => {
    const models = await fetchModels("sk-test");
    assert.deepEqual(models, [{ id: "acme/one" }]);
    assert.equal(calls[0].url, BASE + "/models");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  });
});

test("fetchModels tolerates a body with no data array", async () => {
  await withFetch(() => json({}), async () => {
    assert.deepEqual(await fetchModels("k"), []);
  });
});

test("no key means no Authorization header is sent at all", async () => {
  await withFetch(() => json({ data: [] }), async (calls) => {
    await fetchModels("");
    assert.equal("Authorization" in calls[0].init.headers, false);
  });
});

test("fetchBenchmarks encodes the source and asks for a full page", async () => {
  await withFetch(() => json({ data: [] }), async (calls) => {
    await fetchBenchmarks("k", "artificial analysis");
    assert.equal(calls[0].url, BASE + "/benchmarks?source=artificial%20analysis&max_results=500");
  });
});

test("chatCompletion posts the model and messages as JSON and returns the body", async () => {
  const messages = [{ role: "user", content: "hi" }];
  await withFetch(() => json({ choices: [{ message: { content: "ok" } }] }), async (calls) => {
    const body = await chatCompletion("k", "acme/judge:free", messages);
    assert.equal(body.choices[0].message.content, "ok");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "acme/judge:free", messages });
  });
});

test("an HTTP error becomes an OpenRouterError carrying the status and the server's message", async () => {
  await withFetch(
    () => json({ error: { message: "No auth credentials found" } }, 401, "Unauthorized"),
    async () => {
      await assert.rejects(fetchModels("bad"), (err) => {
        assert.ok(err instanceof OpenRouterError);
        assert.equal(err.name, "OpenRouterError");
        assert.equal(err.status, 401);
        assert.match(err.message, /401 Unauthorized: No auth credentials found/);
        return true;
      });
    }
  );
});

// The regression guard. On the old code this message was "502 Bad Gateway: ":
// `res.json()` consumed the body, the fallback `res.text()` rejected with
// "body is unusable", and the detail was swallowed.
test("a non-JSON error body keeps the server's own text in the message", async () => {
  const page = "<html><body>502 Bad Gateway</body></html>";
  await withFetch(() => errorPage(page, 502, "Bad Gateway"), async () => {
    await assert.rejects(fetchModels("k"), (err) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /502 Bad Gateway: <html><body>502 Bad Gateway<\/body><\/html>/);
      return true;
    });
  });
});

test("a plain-text error body is preserved too", async () => {
  await withFetch(
    () => new Response("rate limit exceeded, retry in 3s", { status: 429, statusText: "Too Many Requests" }),
    async () => {
      await assert.rejects(fetchBenchmarks("k", "openrouter"), (err) => {
        assert.match(err.message, /429 Too Many Requests: rate limit exceeded, retry in 3s/);
        return true;
      });
    }
  );
});

test("a JSON body with no error field still reports the body, not an empty detail", async () => {
  await withFetch(() => json({ detail: "upstream timeout" }, 504, "Gateway Timeout"), async () => {
    await assert.rejects(fetchModels("k"), (err) => {
      assert.match(err.message, /504 Gateway Timeout: \{"detail":"upstream timeout"\}/);
      return true;
    });
  });
});

test("an empty error body still yields a well-formed message", async () => {
  await withFetch(() => new Response("", { status: 500, statusText: "Internal Server Error" }), async () => {
    await assert.rejects(fetchModels("k"), (err) => {
      assert.equal(err.message, "500 Internal Server Error: ");
      return true;
    });
  });
});

test("isAbortError only reports an AbortError while our own signal is aborted", () => {
  const controller = new AbortController();
  const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
  const otherErr = new Error("boom");

  assert.equal(isAbortError(abortErr, controller.signal), false, "a live signal is not a cancellation");
  controller.abort();
  assert.equal(isAbortError(abortErr, controller.signal), true);
  assert.equal(isAbortError(otherErr, controller.signal), false, "a non-abort error is never a cancellation");
  assert.equal(isAbortError(abortErr, undefined), false, "no signal, no cancellation");
  assert.equal(isAbortError(null, controller.signal), false);
});
