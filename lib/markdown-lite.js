// The free-model judge answers in prose with light Markdown (**bold**,
// paragraphs, occasional "- " bullet lists). A full Markdown library is not
// worth a dependency for that small a surface, so this renders just those
// three shapes into safe HTML. Unknown syntax is left as literal text rather
// than guessed at.

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

export function renderMarkdownLite(text) {
  const blocks = (text || "").trim().split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (lines.length && lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
        const items = lines.map((l) => `<li>${inline(l.trim().replace(/^[-*]\s+/, ""))}</li>`).join("");
        return `<ul>${items}</ul>`;
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("\n");
}
