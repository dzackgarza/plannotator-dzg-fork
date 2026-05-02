# Tests

This directory holds two kinds of tests:

1. The **NIM-13..NIM-21 proof suite** — the executable acceptance gate that
   the local-daemon refactor (sprint NIM-1) hangs off of.
2. **Manual testing scripts** under `manual/` for browser-driven UI checks
   and SSH port-forwarding scenarios.

The proof suite is the part that gates merges. Manual scripts are situational.

---

## Proof harness (NIM-12)

`tests/nim-13.*` through `tests/nim-21.*` are the per-slice proof files for
NIM-1's implementation slices. They are TDD gates — the proof file is written
first, then implementation is delivered until the proof passes.

### Policy: real fixtures, real backends, no mocks

Every proof in this directory follows a strict no-fake-it rule:

- **No mocks.** No `jest.fn()`, no manual stub modules, no monkey-patched
  `fetch`. Tests speak HTTP to a real server, signal real PIDs, read real
  lockfiles, and watch real files appear on disk.
- **No synthetic substitute backends.** If the proof says "the daemon
  routes a plan submission and a wait command," the proof spawns the real
  daemon binary, runs the real CLI commands, and asserts on the real
  state file the daemon wrote.
- **No glue-only tests.** A proof must close a loop a user can observe:
  the CLI exit code, a JSON file the daemon wrote, an HTTP response a
  browser would receive, a process actually exiting.
- **Real fixtures, real commands.** Plan markdown comes from
  `tests/helpers/fixtures.ts`. Builds run `bun run build:hook`,
  `bun run build:review`, etc. Git fixtures run `git init` and `git commit`.
- **Frozen contract.** Once a proof file is in tree, the implementation
  writer for the matching slice **must not edit it**. The proof is the
  contract; the implementation conforms to it. If the proof is wrong,
  open a follow-up to fix it — do not edit it during the implementation
  PR. (Gate-running NIM-12 owns the harness; implementation slices own
  their `packages/server` code.)

### Running the proofs

Single suite:

```bash
bun test tests/nim-17.submit-wait-proof.test.ts
```

All suites with the umbrella gate:

```bash
./scripts/run-proofs.sh          # NIM-13..NIM-21 in order
./scripts/run-proofs.sh 17 21    # only NIM-17 and NIM-21
./scripts/run-proofs.sh --bail   # stop at first failure
```

The gate exits 0 only when every selected suite passes. NIM-11 (final
verification) consumes the per-suite verdict line emitted in the summary
block.

`bun install` must have been run at the repo root before any proof can
execute — several proofs `cpSync` the workspace into a temp dir and
symlink the existing `node_modules`. Build proofs (NIM-13, NIM-21) shell
out to `bun run build:hook` etc., so they take a few minutes.

### Adding a new proof

Naming convention: `tests/nim-<id>.<short-slug>-proof.test.ts`. The
filename is what the gate script registers, so add a new entry to the
`SUITES` array in `scripts/run-proofs.ts` whenever a new proof lands.

Structure:

1. Probe for the surface under test. If the implementation isn't in the
   tree yet, fail the first test with a clear message naming the missing
   export — the rest of the suite stays gated until the surface lands.
2. Use helpers from `tests/helpers/` rather than re-rolling
   `mkdtempSync` + `afterAll` cleanup, `spawn` + stdout capture,
   `waitForCondition`, etc. The helpers exist precisely so future
   proofs do not duplicate this scaffolding.
3. Each `test(...)` should drive a real artifact end-to-end and assert
   on a user-observable signal — not the absence of an internal call.

### Shared helpers (`tests/helpers/`)

