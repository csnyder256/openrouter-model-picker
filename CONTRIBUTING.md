# Contributing

Thanks for looking at this. It's a small tool, and the bar for changes is small on purpose.

## Ground rules

**Zero dependencies, browser or dev.** No CDN scripts, no bundler, no `node_modules`. `lib/` is plain ES modules a browser loads directly and Node's built-in test runner imports directly. If a change needs a package to do it cleanly, that is a sign the change does not belong in this repository.

**No backend.** Every network call in this app goes straight from the browser to `openrouter.ai`. Do not add a proxy, a serverless function, or anything else that would see the user's API key. See `SECURITY.md`.

**Missing data is `null`, never a default.** A model with no benchmark row shows "n/a" in the table and is skipped by the judge's cited numbers. It does not get scored as zero and it does not get silently excluded from the results table. If you find yourself writing `?? 0` on a benchmark field, stop; that turns "unmeasured" into "measured and bad," which is a claim the data does not support.

**The judge call must stay free.** It only ever targets a `:free`-suffixed model. If you change the fallback ladder in `lib/match.js` (`rankFreeModels` / `nextFallbackModel` / `isRetryableJudgeStatus`), keep it that way and keep the unit tests passing.

**Test the pure logic.** Everything in `lib/` is DOM-free and fetch-free by design specifically so it can be unit tested with `node --test` and no dependencies. `app.js` and `lib/or-client.js` are the thin, untested wiring; put new logic in `lib/match.js` or a sibling pure module, not in the wiring.

## Running the tests

```bash
node --test
```

## Adding a task preset

Add an entry to `TASK_PRESETS` in `lib/match.js`: an `id`, a `label`, a `hint` (the default task description text), a `primaryMetric` (which benchmark field drives "Best quality" sorting and the judge's framing; `null` if the task has none, like image generation), and `requireInput` / `requireOutput` modality arrays if the task needs a specific modality (e.g. `requireOutput: ["audio"]` for text-to-speech). Add a test in `tests/match.test.js` asserting the modality filter actually narrows the field the way you expect: a preset with the wrong modality array silently returns nothing, which is easy to miss without a test.

## Reporting a wrong recommendation

The judge model can be wrong; it is reading live benchmark and price data, not making anything up, but the read can still be a bad one. Open an issue with the task description, preferences, and (if you can) which model it picked and which one you think it should have picked and why. That is more useful than a general "it's not smart enough."
