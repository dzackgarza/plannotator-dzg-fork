# Plannotator (dzg fork)

Interactive plan and code review for AI coding agents. Exposes a local HTTP server with an annotation UI; the agent blocks on a tool call until the user approves, denies, or cancels.

This is a personal fork of [backnotprop/plannotator](https://github.com/backnotprop/plannotator) with additional features tracked on this branch.

---

## Installation (this fork)

This fork is not published to npm or the Claude Code plugin marketplace. Install from source:

```bash
git clone https://github.com/dzackgarza/plannotator-dzg-fork.git
cd plannotator-dzg-fork
bun install
bun run build:review    # build review UI (embedded by hook build)
bun run build:hook      # build plan/annotate UI
bun run build:opencode  # build OpenCode plugin
bun build apps/hook/server/index.ts --compile --outfile plannotator
cp plannotator ~/.local/bin/plannotator
```

Verify: `plannotator --version`

**Claude Code hook** — register in `~/.claude/settings.json` (see [Claude Code hook](#claude-code-hook)).

**OpenCode plugin** — point `opencode.json` at the built plugin directory:

```json
{
  "plugin": ["file:///absolute/path/to/plannotator-dzg-fork/apps/opencode-plugin"]
}
```

## Environment variables

All integrations share the same `plannotator` CLI binary, so these variables apply everywhere:

| Variable | Default | Description |
|---|---|---|
| `PLANNOTATOR_PORT` | random | Fixed port for the local HTTP server |
| `PLANNOTATOR_BROWSER` | system default | Browser to open (macOS: app name; Linux/Windows: executable path) |
| `PLANNOTATOR_PLAN_TIMEOUT_SECONDS` | `345600` (96 hours) | Seconds to wait for a `submit_plan` decision before auto-rejecting. Set to `0` to disable. |

---

## Integrations

- [OpenCode plugin](#opencode-plugin) — `submit_plan`, `plannotator_review`, `plannotator_annotate` tools
- [Claude Code hook](#claude-code-hook) — `ExitPlanMode` interceptor

---

## OpenCode plugin

### Tools exposed to the agent

All three tools are registered as **primary-only** (visible to the top-level agent, hidden from sub-agents). The plugin enforces this by appending them to `experimental.primary_tools` in the OpenCode config on startup.

---

#### `submit_plan`

Blocks the agent until the user approves or rejects the plan in the browser UI.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `plan` | string | yes | Complete implementation plan in markdown |
| `summary` | string | yes | One- or two-sentence summary of what the plan accomplishes |
| `commit_message` | string | yes | What changed since the previous version; references addressed feedback on revisions |

**Behavior:**

1. Starts a local HTTP server serving the plan annotation UI.
2. Opens the browser on the local machine.
3. Blocks `waitForDecision()` until the user acts.
4. On **approve**: returns a success string; if the user added annotations, they are included as implementation notes.
5. On **approve with agent switch**: additionally calls `session.prompt` with `noReply: true` to hand off to the target agent (e.g. `build`), and cycles the TUI display.
6. On **deny**: returns the user's structured feedback and instructs the agent to revise and resubmit.
7. On **cancel**: returns `"Plan review cancelled by user."`.
8. On **timeout**: returns a timeout message and releases the port. The agent must call `submit_plan` again.

The server shuts down deterministically via `POST /api/shutdown` sent by the UI after the user acts. A 10-second fallback `setTimeout` stops the server if the UI disconnects without calling shutdown.

**Plan history:** Each submission saves `~/.plannotator/plans/{project}/{slug}.md` and commits it to a git repo in that directory. The commit message comes from `commit_message`. Approve/deny events are recorded as empty git commits with feedback in the message body.

---

#### `plannotator_review`

Opens the current git diff in a code review UI. The agent does not block — feedback is forwarded to the session asynchronously after the user submits.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `diff_type` | enum | no | Which diff to show. Default: `uncommitted` |

**`diff_type` values:**

| Value | Git command equivalent |
|---|---|
| `uncommitted` | `git diff HEAD` (staged + unstaged) |
| `staged` | `git diff --cached` |
| `unstaged` | `git diff` |
| `last-commit` | `git diff HEAD~1 HEAD` |
| `branch` | `git diff {default-branch}...HEAD` |

**Behavior:** The tool returns immediately after starting the server. A background IIFE posts the user's feedback back to the session via `session.prompt` once the review is complete. If the user cancels, the agent receives `"Code review cancelled by user."`.

---

#### `plannotator_annotate`

Opens a markdown file in the annotation UI. Non-blocking — same async feedback pattern as `plannotator_review`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | yes | Absolute or relative path to the markdown file |

**Behavior:** Reads the file, serves it in the annotation UI. Feedback (inline annotations + global notes) is forwarded to the session asynchronously. On cancel: `"Annotation of {file_path} cancelled by user."`.

---

### System prompt injection

The plugin injects planning instructions into the system prompt via `experimental.chat.system.transform`. Injection is **skipped** when:

- The session is a title-generation request (system prompt contains `"title generator"` or `"generate a title"`)
- The most recent user message's agent cannot be determined
- The agent is `"build"` (hardcoded exclusion)
- The agent's `mode` field is `"subagent"` (checked via `app.agents()`)

The injected text instructs the agent to call `submit_plan` before implementation and not to proceed until approved.

---

### Slash command

`/plannotator-review` — Triggers a code review for uncommitted changes in the current session. Implemented via the `event` handler listening for `command.executed` or `tui.command.execute` events with `name === "plannotator-review"`.

---

## Claude Code hook

### How it works

The `plannotator` CLI is invoked by a `PermissionRequest` hook on the `ExitPlanMode` tool. Claude Code pipes the hook event JSON to stdin; the CLI reads the plan content, serves the UI, and writes an approve/deny JSON decision to stdout.

```
Claude Code → ExitPlanMode → PermissionRequest hook → plannotator CLI (stdin/stdout)
```

**Decision output format:**

Approve:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow", "updatedPermissions": [...] }
  }
}
```

Deny:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "deny", "message": "YOUR PLAN WAS NOT APPROVED. ..." }
  }
}
```

### Installation

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          { "type": "command", "command": "plannotator", "timeout": 345600 }
        ]
      }
    ]
  }
}
```

### CLI subcommands

```
plannotator                   Plan review (default — reads hook event from stdin)
plannotator review            Code review (uncommitted changes)
plannotator annotate <file>   Markdown annotation
plannotator sessions          List active server sessions
plannotator sessions --open [N]  Reopen session N in browser
plannotator sessions --clean  Remove stale session files
```

`<file>` accepts an `@`-prefixed path (Claude Code file reference syntax); the `@` is stripped automatically.

### Server ports

| Mode | Default port | Remote default |
|---|---|---|
| Plan review | Random ephemeral | `19432` |
| Code review | Random ephemeral | random |
| Annotate | Random ephemeral | random |

The server binds to `localhost` only and opens the browser automatically.

### Plan history

Approved plans are saved to `~/.plannotator/plans/{project}/{slug}.md` where:
- `project` is derived from the git repo root directory name (sanitized)
- `slug` is `{first-heading-kebab-case}-YYYY-MM-DD`

The directory is a git repo. Each plan submission commits the current content; approve/deny events are recorded as additional empty commits with feedback in the message body.

### Obsidian integration

Enabled in the UI settings panel. When active, approved plans are also written to an Obsidian vault with YAML frontmatter (`created`, `source`, `tags`) and a `[[Plannotator Plans]]` backlink.

---

## Server HTTP API

All server types expose the same API surface. The embedded UI communicates with `localhost` only.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Serves the embedded UI (SPA) |
| `GET` | `/api/plan` | Returns plan content, version info, diff vs. previous version |
| `POST` | `/api/approve` | User approves; resolves `waitForDecision()` with `approved: true` |
| `POST` | `/api/deny` | User denies with feedback; resolves with `approved: false` |
| `POST` | `/api/cancel` | User cancels; resolves with `cancelled: true`; stops server |
| `POST` | `/api/reset` | Clears draft annotation state; session continues |
| `POST` | `/api/shutdown` | UI signals server to stop after response is flushed |

Signal handling: `SIGINT` and `SIGTERM` resolve `waitForDecision()` with `cancelled: true` and stop the server. All shutdown paths (UI, signal, returned `stop()`) call the same `cleanup()` function so signal listeners are always unregistered.

---

## Plan version storage

```
~/.plannotator/
  plans/
    {project}/          ← git repo (one per project)
      {slug}.md         ← single file per plan slug
