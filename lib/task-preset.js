// The task-description field and the task-preset select, as one small pure
// rule. `lib/match.js` owns the presets and the hint-vs-task rule
// (`resolveTaskDescription`); this module owns what the preset select does to
// the text field when the user changes it.

import { findPreset } from "./match.js";

// The description field is pre-filled with the selected preset's own hint --
// `lib/match.js` calls that hint "the default task description text" -- so a
// non-empty field is NOT evidence that the user typed a task. The app cannot
// tell the two apart by looking at the field alone, which is why this rule is
// given both sides of the change.
//
// That distinction matters at exactly one place: the custom preset, whose hint
// ("Describe your own task below.") is a placeholder instruction rather than a
// task, which is why `resolveTaskDescription` refuses to substitute it as one.
// Before this, switching from a preset to "Custom task…" left the OUTGOING
// preset's hint sitting in the field, and every later read treated it as the
// task the user had described: the select read "Custom task…" while the
// description still said, for example, "Write, complete, or generate code.",
// and the search ran the previous preset's task under the custom preset's
// ranking metric. The user never wrote that sentence.
//
// So a description that still holds the outgoing preset's own hint is that
// preset's text, not the user's: moving to the custom preset clears it. Text
// the user actually wrote is left exactly as it is, and every other preset
// keeps the existing behaviour of pre-filling its own hint.
export function nextTaskDescription(fromPresetId, toPresetId, currentText) {
  const to = findPreset(toPresetId);
  if (!to) return typeof currentText === "string" ? currentText : "";
  if (to.id !== "custom") return to.hint;
  const from = findPreset(fromPresetId);
  const text = typeof currentText === "string" ? currentText : "";
  const holdsOutgoingHint = Boolean(from) && from.id !== "custom" && text.trim() === from.hint.trim();
  return holdsOutgoingHint ? "" : text;
}
