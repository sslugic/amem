/** Generic host recipe: read then write. Not tied to any one MCP client. */

export const REMEMBER_CONTRACT_VERSION = "1";

export const MCP_URL_TEMPLATE = "http://127.0.0.1:7843/mcp?workspace=<slug>";

export type RememberRule = {
  id: string;
  must: boolean;
  text: string;
};

export type RememberContract = {
  version: string;
  title: string;
  mcpUrlTemplate: string;
  tools: { name: string; role: "read" | "write" | "meta"; when: string }[];
  rules: RememberRule[];
  markdown: string;
  paste: string;
};

const TOOLS: RememberContract["tools"] = [
  {
    name: "amem_context",
    role: "read",
    when: "Before exploring files or sending a large prompt. Pass workspace=<slug>.",
  },
  {
    name: "amem_remember",
    role: "write",
    when: "After a durable outcome: a decision, constraint, owner, or gotcha that should survive this chat.",
  },
  {
    name: "amem_recipe",
    role: "meta",
    when: "If you are unsure when to read or write — fetch this contract.",
  },
];

const RULES: RememberRule[] = [
  {
    id: "read-first",
    must: true,
    text: "Call amem_context at the start of a task. Do not treat a successful read as a substitute for writing later.",
  },
  {
    id: "write-outcomes",
    must: true,
    text: "Call amem_remember when the user confirms a durable fact, or when you discover a constraint that the next session will need.",
  },
  {
    id: "local-only",
    must: true,
    text: "Memory stays on this machine under ~/.amem. Do not upload claims, paste them into shared docs, or commit them to product git.",
  },
  {
    id: "no-secrets",
    must: true,
    text: "Never remember passwords, API keys, tokens, or private key material.",
  },
  {
    id: "no-prompt-strategy",
    must: true,
    text: "Store repo or workspace facts with file anchors — not proprietary prompting strategy.",
  },
  {
    id: "workspace",
    must: true,
    text: "Named workspaces are not git repos. Always pass the workspace slug on context and remember.",
  },
];

function renderMarkdown(): string {
  const toolLines = TOOLS.map((t) => `- \`${t.name}\` (${t.role}) — ${t.when}`).join("\n");
  const ruleLines = RULES.map((r) => `- ${r.must ? "Must:" : "Should:"} ${r.text}`).join("\n");
  return `# amem remember contract (v${REMEMBER_CONTRACT_VERSION})

Generic MCP host recipe. Same tools for every client — do not fork per product.

## Connect

Keep \`amem ui\` running, then attach:

\`${MCP_URL_TEMPLATE}\`

GUI hosts often cannot see Homebrew on PATH. Prefer the HTTP URL over a bare \`amem\` command.

## Tools

${toolLines}

## Rules

${ruleLines}

## Example

1. \`amem_context\` query="What should I know before changing auth?" workspace=my-app
2. Do the work, verify files.
3. \`amem_remember\` text="Auth mode is checked in src/auth.ts before Drive sync" workspace=my-app kind=constraint anchors=["src/auth.ts"]
`;
}

function renderPaste(): string {
  return `amem remember contract v${REMEMBER_CONTRACT_VERSION}

Connect (any MCP host): ${MCP_URL_TEMPLATE}
Keep amem ui running. Do not use a bare amem command from GUI apps.

Every task:
1. amem_context — read local memory first (pass workspace=<slug>)
2. Do the work
3. amem_remember — write durable outcomes (decisions, constraints, owners, gotchas)

Never: upload memory, commit claims to product git, store secrets, or store prompting strategy.
Facts stay in ~/.amem on this machine.

If unsure, call amem_recipe.`;
}

export function rememberContract(): RememberContract {
  return {
    version: REMEMBER_CONTRACT_VERSION,
    title: "amem remember contract",
    mcpUrlTemplate: MCP_URL_TEMPLATE,
    tools: TOOLS,
    rules: RULES,
    markdown: renderMarkdown(),
    paste: renderPaste(),
  };
}

export function rememberContractMustIds(): string[] {
  return RULES.filter((r) => r.must).map((r) => r.id);
}
