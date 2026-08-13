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
2. From a checkout of the amem tool (or after npm link / global install), run:
   ```bash
   npm install -g .
   # or: npm link
   amem init --platform <cursor|claude>
   amem doctor
   amem status
   ```
   If amem is already on PATH, skip install and just run init/doctor/status.
3. Prefer the `amem-bootstrap` skill to seed a small baseline proposal, then:
   ```bash
   amem propose validate <proposal.json>
   amem propose apply <proposal.json>
   amem context "What should I know before changing this repository?"
   ```
4. Confirm in one short paragraph: platform installed, DB path, claim count, and that memory is local-only.
5. Suggest `amem ui` — it opens Setup, scans local git repos to pick what to track, and can install a login item so the UI starts after reboot (localhost only).

Do not echo proprietary prompting strategy into claims. Store only durable repo facts with file anchors.
`````
