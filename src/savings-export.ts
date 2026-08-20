import { estimateUsdSaved, USD_PER_MILLION_INPUT_TOKENS } from "./estimate.js";

export type SavingsExportInput = {
  scope: string;
  days: number;
  repoName?: string;
  generatedAt?: string;
  aggregate: {
    pricing?: { usdPerMillionInputTokens?: number; basis?: string };
    totals?: {
      queries?: number;
      estimatedTokensSaved?: number;
      estimatedUsdSaved?: number;
      estimatedMsSaved?: number;
      localHits?: number;
      serverTrips?: number;
      hitRate?: number;
      avgLocalMs?: number | null;
      anchorsAvoided?: number;
    };
    monthly?: {
      estimatedTokensSaved?: number;
      estimatedUsdSaved?: number;
      estimatedMsSaved?: number;
      queries?: number;
      sampleQueries?: number;
      trendDays?: number;
    };
    byPlatform?: Array<{
      platform: string;
      queries: number;
      estimatedTokensSaved: number;
      estimatedUsdSaved?: number;
      localHits?: number;
      serverTrips?: number;
    }>;
  };
};

export type SavingsExportJson = SavingsExportInput & {
  disclaimer: string;
  filenameBase: string;
};

function stamp(iso?: string): string {
  return (iso || new Date().toISOString()).replace(/[:.]/g, "-").slice(0, 19);
}

export function savingsDisclaimer(): string {
  return "Proxy for avoided file reads / input tokens — not a Cursor or model bill. Money uses estimated tokens × $3/1M input (Sonnet-class). Hit rate counts keyword matches only.";
}

export function buildSavingsExport(input: SavingsExportInput): SavingsExportJson {
  const generatedAt = input.generatedAt || new Date().toISOString();
  const filenameBase = `amem-savings-${input.scope}-${input.days}d-${stamp(generatedAt)}`;
  return {
    ...input,
    generatedAt,
    pricing: {
      usdPerMillionInputTokens:
        input.aggregate.pricing?.usdPerMillionInputTokens ?? USD_PER_MILLION_INPUT_TOKENS,
      basis: input.aggregate.pricing?.basis ?? "input",
    },
    disclaimer: savingsDisclaimer(),
    filenameBase,
  } as SavingsExportJson;
}

export function formatSavingsMarkdown(report: SavingsExportJson): string {
  const t = report.aggregate.totals ?? {};
  const m = report.aggregate.monthly ?? {};
  const platforms = report.aggregate.byPlatform ?? [];
  const hit = t.hitRate != null ? `${Math.round(t.hitRate * 100)}%` : "—";
  const lines = [
    `# amem savings report`,
    ``,
    `- Scope: ${report.scope}${report.repoName ? ` (${report.repoName})` : ""}`,
    `- Window: ${report.days} days`,
    `- Generated: ${report.generatedAt}`,
    `- Disclaimer: ${report.disclaimer}`,
    ``,
    `## Totals`,
    ``,
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Queries | ${t.queries ?? 0} |`,
    `| Keyword hits / misses | ${t.localHits ?? 0} / ${t.serverTrips ?? 0} |`,
    `| Hit rate | ${hit} |`,
    `| Est. tokens saved | ${t.estimatedTokensSaved ?? 0} |`,
    `| Est. USD saved | $${(t.estimatedUsdSaved ?? estimateUsdSaved(t.estimatedTokensSaved ?? 0)).toFixed(2)} |`,
    `| Est. time saved (ms) | ${t.estimatedMsSaved ?? 0} |`,
    `| Avg local lookup (ms) | ${t.avgLocalMs ?? "—"} |`,
    `| Anchors avoided | ${t.anchorsAvoided ?? 0} |`,
    ``,
    `## Monthly projection`,
    ``,
    `- Est. tokens / month: ${m.estimatedTokensSaved ?? 0}`,
    `- Est. $ / month: $${(m.estimatedUsdSaved ?? 0).toFixed(2)}`,
    `- From ${m.sampleQueries ?? 0} calls over ${m.trendDays ?? 0} day(s)`,
    ``,
    `## By host`,
    ``,
  ];
  if (platforms.length === 0) lines.push(`(no usage yet)`);
  for (const p of platforms) {
    lines.push(
      `- ${p.platform}: ${p.queries} queries, ~${p.estimatedTokensSaved} tokens, ~$${(p.estimatedUsdSaved ?? 0).toFixed(2)}, ${p.localHits ?? 0} hits / ${p.serverTrips ?? 0} misses`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(line: string, width = 88): string[] {
  if (line.length <= width) return [line || " "];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < 40) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Minimal single-font PDF for expense-review printouts (no extra dependency). */
export function buildTextPdf(title: string, body: string): Buffer {
  const wrapped = body.split("\n").flatMap((line) => wrapLine(line));
  const perPage = 58;
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += perPage) {
    pages.push(wrapped.slice(i, i + perPage));
  }
  if (pages.length === 0) pages.push([title]);

  const objs: string[] = [];
  const add = (bodyObj: string) => {
    objs.push(bodyObj);
    return objs.length;
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  const pageIds: number[] = [];
  const contentIds: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    contentIds.push(0);
    pageIds.push(0);
  }
  add("PLACEHOLDER_PAGES");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  for (let i = 0; i < pages.length; i++) {
    const lines = pages[i]!;
    const stream = [
      "BT",
      "/F1 11 Tf",
      "50 742 Td",
      "14 TL",
      ...lines.map((line, idx) => `${idx === 0 ? "" : "T* "}(${pdfEscape(line)}) Tj`),
      "ET",
    ].join("\n");
    const contentId = add(
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    );
    contentIds[i] = contentId;
    const pageId = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    pageIds[i] = pageId;
  }

  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(chunks.reduce((n, c) => n + c.length, 0));
    chunks.push(Buffer.from(`${i + 1} 0 obj\n${objs[i]}\nendobj\n`));
  }
  const xrefAt = chunks.reduce((n, c) => n + c.length, 0);
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(Buffer.from(xref));
  chunks.push(
    Buffer.from(
      `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

export function savingsPdf(report: SavingsExportJson): Buffer {
  return buildTextPdf("amem savings report", formatSavingsMarkdown(report));
}
