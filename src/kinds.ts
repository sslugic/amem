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
  const takeaway = (answer ?? "").replace(/\s+/g, " ").trim();
  if (takeaway.length >= 40) {
    // Prefer first 1–2 sentences of the answer
    const sentences = takeaway.split(/(?<=[.!?])\s+/).filter(Boolean);
    const head = sentences.slice(0, 2).join(" ").slice(0, 400);
    return head || takeaway.slice(0, 400);
  }
  const q = prompt.replace(/\s+/g, " ").trim().slice(0, 280);
  return takeaway ? `${q}\n\nPrior outcome: ${takeaway.slice(0, 200)}` : q.slice(0, 400);
}

export function isDurableCapture(prompt: string, answer: string | undefined, anchorCount: number): boolean {
  if (anchorCount <= 0) return false;
  const kind = inferClaimKind(prompt, answer ?? "");
  if (kind === "session" && (answer ?? "").trim().length < 80) return false;
  // README-only anchors are weak unless the kind is strongly durable
  return true;
}
