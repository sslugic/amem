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

/** "Can you …", "Could we …", "can yo u…": a request, wherever it sits in the text. */
const ASK = /\b(?:can|could|would)\s+(?:you|yo|u|we)\b|^(?:can|could|would|will)\s+(?:i|it|someone|they)\b/i;
/** "What does …", "How would …": a question that lost its "?". */
const WH_QUESTION = /^(?:what|how|why|where|when|which|who)\s+(?:does|do|did|would|could|should|can|is|are|was|were|will)\b/i;
/** "users ask why X?" reports a question; it does not ask one. */
const REPORTED_QUESTION = /\b(?:ask|asks|asked|asking|wonder|wonders|wondered)\s+(?:why|how|what|whether|if|when|where|which|who)\b[^?]*\?/gi;
/** Quoted text (an error message, a UI label) is not the writer's own words. */
const QUOTED = /"[^"]*"|“[^”]*”|`[^`]*`|(^|\s)'[^']+'(?=[\s.,;:)]|$)/g;
/** A request or hand-off, not a statement: "fix it for me please", "figure out …". */
const REQUEST = /\b(?:please|pls|for me|can you|could you|let me know|figure out|look into|whatever)\b/i;
/** Hedging and progress chatter: "I think maybe …", "will report back", "…okay". */
const HEDGE = /\b(?:i think|i guess|i believe|maybe we|kind of|sort of|honestly|report back|will report)\b|\b(?:okay|ok)\s*[.!]?$/i;
/** Notes to self that look like facts: "TODO: …". */
const TODO_LEAD = /^(?:todo|fixme|tbd|wip)\b/i;
const HAS_ANCHOR = /[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|md|json|ya?ml|toml|sql|sh)\b|\b[\w.-]+\/[\w./-]+/;
/** Pasted host/system plumbing (task notifications, reminders, agent hand-backs). */
/**
 * Text the host wrote, not the user: notifications, and the echo of a `!` shell command
 * or slash command (Claude Code wraps those in <bash-input>, <command-name> …). Treating
 * a pasted `git push` as a question pulled unrelated memories into the prompt.
 */
const SYSTEM_TEXT =
  /<(?:task-notification|system-reminder|agent-message|tool-use-id|bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|command-name|command-message|command-args)\b|\[SYSTEM NOTIFICATION/i;
/**
 * Residue of an earlier scrub: "lives in and is", "wired via and included". The
 * preposition must be a word of its own (not "stand-in", "log-in") and the next word
 * lowercase, so "notes with What to Test" or "stand-in is complete" are left alone.
 */
const DANGLING = /(?<![\w-])(?:[Ii]n|[Aa]t|[Ff]rom|[Tt]o|[Vv]ia|[Ii]nside|[Uu]nder|[Ww]ith|[Ii]nto)\s+(?:and|is|was|the file|what)\b/;
/** Interrogative opener plus a subject — a question missing its "?". */
const QUESTION_SHAPE =
  /^(can|could|should|would|do|does|did|is|are|will|shall|how|what|why|when|where|who|which)\s+(?:(?:do|does|did|can|could|should|would|is|are|will|shall)\s+)?(we|you|i|amem)\b/i;
/**
 * A preposition whose object was deleted, leaving a space before the punctuation:
 * "memory lives under ." or "reads it from , then". Ordinary prose ("before it goes
 * in.", "removed with:"), hyphenated words ("sign-in.", "How-to:"), domains
 * ("in.sumsub.com") and paths ("in .claude/launch.json") do not have that shape.
 */
const TRAILING_PREPOSITION =
  /(?<![\w-])(?:in|at|from|to|via|inside|under|with|into|through)\s+[.,;:](?=\s|$)/i;
/**
 * A question mark that ends a question: after a word or closing quote/bracket and
 * followed by space or end. URL query strings ("?view=reports", "invite.html?r=CODE")
 * and quoted placeholders ("needs ?)") are not questions.
 */
const QUESTION_MARK = /[\w"'\u2019)\]]\?(?=\s|$|["'\u2019)])/;

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
export function isSystemText(text: string): boolean {
  return SYSTEM_TEXT.test(text ?? "");
}

export function nonFactReason(text: string): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length === 0) return "empty";
  if (SYSTEM_TEXT.test(t)) return "system-text";
  // A question is a request someone typed, not a fact about the code. Only when it opens
  // the memory (or the memory is short): a long fact may quote an open question
  // ("…; open question: is X the intended experience?") and must be kept.
  const firstSentence = t.split(/(?<=[.!?])\s+/)[0] ?? t;
  if (QUESTION_MARK.test(firstSentence) || (t.length < 160 && QUESTION_MARK.test(t))) return "question";
  // ...and plenty were typed without the question mark ("can we expose amem
  // data via mcp"). Require an interrogative opener FOLLOWED by a subject, so
  // this cannot swallow a declarative sentence that merely starts with "Is".
  if (QUESTION_SHAPE.test(t)) return "question";
  // Left behind by the old scrub that deleted inline code spans.
  if (DANGLING.test(t)) return "scrub-residue";
  // Same damage, different shape: the span sat at the end of the clause, so a
  // preposition now runs straight into punctuation ("memory lives under .").
  if (TRAILING_PREPOSITION.test(t)) return "scrub-residue";
  // Chatter is deleted only when it is unmistakable (strongly negative score); the admit
  // gate above rejects far more, so deletion stays a strict subset of rejection.
  if (factScore(t) <= -3) return "chat-fragment";
  return null;
}

