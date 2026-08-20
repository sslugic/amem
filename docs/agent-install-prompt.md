# Agent install prompt (amem)

Paste this into Cursor or Claude Code from inside the repository you want remembered:

`````txt
Install local personal amem memory for this repo.

Privacy rules (non-negotiable):
- Memory must stay on this machine under ~/.amem
- Do not write memory contents into the product git history
- Do not create PRs or shared docs that contain memory claims
- Do not upload or sync memory anywhere

Steps:
1. Ask me whether the platform is `cursor` or `claude` (pick the agent you are).
   Other hosts also work: windsurf | continue | aider | zed.
2. From a checkout of the amem tool (or after npm link / global install), run:
   ```bash
   npm install -g .
   # or: npm link
   amem setup --personal
   amem init --platform <cursor|claude>
   amem doctor
   amem status
   ```
   If amem is already on PATH, skip install and just run setup/init/doctor/status.
3. Prefer the `amem-bootstrap` skill to seed a small baseline proposal, then:
   ```bash
   amem propose validate <proposal.json>
   amem propose diff <proposal.json>
   amem propose apply <proposal.json>
   amem context "What should I know before changing this repository?"
   ```
4. Confirm in one short paragraph: platform installed, DB path, claim count, and that memory is local-only.
5. Suggest `amem ui` — Setup scans local git repos; Brain shows pending session / miss→learn drafts (approve/dismiss), edit/pin/delete; optional login service keeps the UI on localhost after reboot.
6. Optional: `amem init --personal` for cross-repo prefs; `amem lock` / `amem backup schedule` for encrypt-at-rest and local encrypted backups (still no cloud).
7. Every MCP host must follow the remember contract (`amem recipe` or docs/remember-contract.md): call `amem_context` first, then `amem_remember` after durable outcomes. Do not treat a successful read as a substitute for writing.

Do not echo proprietary prompting strategy into claims. Store only durable repo facts with file anchors.
When correcting an old fact under a new claim id, use `"supersedes": ["claim.old_id"]`.
`````