```

Git history tracks every version. `git log -- {slug}.md` shows all revisions with commit messages from the agent. Approve/deny events are empty commits with feedback in the body.

The `slug` format is `{heading-kebab}-YYYY-MM-DD`. If the plan has no heading, the slug is `plan-YYYY-MM-DD`.

---

## Fork-specific changes (vs. upstream)

- **Deterministic server teardown**: all shutdown paths (`/api/shutdown`, SIGINT/SIGTERM, `stop()`) call a shared `cleanup()` function — no bare `setTimeout` as the primary stop mechanism.
- **Cancel / Reset UI actions**: Cancel button resolves `waitForDecision()` immediately and frees the port; Reset button clears draft annotations without ending the session.
- **Git-based plan versioning**: replaces file-numbered `001.md / 002.md` history with a single-file-per-slug git repo under `~/.plannotator/plans/{project}/`.
- **`commit_message` parameter on `submit_plan`**: agents document what changed since the previous version.
- **Signal cleanup fix**: `/api/shutdown` now runs the same `cleanup()` as `stop()`, preventing stale SIGINT/SIGTERM listeners across multiple server starts.
Open issues for remaining work:
- [#9](https://github.com/dzackgarza/plannotator-dzg-fork/issues/9) — Thread agent identity into git commit authorship