/** Someone announcing what they are about to do: "I'll …", "let me …", "going to …". */
const INTENT =
  /\b(?:i(?:'ll| will| am going to|'m going to|'m gonna| gonna)|we(?:'ll| will)|let me|let's|lets|going to|gonna|about to)\b|^(?:will do|working on|pushing|merging|running|rerunning|checking|looking)\b/i;
/** Replies to the other person: "makes sense", "sounds good", "thanks", "LGTM". */
const ACK =
  /\b(?:makes sense|sounds good|got it|thanks|thank you|thx|nice catch|good catch|lgtm|fair enough|agreed|no problem|great job|happy to help|(?:great|good) (?:question|point|idea)|short answer|long story short)\b|^(?:on it|will do)\b|^(?:done|nice|cool|great|perfect|awesome|ok|okay|yep|yeah|sure|hmm|oh|wait)\b[!,.]/i;
/** Status chatter about the work in flight, not the code: "merging now", "in a minute". */
const PROGRESS = /\b(?:in a (?:minute|sec|bit)|end of day|after lunch|later today|for now|next sprint|goes green|once ci|report back|will report)\b|\b(?:merging|pushing|shipping|rerunning) (?:now|it|the)\b|\bship it\b/i;
/** Speaking to the reader: "you should …", "can you …". */
/** Not knowing is not a fact: "not sure why …", "maybe it's …", "probably". */
const UNCERTAIN = /\b(?:not sure|unsure|no idea|i wonder|maybe it|perhaps|might be|could be|probably|presumably|i suspect|it depends)\b/i;
const SECOND_PERSON = /\b(?:you should|you need to|you can|you'll|you will|you might)\b/i;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
/** A plain present-tense statement about how something works. */
const FACT_VERB =
  /\b(?:is|are|has|have|uses|runs|stores|reads|writes|returns|lives|calls|caches|requires|rejects|blocks|sends|keeps|sets|takes|holds|applies|skips|retries|binds|refuses|registers|injects|publishes|compares|falls back|defaults|points|loads|owns|contains|limits|bumps?|drop(?:s|ped)|ships|maps|matches|marks|stays?|still|starts|ends|fails|works|needs|supports|includes|allows|expires|triggers|accepts|ignores|deletes|creates|wraps|exports|imports|handles|lists|shows|prints|logs|emits|parses|resolves|tracks|counts|gets|lets|makes|means|depends|belongs|happens|breaks|was|were|won't|can't|doesn't|isn't|aren't|do(?:es)? not|don't|never|always|only|must)\b/i;
const IDENTIFIER = /`[^`]+`|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b[A-Z]{2,}[-_][A-Z0-9_-]+\b|\b\w+\(\)/;
const VALUE = /\d|\b(?:true|false|null)\b|=/;
/** A definition: "Testera Probe app icon: dark squircle …", "Pool: Hollywood, …". */
const LABELLED = /^[A-Z][\w .'/-]{1,50}:\s+\S/;
/** A dated record: "2026-10-31", "Oct 19, 2026", "Mon Aug 17". */
const DATED = /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{1,2}\b/i;
/** A completed action ("merged", "confirmed", "cleared", "shipped"): what a record states. */
const PAST_VERB = /\b[a-z]{3,}(?:ed|ied)\b/i;
/** A lone interjection opening the text: "So, …", "Ok …" — weak on its own, not a verdict. */
const INTERJECTION_LEAD = /^(?:so|ok|okay|and|but|yes|yeah|yep|no|nope|sure|well|actually|btw|oh|hey|hmm|wait|alright)(?:[,!.]|\s)/i;

/**
 * How much `text` reads like a durable statement (positive) versus conversation
 * (negative). Fact signals: a present-tense verb about the system, a path, an identifier,
 * a number or config value. Chatter signals: first-person intent, acknowledgements,
 * progress talk, hedging, requests, second person, emoji. A lead word ("Ok-status …",
 * "So far …") costs a little and decides nothing by itself.
 */
export function factScore(text: string): number {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  const own = t.replace(QUOTED, "$1''").replace(REPORTED_QUESTION, "");
  let score = 0;
  if (FACT_VERB.test(own)) score += 2;
  else if (PAST_VERB.test(own)) score += 1;
  if (DATED.test(t)) score += 1;
  if (LABELLED.test(t)) score += 1;
  if (HAS_ANCHOR.test(t)) score += 2;
  if (IDENTIFIER.test(t)) score += 1;
  if (VALUE.test(own)) score += 1;
  if (/^[A-Z0-9`~/.]/.test(t) || CODE_LEAD.test(t) || IDENTIFIER.test(t.split(" ")[0] ?? "")) score += 1;
  if (INTENT.test(own)) score -= 4;
  if (ACK.test(own)) score -= 4;
  if (PROGRESS.test(own)) score -= 3;
  if (HEDGE.test(own) || REQUEST.test(own)) score -= 3;
  if (SECOND_PERSON.test(own)) score -= 3;
  if (UNCERTAIN.test(own)) score -= 3;
  if (TODO_LEAD.test(t)) score -= 4;
  if (EMOJI.test(t)) score -= 2;
  if (INTERJECTION_LEAD.test(t)) score -= 1;
  if (/^[a-z]/.test(t) && !CODE_LEAD.test(t) && !IDENTIFIER.test(t.split(" ")[0] ?? "")) score -= 2;
  return score;
}

/** Admit threshold for factScore. */
const FACT_MIN_SCORE = 3;

/**
 * Is this a durable statement about the code, or conversational residue? Hard rejects:
 * too short, host text, questions (per sentence), asks, scrub residue. Everything else is
 * judged by factScore, so the first word alone never decides.
 */
export function isFactLike(text: string): boolean {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  // Short facts are fine when they point at code ("WAL mode is set in src/db.ts:359.").
  if (t.length < (HAS_ANCHOR.test(t) ? 24 : 40)) return false;
  if (SYSTEM_TEXT.test(t)) return false;
  const own = t.replace(QUOTED, "$1''").replace(REPORTED_QUESTION, "");
  const sentences = own.split(/(?<=[.!?])\s+/);
  if (sentences.some((s) => QUESTION_MARK.test(s) || QUESTION_SHAPE.test(s) || WH_QUESTION.test(s))) return false;
  if (ASK.test(own)) return false;
  if (DANGLING.test(t)) return false;
  return factScore(t) >= FACT_MIN_SCORE;
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