| Module | Provides |
|---|---|
| `paths.ts` | `repoRoot`, `bunExecutable`, `noopBrowserExecutable()` |
| `tempdir.ts` | `createTempDir(prefix)`, `cleanupTrackedTempDirs()` |
| `wait.ts` | `waitForCondition()`, `waitForResult()` |
| `process.ts` | `spawnCommand()`, `runCommand()`, `assertCommandSucceeded()`, `terminateIfRunning()`, `isPidAlive()`, `CommandResult`, `RunningCommand` |
| `workspace.ts` | `createDisposableWorkspace()`, `assertLocalDependenciesPresent()` |
| `cli.ts` | `runCli()`, `spawnCli()`, `cliEnv()` |
| `daemon.ts` | `readLockfilePid()`, `waitForDaemonReady()`, `killAndWait()`, `forceCleanupLockedDaemon()` |
| `sessions.ts` | `sessionsDir()`, `readSessions()`, `waitForActiveSession()`, `SessionInfo` |
| `state.ts` | `statePathForHome()`, `readPersistedState()`, `writePersistedState()` |
| `fixtures.ts` | `createPlanMarkdownFixture()`, `createSubmitPlanStdin()`, `createMarkdownNoteFixture()` |
| `http.ts` | `postPlanApproval()`, `postPlanDenial()`, `postReviewFeedback()`, `getPlan()`, `getDiff()` |

Import via the barrel: `import { runCli, createTempDir } from "./helpers";`

The existing NIM-13..NIM-21 files were written before the helpers module
landed, so they each define local copies. **Don't edit them to switch
to the helpers.** They are frozen contracts. Future proofs (NIM-22+)
should consume the helpers directly.

### Mapping: proof file → implementation slice

| Proof file | Slice | Surface under test |
|---|---|---|
| `nim-13.remote-surface-proof.test.ts` | NIM-2 | Remote/share code is gone, local builds stay green |
| `nim-14.state-machine-proof.test.ts`  | NIM-3 | `packages/server/state.ts` transitions and persistence |
| `nim-15.multiplexed-router-proof.test.ts` | NIM-4 | `packages/server/daemon-router.ts` HTTP surface |
| `nim-16.daemon-lifecycle-proof.test.ts` | NIM-5 | `packages/server/daemon.ts` start/stop/status/recover |
| `nim-17.submit-wait-proof.test.ts` | NIM-6 | submit/wait path through the daemon router |
| `nim-18.cli-contract-proof.test.ts` | NIM-7 | `plannotator` CLI subcommands and exit codes |
| `nim-19.notification-proof.test.ts` | NIM-8 | `packages/server/notify.ts` desktop notifications |
| `nim-20.agent-wrapper-proof.test.ts` | NIM-9 | hook + opencode plugin envelope shapes |
| `nim-21.build-packaging-proof.test.ts` | NIM-10 | `bun run build`, CLI binary packaging |

---

## Manual testing scripts

These run a real browser and require human inspection. They are not part
of the automated gate.

**Plan review UI** (`manual/local/`):

```bash
./tests/manual/local/test-hook.sh          # Claude Code simulation
./tests/manual/local/test-hook-2.sh        # OpenCode origin badge test
```

**Code review UI:**

```bash
./tests/manual/local/test-opencode-review.sh    # Code review UI test
./tests/manual/local/test-worktree-review.sh    # Worktree support (creates 4-worktree sandbox)
```

See [UI-TESTING.md](./UI-TESTING.md) for the detailed UI testing checklist.

**Integration & utilities** (`manual/local/`):

```bash
./tests/manual/local/test-binary.sh                   # Installed binary from ~/.local/bin/
./tests/manual/local/test-bulk-plans.sh               # Iterate ~/.claude/plans/
./tests/manual/local/sandbox-opencode.sh [flags]      # OpenCode integration sandbox
./tests/manual/local/fix-vault-links.sh <vault-path>  # Add Obsidian backlinks
```

`sandbox-opencode.sh` flags: `--disable-sharing`, `--keep`, `--no-git`.

**SSH remote testing** (`manual/ssh/`):

```bash
cd tests/manual/ssh/
docker-compose up -d
./test-ssh.sh
```

See [manual/ssh/DOCKER_SSH_TEST.md](manual/ssh/DOCKER_SSH_TEST.md) for setup.
