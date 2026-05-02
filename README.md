# Plannotator (dzg fork)

Interactive plan and code review for AI coding agents. A persistent local daemon serves the annotation UI; the agent blocks on a CLI call until the user approves, denies, or cancels.

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

1. Shells out to `plannotator submit --json` which forwards the plan to the local daemon.
2. The daemon opens the browser on the local machine.
3. Blocks until the user acts in the UI.
4. On **approve**: returns a success string; if the user added annotations, they are included as implementation notes.
5. On **approve with agent switch**: additionally calls `session.prompt` with `noReply: true` to hand off to the target agent (e.g. `build`), and cycles the TUI display.
6. On **deny**: returns the user's structured feedback and instructs the agent to revise and resubmit.
7. On **cancel**: returns `"Plan review cancelled by user."`.
8. On **timeout**: returns a timeout message. The agent must call `submit_plan` again.

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

**Behavior:** Shells out to `plannotator review --json`. Returns immediately; a background task posts feedback back to the session via `session.prompt` once the review is complete. If the user cancels, the agent receives `"Code review cancelled by user."`.

---

#### `plannotator_annotate`

Opens a markdown file in the annotation UI. Non-blocking — same async feedback pattern as `plannotator_review`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | yes | Absolute or relative path to the markdown file |

**Behavior:** Shells out to `plannotator annotate <file> --json`. Feedback (inline annotations + global notes) is forwarded to the session asynchronously. On cancel: `"Annotation of {file_path} cancelled by user."`.

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

The `plannotator` CLI is invoked by a `PermissionRequest` hook on the `ExitPlanMode` tool. Claude Code pipes the hook event JSON to stdin; the CLI extracts the plan, forwards it to the local daemon via `plannotator submit`, and writes an approve/deny JSON decision to stdout when the daemon returns the verdict.

```
Claude Code → ExitPlanMode → PermissionRequest hook → plannotator CLI → daemon → browser UI
                                                       ↑ stdin JSON                verdict ↓
                                                       ← ← ← hook decision JSON ← ← ← ← ←
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

### Daemon lifecycle

The daemon is a persistent background process that owns the HTTP server and browser session. Start it once; it survives across multiple `submit` / `review` / `annotate` calls.

```bash
plannotator daemon start        # start daemon in background, print port + URL
plannotator daemon status       # show running/idle/not-running state
plannotator daemon stop         # graceful shutdown
```

Aliases: `plannotator start` / `plannotator stop` / `plannotator status`.

### CLI subcommands

```
plannotator daemon start [--foreground]   Start daemon (background by default)
plannotator daemon stop                   Stop daemon
plannotator daemon status                 Show daemon state

plannotator submit [file] [--mode plan|annotate] [--no-browser] [--commit-message <msg>] [--json]
                                          Submit a plan or markdown file for review
plannotator review [--diff-type <type>] [--json]
                                          Open current git diff in code review UI
plannotator annotate <file> [--json]      Open markdown file in annotation UI
plannotator wait [--json]                 Wait for a verdict from the current active session
plannotator clear [--force]               Reset daemon to idle state
plannotator open                          Reopen the active session in the browser
```

`--diff-type` values: `uncommitted` (default), `staged`, `unstaged`, `last-commit`, `branch`, `worktree:<branch>`.

`<file>` accepts an `@`-prefixed path (Claude Code file reference syntax); the `@` is stripped automatically.

The daemon binds to `localhost` only and opens the browser automatically. Port is random by default; set `PLANNOTATOR_PORT` to fix it.

### Plan history

Approved plans are saved to `~/.plannotator/plans/{project}/{slug}.md` where:
- `project` is derived from the git repo root directory name (sanitized)
- `slug` is `{first-heading-kebab-case}-YYYY-MM-DD`

The directory is a git repo. Each plan submission commits the current content; approve/deny events are recorded as additional empty commits with feedback in the message body.

### Obsidian integration

Enabled in the UI settings panel. When active, approved plans are also written to an Obsidian vault with YAML frontmatter (`created`, `source`, `tags`) and a `[[Plannotator Plans]]` backlink.

---

## Daemon HTTP API

The daemon exposes a REST API on `localhost`. The embedded UI and CLI both communicate with it.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/plan` | Returns plan content, version info, diff vs. previous version |
| `POST` | `/api/approve` | User approves; resolves the blocked CLI with `approved: true` |
| `POST` | `/api/deny` | User denies with feedback; resolves with `approved: false` |
| `GET` | `/api/status` | Returns daemon state (`idle`, `active`, `verdict_ready`) |
| `POST` | `/api/submit` | Submit a document (plan, review, annotate) to the daemon |
| `GET` | `/api/wait` | Long-poll for the verdict of the current active session |
| `POST` | `/api/clear` | Reset daemon to idle state |
| `GET` | `/api/diff` | Returns git diff for code review mode |
| `POST` | `/api/feedback` | Submit review/annotate feedback to the waiting CLI |
| `GET/POST/DELETE` | `/api/draft` | Auto-save annotation drafts |

The daemon survives CLI disconnections. If the agent process dies mid-review, run `plannotator wait` from a new terminal to collect the buffered verdict once the user acts in the browser.

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

- **Persistent daemon model**: replaces ephemeral per-invocation servers with a single background daemon process. The CLI shells out to the daemon; browser sessions survive CLI disconnections.
- **Buffered verdict recovery**: if the agent process dies mid-review, run `plannotator wait` from a fresh terminal to collect the verdict after the user acts. The daemon holds the result until consumed.
- **Thin agent wrappers**: the Claude Code hook shim and OpenCode plugin both shell out to the `plannotator` CLI instead of hosting embedded servers. Agent-specific policy stays in the integration layer; the daemon is general-purpose.
- **`--version` / `--help`**: compiled binary now exits 0 on both flags and prints the workspace version string.
- **`--json` output mode**: `submit`, `review`, `annotate`, and `wait` accept `--json` to emit structured verdict JSON for programmatic consumers.
- **Cancel / Reset UI actions**: Cancel button resolves the blocked CLI immediately; Reset button clears draft annotations without ending the session.
- **Git-based plan versioning**: replaces file-numbered `001.md / 002.md` history with a single-file-per-slug git repo under `~/.plannotator/plans/{project}/`.
- **`commit_message` parameter on `submit_plan`**: agents document what changed since the previous version.

Open issues for remaining work:
- [#9](https://github.com/dzackgarza/plannotator-dzg-fork/issues/9) — Thread agent identity into git commit authorship
