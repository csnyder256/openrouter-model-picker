// Thin fetch wrappers around the OpenRouter API. Every call goes straight
// from this browser to openrouter.ai; there is no backend, and the API key
// never leaves the tab except as the Authorization header on these requests.
// CORS on openrouter.ai is wide open (verified: Access-Control-Allow-Origin: *
// on both /models and /chat/completions), which is what makes that possible.

const BASE = "https://openrouter.ai/api/v1";

class OpenRouterError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

// `init` may carry an `AbortController.signal` (see `chatCompletion`); fetch
// honours it natively, and `res.text()` below must be passed the same signal
// so an abort mid-body-read rejects instead of hanging on a response nobody
// is waiting for any more. A signal whose work is already done aborts nothing.
//
// The signal is a request to stop, not a guarantee of one: an abort settles an
// in-flight request, but it cannot un-resolve a response that has already
// arrived, and `Response.body` may already be in a settled state. So this layer
// only ever *reports* a cancellation; who is still allowed to write to the page
// is decided by search ownership in `lib/match.js`, never by the transport.
async function orFetch(path, apiKey, init) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(init && init.headers),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.error?.metadata?.raw || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new OpenRouterError(`${res.status} ${res.statusText}: ${detail}`, res.status);
  }
  return res.json();
}

// Public, unauthenticated in practice, but we pass the key when we have one.
export async function fetchModels(apiKey, signal) {
  const body = await orFetch("/models", apiKey, { signal });
  return body.data || [];
}

// Requires auth. One call per source covers every task type that source
// reports (Artificial Analysis returns intelligence/coding/agentic together;
// OpenRouter's own source returns every benchmark_type when unfiltered), so
// a full refresh costs exactly two calls here plus one for /models.
export async function fetchBenchmarks(apiKey, source, signal) {
  const body = await orFetch(`/benchmarks?source=${encodeURIComponent(source)}&max_results=500`, apiKey, { signal });
  return body.data || [];
}

export async function chatCompletion(apiKey, model, messages, signal) {
  const body = await orFetch("/chat/completions", apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages }),
    signal,
  });
  return body;
}

// True when `err` looks like the cancellation of the request that carried
// `signal`. What it checks, exactly: the signal we passed to fetch is in its
// own aborted state, and the error's `name` is `AbortError`. It does NOT prove
// the error came from our signal -- once our signal is aborted, any unrelated
// AbortError reaching the same call site satisfies it. Callers pair this with
// the epoch check, which is what actually decides whether a failure is ours to
// report.
// The `name` check is how the DOM reports a cancellation: `fetch` rejects with
// an `AbortError` DOMException, and `AbortSignal.reason` is an `AbortError` by
// default. The `signal.aborted` check is what keeps an abort-shaped error
// arriving while our signal is still live -- a different controller, an
// extension, a navigation -- from being swallowed as ours.
export function isAbortError(err, signal) {
  return Boolean(signal && signal.aborted && err && err.name === "AbortError");
}

export { OpenRouterError };
