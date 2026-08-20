/** Claim kind helpers: inference + retrieval priority. */

const KIND_WEIGHT: Record<string, number> = {
  constraint: 12,
  gotcha: 12,
  owner: 8,
  howto: 6,
  structure: 5,
  flow: 4,
  session: 1,
};

export function kindRankBoost(kind: string | null | undefined): number {
  if (!kind) return 3;
  return KIND_WEIGHT[kind.toLowerCase()] ?? 3;
}

/**
 * Infer a durable kind from prompt/answer text.
 * Prefers constraint/gotcha when the language looks like a lasting rule.
 */
export function inferClaimKind(prompt: string, answer = ""): string {
  const hay = `${prompt}\n${answer}`.toLowerCase();
  if (
    /\b(gotcha|pitfall|trap|don'?t|never|always|must not|broken if|fails if|watch out)\b/.test(
      hay,
    )
  ) {
    return "gotcha";
  }
  if (/\b(must|should|required|constraint|invariant|idempotent|only after)\b/.test(hay)) {
    return "constraint";
  }
  if (/\b(owned by|owner|maintained by|responsible)\b/.test(hay)) {
    return "owner";
  }
  if (/\b(how to|steps? to|run this|workflow)\b/.test(hay)) {
    return "howto";
  }
  if (/\b(lives in|entrypoint|located in|module|component)\b/.test(hay)) {
    return "structure";
  }
  return "session";
}

/** Compact durable claim text from a Q/A turn (prefer outcome over raw chat). */
export function compactClaimText(prompt: string, answer?: string): string {
  const takeaway = scrubCodeNoise((answer ?? "").replace(/\s+/g, " ").trim());
  if (takeaway.length >= 40) {
    const preferred = pickFactSentences(takeaway);
    if (preferred) return preferred.slice(0, 400);
    const sentences = takeaway.split(/(?<=[.!?])\s+/).filter(Boolean);
    const head = sentences.slice(0, 2).join(" ").slice(0, 400);
    return head || takeaway.slice(0, 400);
  }
  const q = prompt.replace(/\s+/g, " ").trim().slice(0, 280);
  return takeaway ? `${q}\n\nPrior outcome: ${takeaway.slice(0, 200)}` : q.slice(0, 400);
}

/** Multi-turn: fold several notes into one compact fact string. */
export function compactFromNotes(
  notes: Array<{ role: string; text: string }>,
): { prompt: string; answer: string } | null {
  const users = notes.filter((n) => n.role === "user").map((n) => n.text.trim());
  const assistants = notes.filter((n) => n.role === "assistant").map((n) => n.text.trim());
  if (users.length === 0 && assistants.length === 0) return null;
  const prompt = users.slice(0, 2).join(" — ").slice(0, 400) || "Session takeaways";
  // Prefer assistant sentences that mention paths or durable language
  const pool = assistants.join(" ");
  const answer =
    pickFactSentences(scrubCodeNoise(pool)) ||
    assistants[0]?.replace(/\s+/g, " ").trim().slice(0, 400) ||
    "";
  if (!answer && !isUsefulish(prompt)) return null;
  return { prompt, answer };
}

function isUsefulish(text: string): boolean {
  return text.trim().length >= 16;
}

function scrubCodeNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickFactSentences(text: string): string | null {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 25);
  const scored = sentences.map((s) => {
    let score = 0;
    if (/\b(src\/|[\w.-]+\.(ts|tsx|js|py|go|rs))\b/i.test(s)) score += 3;
    if (/\b(must|should|never|always|gotcha|idempotent|before|after)\b/i.test(s)) score += 2;
    if (/\b(lives in|entrypoint|owned by|constraint)\b/i.test(s)) score += 2;
    if (/^[A-Z]/.test(s)) score += 1;
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((x) => x.score > 0).slice(0, 2).map((x) => x.s);
  if (top.length === 0) return null;
  return top.join(" ");
}

export function isDurableCapture(prompt: string, answer: string | undefined, anchorCount: number): boolean {
  if (anchorCount <= 0) return false;
  const kind = inferClaimKind(prompt, answer ?? "");
  if (kind === "session" && (answer ?? "").trim().length < 80) return false;
  return true;
}
