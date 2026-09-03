import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownLite } from "../lib/markdown-lite.js";

test("renderMarkdownLite bolds **text** and escapes raw HTML", () => {
  const out = renderMarkdownLite("**Recommendation: GLM 5.2** beats <script>alert(1)</script>.");
  assert.match(out, /<strong>Recommendation: GLM 5.2<\/strong>/);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
});

test("renderMarkdownLite splits blank-line-separated paragraphs into separate <p> blocks", () => {
  const out = renderMarkdownLite("First paragraph.\n\nSecond paragraph.");
  assert.equal((out.match(/<p>/g) || []).length, 2);
  assert.match(out, /First paragraph\./);
  assert.match(out, /Second paragraph\./);
});

test("renderMarkdownLite renders a block of '- ' lines as a list", () => {
  const out = renderMarkdownLite("- one\n- two\n- three");
  assert.match(out, /<ul><li>one<\/li><li>two<\/li><li>three<\/li><\/ul>/);
});

test("renderMarkdownLite joins single newlines within a paragraph with <br>", () => {
  const out = renderMarkdownLite("line one\nline two");
  assert.match(out, /line one<br>line two/);
});
