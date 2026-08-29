---
description: Manage deferred tasks and Kanban lifecycle in local personal amem memory so work is preserved across sessions and available for context retrieval.
---

# amem-tasks

Track deferred work, multi-step progress, and backlog items in local amem memory so tasks never get lost across chat sessions.

## Privacy

Memory is personal and stored under `~/.amem` on this machine. Tasks stay local and are never committed to remote repositories.

## When to Use

1. **Multi-step work**: When working on complex tasks or features with 3+ steps, create and manage tasks to track progress.
2. **Deferred work**: When user or agent identifies follow-up work ("do X later", "verify Y after deploy", "refactor Z next week"), add it to the project backlog.
3. **Session continuity & handoff**: Before ending a session or moving to a new topic, park unfinished items on the board.
4. **Context retrieval**: Check `amem_task_list` or context packet `## Open tasks` / `## Tasks` to review current and completed work.

## Task Status Lifecycle

- `backlog` — Queued items, follow-ups, and ideas.
- `next` — Prioritized tasks ready to start soon.
- `doing` — Currently in progress (keep 1 active task at a time).
- `blocked` — Stalled on external feedback, bug, or dependency.
- `done` — Finished work (retained for context retrieval and history).

## Available Tools

### 1. MCP Tools (Cursor, Claude Code, Windsurf, Continue, Zed)

- **`amem_task_add`**
  ```json
  {
    "title": "Add rate limiter middleware to /api/auth",
    "body": "Protect login endpoints against brute-force attempts",
    "status": "backlog",
    "anchors": ["src/api/auth.ts"]
  }
  ```

- **`amem_task_list`**
  ```json
  {
    "status": "doing",
    "include_done": true
  }
  ```

- **`amem_task_update`**
  ```json
  {
    "id": "task_1234abcd",
    "status": "doing",
    "body": "Updated progress notes..."
  }
  ```

- **`amem_task_complete`**
  ```json
  {
    "id": "task_1234abcd"
  }
  ```

### 2. CLI Commands (Terminal, Aider, Bash scripts)

- **List tasks**:
  ```bash
  amem task list
  amem task list --status doing
  amem task list --include-done --all
  ```

- **Add task**:
  ```bash
  amem task add "Add rate limiter middleware" --body "Protect /api/auth" --status backlog --anchor src/api/auth.ts
  ```

- **Update task**:
  ```bash
  amem task update <id> --status doing
  ```

- **Complete task**:
  ```bash
  amem task complete <id>
  ```

- **Delete task**:
  ```bash
  amem task delete <id>
  ```

## Instructions for Agents

1. **Deconstruct**: When starting a non-trivial user request, add the plan items to `amem_task_add`.
2. **Track**: Mark the current working task as `doing` with `amem_task_update`.
3. **Complete**: When a task is finished, call `amem_task_complete` immediately. Completed tasks stay stored in local memory and are searchable in context retrieval.
4. **Learn**: If completing the task revealed durable repository facts (constraints, gotchas, ownership), save them with `amem_remember` or `amem-update-working-memory`.
