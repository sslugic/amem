import type { SessionRow, UsageEventRow } from "./db.js";
import { estimateMsSaved, eventKind } from "./estimate.js";

export type ActivityNode = {
  id: string;
  type: "amem" | "llm" | "server" | "session" | "local_hit" | "server_trip";
  label: string;
  detail: Record<string, unknown>;
};

export type ActivityLink = {
  from: string;
  to: string;
  kind: string;
};

export type EventSpeed = {
  kind: "local_hit" | "server_trip";
  estimatedMsSaved: number;
  localMs: number | null;
  anchorsCount: number;
  claimsCount: number;
};

export function speedForEvent(e: UsageEventRow): EventSpeed {
  const kind =
    e.kind === "local_hit" || e.kind === "server_trip"
      ? e.kind
      : eventKind(e.claims_count);
  return {
    kind,
    estimatedMsSaved:
      e.estimated_ms_saved ??
      estimateMsSaved({ anchorsCount: e.anchors_count, claimsCount: e.claims_count }),
    localMs: e.local_ms ?? null,
    anchorsCount: e.anchors_count,
    claimsCount: e.claims_count,
  };
}

function llmId(platform: string): string {
  return `llm.${platform || "unknown"}`;
}

function sessionNodeId(platform: string, sessionId: string): string {
  return `session.${platform}.${sessionId}`;
}

function shortSession(id: string): string {
  if (!id || id === "unknown") return "unknown session";
  return id.length > 14 ? `${id.slice(0, 8)}…` : id;
}

export function buildActivityGraph(input: {
  events: UsageEventRow[];
  sessions: SessionRow[];
}): { nodes: ActivityNode[]; links: ActivityLink[] } {
  const nodes: ActivityNode[] = [];
  const links: ActivityLink[] = [];
  const seen = new Set<string>();
  const seenLinks = new Set<string>();

  const push = (node: ActivityNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  };

  const link = (from: string, to: string, kind: string) => {
    const key = `${from}|${to}|${kind}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({ from, to, kind });
  };

  const events = input.events.slice(0, 24);
  const platforms = new Set<string>();
  for (const e of events) platforms.add(e.platform || "unknown");
  for (const s of input.sessions) platforms.add(s.platform || "unknown");

  if (platforms.size === 0) return { nodes, links };

  push({
    id: "amem.local",
    type: "amem",
    label: "amem",
    detail: { title: "Local memory", path: "~/.amem" },
  });
  push({
    id: "server.remote",
    type: "server",
    label: "Model / tools",
    detail: {
      title: "Remote trip",
      note: "Prompt still goes to the LLM. This node is a miss: amem had nothing useful, so the agent had to explore.",
    },
  });

  for (const platform of [...platforms].sort()) {
    const pid = llmId(platform);
    push({
      id: pid,
      type: "llm",
      label: platform,
      detail: { platform, title: `${platform} agent` },
    });
    link("amem.local", pid, "serves");
  }

  const platformList = [...platforms].sort();
  for (let i = 0; i < platformList.length; i++) {
    for (let j = i + 1; j < platformList.length; j++) {
      link(llmId(platformList[i]!), llmId(platformList[j]!), "shared-memory");
    }
  }

  const sessionStats = new Map<
    string,
    { platform: string; sessionId: string; hits: number; trips: number; ms: number; lastSeen: string }
  >();

  const rememberSession = (platform: string, sessionId: string, lastSeen: string) => {
    const id = sessionNodeId(platform, sessionId);
    const cur = sessionStats.get(id) ?? {
      platform,
      sessionId,
      hits: 0,
      trips: 0,
      ms: 0,
      lastSeen,
    };
    if (lastSeen > cur.lastSeen) cur.lastSeen = lastSeen;
    sessionStats.set(id, cur);
    return cur;
  };

  for (const s of input.sessions) {
    rememberSession(s.platform, s.session_id, s.last_seen);
  }

  for (const e of events) {
    const speed = speedForEvent(e);
    const sid = e.session_id || "unknown";
    const stat = rememberSession(e.platform || "unknown", sid, e.created_at);
    if (speed.kind === "local_hit") {
      stat.hits += 1;
      stat.ms += speed.estimatedMsSaved;
    } else {
      stat.trips += 1;
    }
  }

  const rankedSessions = [...sessionStats.values()]
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, 8);

  for (const s of rankedSessions) {
    const id = sessionNodeId(s.platform, s.sessionId);
    push({
      id,
      type: "session",
      label: shortSession(s.sessionId),
      detail: {
        platform: s.platform,
        sessionId: s.sessionId,
        hits: s.hits,
        trips: s.trips,
        estimatedMsSaved: s.ms,
        lastSeen: s.lastSeen,
      },
    });
    link(llmId(s.platform), id, "session");
  }

  const allowedSessions = new Set(rankedSessions.map((s) => sessionNodeId(s.platform, s.sessionId)));
  let tripCount = 0;
  let hitCount = 0;

  for (const e of events) {
    const speed = speedForEvent(e);
    const sid = sessionNodeId(e.platform || "unknown", e.session_id || "unknown");
    if (!allowedSessions.has(sid)) continue;
    let claimIds: string[] = [];
    try {
      claimIds = JSON.parse(e.claim_ids) as string[];
    } catch {
      claimIds = [];
    }

    if (speed.kind === "local_hit") {
      if (hitCount >= 12) continue;
      hitCount += 1;
      const id = `hit.${e.id}`;
      push({
        id,
        type: "local_hit",
        label: "local hit",
        detail: {
          query: e.query,
          created_at: e.created_at,
          platform: e.platform,
          localMs: speed.localMs,
          estimatedMsSaved: speed.estimatedMsSaved,
          estimatedTokensSaved: e.estimated_tokens_saved,
          anchorsCount: speed.anchorsCount,
          claimsCount: speed.claimsCount,
          claimIds,
        },
      });
      link(sid, id, "local");
      for (const claimId of claimIds.slice(0, 4)) {
        link(id, claimId, "used");
      }
    } else {
      if (tripCount >= 12) continue;
      tripCount += 1;
      const id = `trip.${e.id}`;
      push({
        id,
        type: "server_trip",
        label: "miss",
        detail: {
          query: e.query,
          created_at: e.created_at,
          platform: e.platform,
          note: "No keyword match. Fallback facts may still have been injected; the model call still happened.",
        },
      });
      link(sid, id, "trip");
      link(id, "server.remote", "trip");
      link(llmId(e.platform || "unknown"), "server.remote", "trip");
    }
  }

  const server = nodes.find((n) => n.id === "server.remote");
  if (server) {
    server.detail.trips = tripCount;
    server.detail.hits = hitCount;
  }

  return { nodes, links };
}
