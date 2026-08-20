---
description: Seed local personal amem memory for the current repository from durable repo structure facts.
---

# amem-bootstrap

Create an initial local memory proposal for this repository.

## Privacy

Memory is personal and stored only under `~/.amem` on this machine. Do not commit proposal files, exports, or database copies to shared git remotes.

## Steps

1. Confirm amem is initialized:
   ```bash
   amem status
   ```
   If not initialized, ask the user which platform (`cursor` or `claude`) and run `amem init --platform <platform>`.

2. Inspect the repo at a high level (README, top-level dirs, obvious entrypoints). Do not dump proprietary prompt strategy into claims.

3. Write a proposal JSON file (for example `/tmp/amem-bootstrap.json`) with durable facts only:
   - `components`: major subsystems with optional `code_anchor`
   - `flows`: important workflows
   - `claims`: concrete facts with at least one `code_anchors` path each
   - `edges`: link claims→flows and flows→components when useful

Example shape:

```json
{
  "components": [
    { "id": "component.api", "name": "HTTP API", "code_anchor": "src/api" }
  ],
  "flows": [
    { "id": "flow.request_lifecycle", "name": "Request lifecycle" }
  ],
  "claims": [
    {
      "id": "claim.api_entry",
      "kind": "structure",
      "text": "HTTP handlers live under src/api.",
      "code_anchors": ["src/api"]
    }
  ],
  "edges": [
    {
      "from_id": "claim.api_entry",
      "from_type": "claim",
      "to_id": "flow.request_lifecycle",
      "to_type": "flow",
      "kind": "about"
    },
    {
      "from_id": "flow.request_lifecycle",
      "from_type": "flow",
      "to_id": "component.api",
      "to_type": "component",
      "kind": "uses"
    }
  ]
}
```

When correcting a prior fact under a new claim id, include `"supersedes": ["claim.old_id"]` so the old claim is archived locally.

4. Validate and apply locally:

```bash
amem propose validate /tmp/amem-bootstrap.json
amem propose apply /tmp/amem-bootstrap.json
amem context "What should I know before changing this repository?"
```

5. Tell the user in one line that baseline local memory was applied. Do not print the full proposal unless asked.
