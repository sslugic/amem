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

## Steps

1. Check binding:
   ```bash
   amem status
   ```
   If uninitialized, stop and ask the user to run `amem init`.

2. Draft a small proposal JSON (prefer `/tmp/amem-update-<date>.json`) with only new or corrected durable claims. Prefer updating existing claim ids when correcting prior memory.

3. Every claim must include at least one `code_anchors` path that exists in the repo.

4. Validate and apply:

```bash
amem propose validate /tmp/amem-update-<date>.json
amem propose apply /tmp/amem-update-<date>.json
```

5. Optionally verify:

```bash
amem context "<short keywords from the new claims>"
```

6. Reply briefly with how many claims/flows/components were saved. Keep claim text out of chat unless the user asks.
