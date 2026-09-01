import {
  getClaim,
  getRepoById,
  getUsageEvent,
  latestUsageEvent,
  listAllUsageEvents,
  listUnattestedEvents,
  setEstimatedTokensSaved,
  setUsageAttestation,
  type UsageEventRow,
} from "./db.js";
import { anchorsOpenedFrom, readTranscriptOpens } from "./transcript.js";
import {
  estimateTokensSaved,
  measureAnchorTokens,
  reportedTokensSavedFromAttestation,
} from "./estimate.js";

/**
 * Closing the calibration loop.
 *
 * The old `--saved <n>` flow asked a human for a token count nobody can know,
 * which is why it was never once used. This module derives the number instead,
 * from two things that are actually observable: the real size of the files amem
 * pointed at, and which of them the agent still had to open.
 */

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * The anchors a packet handed over. Newer events store them directly; older
 * ones are reconstructed from the claims they cited, which is what makes the
 * 1,594 historical events recoverable rather than written off.
 */
export function anchorsForEvent(event: UsageEventRow): string[] {
  const stored = parseJsonArray(event.anchors_json);
  if (stored.length) return stored;
  const claimIds = parseJsonArray(event.claim_ids);
  const anchors = new Set<string>();
  for (const claimId of claimIds) {
    // A purged or superseded claim simply contributes nothing — the event then
    // measures lower than it did originally, which is the honest outcome.
    const claim = getClaim(event.repo_id, claimId);
    if (!claim) continue;
    for (const anchor of parseJsonArray(claim.code_anchors)) anchors.add(anchor);
  }
  return [...anchors];
}

function rootPathForEvent(event: UsageEventRow): string | null {
  return getRepoById(event.repo_id)?.root_path ?? null;
}

export type AttestationResult = {
  event: UsageEventRow;
  anchorsReturned: string[];
  anchorsOpened: string[];
  anchorsUnopened: string[];
  reportedTokensSaved: number;
  estimatedTokensSaved: number;
  measuredFiles: number;
  assumedFiles: number;
};

/**
 * Record which anchors the agent actually opened and turn that into a measured
 * saving. Anchors it opened are not savings — that read happened. An agent that
 * opened everything reports a loss, and that is the point: the metric has to be
 * able to disagree with the model.
 */
export function attestUsage(input: {
  eventId?: string | null;
  repoId?: string | null;
  platform?: string | null;
  anchorsOpened: string[];
  answered: boolean;
}): AttestationResult {
  const event = input.eventId
    ? getUsageEvent(input.eventId)
    : input.repoId
      ? latestUsageEvent(input.repoId, input.platform ?? null)
      : null;
  if (!event) {
    throw new Error(
      input.eventId
        ? `Unknown usage event: ${input.eventId}`
        : "No usage event to attest — run `amem context` first.",
    );
  }

  const anchorsReturned = anchorsForEvent(event);
  const rootPath = rootPathForEvent(event);
  // Only anchors amem actually returned can be "opened"; anything else the
  // agent read was its own exploration and is not amem's to claim or discount.
  const returnedSet = new Set(anchorsReturned);
  const anchorsOpened = input.anchorsOpened
    .map((a) => String(a || "").trim())
    .filter((a) => a && returnedSet.has(a));

  const { reportedTokensSaved, anchorsUnopened, measurement } = reportedTokensSavedFromAttestation({
    anchorsReturned,
    anchorsOpened,
    claimsCount: event.claims_count,
    packetTokens: event.packet_tokens,
    rootPath,
  });

  const full = measureAnchorTokens(anchorsReturned, rootPath);
  const saved = setUsageAttestation(event.id, {
    anchorsOpened,
    answered: input.answered,
    reportedTokensSaved,
    anchors: anchorsReturned,
    anchorTokens: full.anchorTokens,
  });

  return {
    event: saved,
    anchorsReturned,
    anchorsOpened,
    anchorsUnopened,
    reportedTokensSaved,
    estimatedTokensSaved: saved.estimated_tokens_saved,
    measuredFiles: measurement.measuredFiles,
    assumedFiles: measurement.assumedFiles,
  };
}

