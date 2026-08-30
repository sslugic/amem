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
  // Short answer: the fact is still in the ANSWER, so lead with it and keep the
  // prompt only as trailing context. Leading with the prompt is how questions
  // ended up stored as durable claims; the trailing "?" is dropped so the
  // result reads as a statement rather than tripping the question filter.
  const q = prompt.replace(/\s+/g, " ").trim().replace(/\?+\s*$/, "").slice(0, 280);
  if (!takeaway) return q.slice(0, 400);
  return `${takeaway.slice(0, 200)}${q ? ` (context: ${q})` : ""}`.slice(0, 400);
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
    // Keep what is INSIDE an inline span. Deleting it removed the file paths
    // and identifiers that make a claim worth storing ("lives in `src/x.ts`"
    // became "lives in and"), and it ran before pickFactSentences, which
    // scores sentences on exactly those paths.
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const QUESTION_LEAD =
  /^(can|could|would|should|is|are|was|were|do|does|did|how|what|why|when|where|who|which|will|shall|may|might|am|have|has|had)\b/i;
const CHAT_LEAD =
  /^(so|ok|okay|and|but|also|im|i'm|let's|lets|please|thanks|thx|yeah|yep|nope|hmm|wait|actually|btw|oh|hey)\b/i;
/** Residue of an earlier scrub: "lives in and is", "wired via and included". */
const DANGLING = /\b(in|at|from|to|via|inside|under|with|into)\s+(and|is|was|the file|what)\b/i;
/** Interrogative opener plus a subject — a question missing its "?". */
const QUESTION_SHAPE =
  /^(can|could|should|would|do|does|did|is|are|will|shall|how|what|why|when|where|who|which)\s+(?:(?:do|does|did|can|could|should|would|is|are|will|shall)\s+)?(we|you|i|amem)\b/i;
/** Preposition running into punctuation or end of string: the object was deleted. */
const TRAILING_PREPOSITION = /\b(in|at|from|to|via|inside|under|with|into|through)\s*([.,;:]|$)/i;

/** A leading token that looks like code (path, dotted or snake_case name). */
const CODE_LEAD = /^[\w@./-]*[._/][\w@./-]*(\s|$)/;

/**
 * Is this a durable statement about the code, or conversational residue?
 *
 * Auto-capture previously accepted any sentence >= 48 chars that mentioned a
 * path, which stored the user's own questions as facts ("so use luna mcp to
 * connect to amem and that will do the trick?"). A question is a request, not
 * a fact, however many files it names.
 */
/**
 * Why an ALREADY STORED claim is clear junk, or null to keep it.
 *
 * Deliberately narrower than isFactLike: that gate decides what to admit and
 * can afford false negatives, this one decides what to DELETE and a false
 * positive destroys memory. Short, lowercase or oddly-formatted claims are
 * kept here even though capture would now reject them.
 */
export function nonFactReason(text: string): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length === 0) return "empty";
  // A question is a request someone typed, not a fact about the code.
  if (t.includes("?")) return "question";
  // ...and plenty were typed without the question mark ("can we expose amem
  // data via mcp"). Require an interrogative opener FOLLOWED by a subject, so
  // this cannot swallow a declarative sentence that merely starts with "Is".
  if (QUESTION_SHAPE.test(t)) return "question";
  // Left behind by the old scrub that deleted inline code spans.
  if (DANGLING.test(t)) return "scrub-residue";
  // Same damage, different shape: the span sat at the end of the clause, so a
  // preposition now runs straight into punctuation ("memory lives under .").
  if (TRAILING_PREPOSITION.test(t)) return "scrub-residue";
  if (CHAT_LEAD.test(t)) return "chat-fragment";
  return null;
}

export function isFactLike(text: string): boolean {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 40) return false;
  if (t.includes("?")) return false;
  if (QUESTION_LEAD.test(t)) return false;
  if (CHAT_LEAD.test(t)) return false;
  if (DANGLING.test(t)) return false;
  // Mid-thought lowercase openings are transcript fragments — unless the
  // sentence opens on an identifier, which is normal for a real fact.
  if (/^[a-z]/.test(t) && !CODE_LEAD.test(t)) return false;
  return true;
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
