---
name: amem-write-skill
description: Write a durable procedure from this session into local amem skills.
---

# amem-write-skill

Turn a non-trivial workflow you just worked out into a reusable skill stored in local amem.

Use this when an amem context packet shows a **Worth saving as a skill** or **Skill worth
revising** nudge, or when you notice on your own that you solved something worth repeating.

## Privacy

- Skills are stored locally under `~/.amem/skills` and never leave this machine.
- Do not store secrets, tokens, credentials, connection strings, or private personal data.
  amem scans content and will refuse writes that look like credentials.
- Do not paste proprietary company LLM instructions — write the procedure, not the prompt.

## When to write one

Write a skill when at least one of these is true:

- You worked out a multi-step workflow that will come up again.
- You hit errors or dead ends and found the path that actually works.
- The user corrected your approach and the correction generalizes.

Do **not** write a skill for a one-off fix, a single command, or anything already obvious
from the repo's README. A small durable fact belongs in memory (`amem_remember`), not here.
The split: memory holds facts that should always be in context; skills hold procedures that
should load only when relevant.

## Steps

1. Check what already exists so you update instead of duplicating:

   ```bash
   amem skills list
   ```

   If a related skill exists, load it and revise it rather than writing a second one:

   ```bash
   amem skills show <name>
   ```

2. Draft the SKILL.md. Keep the description under about 80 characters — it is the only
   thing agents see until they load the body, so it must say *when to use this*, not just
   what it is.

3. Save it with the `amem_skill_save` MCP tool, passing `name`, `description`, and
   `content`. Prefer that over writing files directly so the content scan runs.

## Format

```markdown
---
name: deploy-staging
description: Deploy the staging server and verify the health endpoint
tags: [deploy, staging]
---

# Deploy Staging

## When to use
Trigger conditions — the situation where this procedure applies.

## Procedure
1. Concrete step with the real command.
2. Next step.

## Pitfalls
- The dead end you hit, and what got you past it.

## Verification
How to confirm it actually worked.
```

## Pitfalls

- **Vague descriptions.** "Helps with deploys" is useless for ranking. Name the trigger.
- **Transcribing the chat.** Write the procedure that worked, not the exploration that led
  to it. Skip the wrong turns except as entries under Pitfalls.
- **Inventing steps.** Only include commands you actually ran and saw work.
- **Duplicates.** Revising an existing skill beats adding a near-copy.

## Verification

```bash
amem skills list          # your skill appears with its description
amem skills show <name>   # body reads as a procedure someone else could follow
```

If a write is staged instead of saved, an approval gate is on. Review it with:

```bash
amem skills drafts
amem skills approve <draft-id>
```