export type RecomputeResult = {
  scanned: number;
  changed: number;
  before: number;
  after: number;
  measuredFiles: number;
  assumedFiles: number;
  applied: boolean;
};

/**
 * Backfill: replace the flat 4k-per-file guess on historical events with the
 * real size of the files those events pointed at. Dry run by default — this
 * rewrites the headline number, so it should be something you choose.
 */
export function recomputeUsageEstimates(
  opts: { repoId?: string | null; apply?: boolean } = {},
): RecomputeResult {
  const events = listAllUsageEvents(opts.repoId ?? null);
  const result: RecomputeResult = {
    scanned: events.length,
    changed: 0,
    before: 0,
    after: 0,
    measuredFiles: 0,
    assumedFiles: 0,
    applied: Boolean(opts.apply),
  };

  const rootCache = new Map<string, string | null>();
  for (const event of events) {
    result.before += event.estimated_tokens_saved;
    // A miss saved nothing by definition; leave it at zero.
    if (event.kind === "server_trip" || event.claims_count === 0) {
      result.after += event.estimated_tokens_saved;
      continue;
    }
    if (!rootCache.has(event.repo_id)) {
      rootCache.set(event.repo_id, rootPathForEvent(event));
    }
    const rootPath = rootCache.get(event.repo_id) ?? null;
    const anchors = anchorsForEvent(event);
    const measurement = measureAnchorTokens(anchors, rootPath);
    result.measuredFiles += measurement.measuredFiles;
    result.assumedFiles += measurement.assumedFiles;
    const next = estimateTokensSaved({
      anchorsCount: anchors.length,
      anchorTokens: measurement.anchorTokens,
      claimsCount: event.claims_count,
      packetTokens: event.packet_tokens,
    });
    result.after += next;
    if (Math.round(next) !== event.estimated_tokens_saved) result.changed += 1;
    if (opts.apply) {
      setEstimatedTokensSaved(event.id, {
        estimatedTokensSaved: next,
        anchors,
        anchorTokens: measurement.anchorTokens,
      });
    }
  }
  return result;
}

export type SessionAttestation = {
  attested: number;
  skipped: boolean;
  reason?: string;
  reportedTokensSaved: number;
};

/**
 * Attest every unattested packet from one session using the host transcript as
 * the evidence, so the loop closes without the agent having to remember.
 *
 * Refuses to attest when the transcript yielded no file-tool activity. That
 * case is "we could not tell", and silently recording it as "opened nothing"
 * would credit amem the maximum saving precisely when it knows the least —
 * exactly the self-flattering failure the measured basis exists to avoid.
 */
export function attestSessionFromTranscript(input: {
  repoId: string;
  sessionId: string;
  transcriptPath?: string | null;
}): SessionAttestation {
  if (!input.transcriptPath) {
    return { attested: 0, skipped: true, reason: "no transcript path", reportedTokensSaved: 0 };
  }
  const opens = readTranscriptOpens(input.transcriptPath);
  if (!opens.sawToolActivity) {
    return {
      attested: 0,
      skipped: true,
      reason: "transcript had no readable file-tool activity",
      reportedTokensSaved: 0,
    };
  }

  const rootPath = getRepoById(input.repoId)?.root_path ?? null;
  const events = listUnattestedEvents(input.repoId, input.sessionId);
  let attested = 0;
  let total = 0;
  for (const event of events) {
    const anchorsReturned = anchorsForEvent(event);
    if (!anchorsReturned.length) continue;
    const anchorsOpened = anchorsOpenedFrom(anchorsReturned, opens.paths, rootPath);
    try {
      const result = attestUsage({
        eventId: event.id,
        anchorsOpened,
        // The transcript shows which files were read, not whether the answer
        // landed. Treat a packet as having answered only when the agent did not
        // have to open everything it was handed.
        answered: anchorsOpened.length < anchorsReturned.length,
      });
      attested += 1;
      total += result.reportedTokensSaved;
    } catch {
      // event vanished mid-run; nothing to do
    }
  }
  return { attested, skipped: false, reportedTokensSaved: total };
}
