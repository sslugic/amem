/**
 * Shorten text for injected context without cutting mid-sentence: prefer the last
 * sentence end inside the budget, then the last line break, then the last word.
 */
export function clipText(text: string, max: number, ellipsis = "…"): string {
  const t = String(text ?? "");
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const floor = Math.floor(max * 0.5);
  const sentence = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
    head.lastIndexOf(".\n"),
  );
  if (sentence >= floor) return `${head.slice(0, sentence + 1)} ${ellipsis}`.trimEnd();
  const line = head.lastIndexOf("\n");
  if (line >= floor) return `${head.slice(0, line).trimEnd()}\n${ellipsis}`;
  const word = head.lastIndexOf(" ");
  return `${(word >= floor ? head.slice(0, word) : head).trimEnd()}${ellipsis}`;
}
