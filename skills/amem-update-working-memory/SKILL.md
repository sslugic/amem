---
description: Save durable learnings from the current session into local personal amem memory.
---

# amem-update-working-memory

Extract durable engineering facts from this session and store them in local amem memory.

## Privacy

- Write only to the local amem database via the CLI.
- Do not create shared docs, PRs, or commits that contain memory contents.
- Do not store secrets, tokens, credentials, or private personal data.
- Do not store proprietary company LLM instruction text — only durable repo facts (constraints, ownership, gotchas, workflows).

After useful exploratory or implementation work that produced durable knowledge about this repository.

Usage logging: every `amem context` call already records an estimated token savings event locally. If you later know a better avoided-token number from the agent UI, you may run:

```bash
amem usage report --platform <cursor|claude> --saved <n>
```

Session-end / miss→learn drafts may already be waiting in Memory (`amem ui`). Prefer approving those when they match this session; use this skill for higher-quality curated claims.

## Steps

1. Check binding:
   ```bash
   amem status
   ```
   If uninitialized, stop and ask the user to run `amem init` (or `amem setup`).

2. Draft a small proposal JSON (prefer `/tmp/amem-update-<date>.json`) with only new or corrected durable claims. Prefer updating existing claim ids when correcting prior memory. When a new claim replaces an old one under a **new** id, set `"supersedes": ["claim.old_id"]` (or an edge with `kind: "supersedes"`) so the old claim leaves retrieval.

3. Every claim must include at least one `code_anchors` path that exists in the repo. Prefer kinds `constraint`, `gotcha`, `owner`, `howto`, `structure`. If validate prints **conflict warnings** (shared anchors + similar text), resolve them with `supersedes` or by updating the existing id.

4. Validate, preview, and apply:

```bash
amem propose validate /tmp/amem-update-<date>.json
amem propose diff /tmp/amem-update-<date>.json
amem propose apply /tmp/amem-update-<date>.json
```

5. Optionally verify:

```bash
amem context "<short keywords from the new claims>"
```

Confirm the packet shows **Why:** ranking factors and that new claims appear.

6. Reply briefly with how many claims/flows/components were saved. Keep claim text out of chat unless the user asks.
