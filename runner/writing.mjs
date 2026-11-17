// Writing-only mode's code checks: the model writes, code decides whether it met the word limit and strips any
// sentence about itself. Pure functions, unit-tested in test/writing.test.mjs.

// "300 words", "under 250 words", "max 500 words", "no more than 400 words", "250-word", "word limit: 300", "limit of 300 words".
// Returns the upper bound in words, or null. A range ("250-300 words") gives its top.
export function wordLimit(task) {
  const t = String(task).toLowerCase().replace(/,(?=\d{3})/g, '');
  const m = t.match(/\b(\d{2,5})\s*(?:-|–|to)\s*(\d{2,5})[\s-]*words?\b/)
    || t.match(/\bword\s*(?:limit|count|max(?:imum)?)\s*(?:of|is|:)?\s*(\d{2,5})\b/)
    || t.match(/\b(\d{2,5})[\s-]*words?\b/);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]);
  return n >= 10 ? n : null;
}

// Words as a teacher counts them: whitespace-separated runs that contain a letter or digit (markdown #, -, * and
// lone punctuation don't count; "zero-trust" and "U.S." are one word each).
export const countWords = text => String(text).split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;

// Small models open with "Since you requested a text-only response…" / "Here is the report:" / "Sure! …".
// Drop such lines from the top only; the deliverable itself is never touched.
const META = /^(?:\s*(?:sure|certainly|of course|okay|ok|absolutely|great)\b[^\n]*|[^\n]*\b(?:you (?:requested|asked|wanted)|as requested|per your request|text-only|no browser|browser takeover)[^\n]*|\s*(?:here(?:'s| is| are)|below is|the following is)\b[^\n]*:\s*)$/i;
export function stripMeta(text) {
  const lines = String(text).trim().split('\n');
  while (lines.length > 1 && (META.test(lines[0]) || !lines[0].trim())) lines.shift();
  return lines.join('\n').trim();
}
