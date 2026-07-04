---
name: plannotator-workflow
description: CLI-first plan review workflow via bunx — iterative, diff-driven, collaborative planning with zero installation
---

# Plannotator Workflow

**Core principle:** Plans are living documents, revised iteratively through readable diffs. The user reviews incremental changes in a diff view, not wholesale rewrites.

## CLI-First Architecture

All operations use the `plannotator` CLI via bunx. No installation required.

```bash
# Submit plan for review
bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md

# Check daemon status
bunx github:dzackgarza/plannotator-dzg-fork#main status

# Wait for user decision (blocking)
bunx github:dzackgarza/plannotator-dzg-fork#main wait
```

The CLI is harness-agnostic — works with Claude Code, OpenCode, or any agent system.

## Plan File Location

**Durable plan files must exist on disk.**

**Location priority:**
1. Harness-specific location (if defined in local skills/config)
2. Otherwise: `{repo_root}/.agents/plans/{plan-name}.md`

**Example:**
```bash
mkdir -p .agents/plans
echo "# Feature Implementation Plan\n..." > .agents/plans/auth-system.md
bunx github:dzackgarza/plannotator-dzg-fork#main submit .agents/plans/auth-system.md
```

**Why durable files:**
- Agent can EDIT them in place (not rewrite)
- Tool tracks versions automatically
- Produces readable diffs for user review
- Survives agent crashes/restarts

## Workflow Steps

### 1. Read Planning Skills FIRST

**BEFORE submitting any plan:**
- Read all relevant planning skills in the repo
- Check for templates, guidelines, required sections
- Verify the plan meets user-provided standards
- Don't waste the user's time with substandard plans

**Example:**
```bash
# Check for planning skills
ls .claude/skills/*planning*
ls skills/*plan*
grep -r "plan" AGENTS.md CLAUDE.md

# Read them before drafting plan
```

### 2. Create Initial Plan

Draft the plan in the durable location. Include:
- Clear objective
- Acceptance criteria
- Implementation approach
- Risks/unknowns

**Do NOT submit yet if:**
- Local skills define templates you haven't followed
- Required sections are missing
- The plan is vague or incomplete

### 2a. Surface Executive Decisions, Not Forms

Plannotator is for collaborative judgment. Do not convert agent uncertainty,
tracker noise, or incomplete analysis into a questionnaire. Before submitting a
plan, decision report, or status report, classify every candidate item:

- **Source-forced fact:** Canonical docs, mathematics, schemas, or runtime code
  already decide the issue. State the source basis, conclusion, and next agent
  action. Do not ask the user to choose.
- **Routine agent work:** Cleanup, card splitting, stale wording, missing links,
  local verification, or obvious follow-up. Do it, or create a task if it is too
  large. Do not ask the user to approve ordinary execution.
- **Research gap:** The missing input is evidence. Create or propose source
  mining only if it changes priorities or resources; otherwise go find the
  evidence before submitting.
- **Executive decision:** More than one defensible path remains after source
  review, and the choice affects scope, priority, accepted risk, product
  semantics, naming conventions, mathematical convention, or research direction.
  These are Plannotator-worthy.

The user's role is not to be an automaton, parser, or form-filler. Never request
"answer shapes" unless the user explicitly asked for machine-readable output.
Respect the user's attention by doing the recoverable reasoning first, then
surfacing only the owner-level judgment that remains.

Plannotator reports are forward-facing. Do not back-explain earlier agent
mistakes, justify why the previous submission was wrong, or make the user read a
postmortem before the current substance. State the current classification,
source basis, and next action. Record process lessons in skills, policies, or
cards after the review, not in the user-facing report unless the process defect
is itself the decision.

For each genuine executive decision:

- Name the decision in the user's domain language, not internal card jargon.
- State what is already known from sources, docs, code, or mathematics. Do not
  list bare paths as "source basis"; summarize the relevant content and why that
  source controls the question.
- State what remains undecided and why the agent cannot decide it by further
  reading or execution.
- Give the agent's recommendation when evidence supports one.
- Explain the consequences, tradeoffs, and reversibility of the available paths.
- Link source files/cards for optional deep review, but make the decision
  understandable without opening another file.

For status reports, do not list everything that is confusing. Group by what the
user's judgment can actually change:

- Executive decisions needing owner judgment now.
- Priority or scope calls that affect which agent work happens next.
- Informational status with agent-owned next action.
- Blockers that require external input, credentials, or policy not present in
  the repo.

In mathematical or research repos, do not frame mathematical facts as choices.
If source review shows that a definition, universal property, category edge, or
method owner is forced, report it as forced and take the corresponding agent
action. Ask the user only when the repo must intentionally choose between
defensible conventions or deviate from a standard source.

If an obvious source-forced fact reached Plannotator as a decision, treat that
as a workflow defect. Identify why the repo process escalated it: missing
subcategory relation, missing owner row, stale status, incomplete dependency,
ambiguous card state, or review rubric failure. Then update the relevant skill,
policy, card, or dependency so the same non-decision is not surfaced again.

Do not call planned dependency order a deferral decision. If downstream work
cannot proceed until vocabulary, source grounding, implementation surface, or
theory prerequisites exist, encode that in `dependsOn` and leave the downstream
item `unstarted`. `needs-human-input` is only for a real human judgment that
remains after the dependency graph and sources have been checked.

For constructor or method-owner questions, distinguish three layers before
asking the user anything:

- Mathematical owner: the category or object whose structure defines the
  construction or method.
- Human convention: where users reasonably expect a named object or constructor
  to be available when several structures apply.
- Code-maintenance owner: where implementation should live for readability,
  aggregation, and avoiding duplication.

Many systems expose aggregate entry points that collect constructors from
multiple owners. In those cases, the user-facing entry point can be canonical
even when the implementation owner is chosen for maintenance. Only the human
convention layer is an executive decision; mathematical ownership and
code-maintenance cleanup are agent work once sources and repo policy determine
them.

**Bad decision report:**

```markdown
Should `lift_from_product` remain inherited tensor-product vocabulary?
Please choose parent-owned or component-owned and give one sentence explaining
the ownership rule.
```

This treats the user like a classifier for agent-generated labels. It does not
establish whether the question is mathematical, conventional, implementation
local, or already decided by sources.

**Better executive framing:**

```markdown
This is not yet an executive decision. First, the agent must check the canonical
tensor-product source and current category-spec docs.

If the universal-property vocabulary fixes this as a tensor-product parent
operation, the agent should update the card/spec and not ask the user to choose.

Bring this to Plannotator only if two source-compatible conventions remain. In
that case, the executive decision is whether this repo intentionally wants a
nonstandard ownership convention, with the consequence that future tensor
component specs must document an extra public promise.
```

### 3. Submit Plan (Daemon Auto-Starts)

```bash
bunx github:dzackgarza/plannotator-dzg-fork#main submit .agents/plans/feature.md
```

**The daemon will:**
1. Auto-start if not running
2. Open browser with plan for user review
3. Block until user acts (approve/deny/cancel)
4. Return feedback and exit code

**Exit codes:**
- `0` = Approved → proceed to implementation
- `1` = Needs revision → revise and resubmit
- `3` = Cancelled → abort task

**DO NOT:**
- Manually start the daemon first (`plannotator daemon start`)
- Add timeouts to the wait — user takes as long as needed
- Proceed without checking exit code

### 4. Wait for Decision

**The submit process is the callback. You must consume it.**

After submitting a plan, the agent has not received the user's decision until
the blocking `submit` process exits or `wait` returns. Browser notifications,
daemon status, and chat-side visibility are not feedback delivery mechanisms.

Required behavior:
- Keep a handle to the running `submit` process if it was started in a PTY or
  background terminal.
- Poll or read that process until it exits.
- Read the complete stdout/stderr and exit code.
- On exit `1`, revise the same plan file using the returned feedback and
  resubmit.
- Do not end the turn just because `status` shows `awaiting-response`.
- Do not paste the user's feedback back to the user as a substitute for acting
  on it.

**In a background terminal/PTY:**

If you have access to a background terminal or PTY, submit there and let it run:

```bash
# Terminal 1 (background)
bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md
# ... blocks until user acts ...

# Terminal 2 (continue working)
# Agent can do other work while waiting, but must return to Terminal 1
# and drain its output before continuing the workflow.
```

**Alternatively, poll for decision:**

```bash
# Submit
bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md

# In another process/turn, check if done
bunx github:dzackgarza/plannotator-dzg-fork#main wait
```

Use `status` only to diagnose state or recover a URL. `status` is not a
substitute for `submit` or `wait`, because it does not deliver the user's
feedback payload to the agent.

**CRITICAL: No timeouts.**

The user may spend minutes or hours drafting feedback. Never timeout waiting for a decision.

### 5. Handle Feedback (Revision Cycle)

**When plan is denied (exit code 1):**

User feedback will be in the tool output. Read it carefully.

**Revise the plan via EDITS, not rewrites:**

```bash
# WRONG: Wholesale rewrite
cat > plan.md <<EOF
# Completely New Plan
Everything is different now...
EOF

# RIGHT: Targeted edits
# Edit specific sections that need changes
# User will see a diff view showing what changed
```

**Why edits over rewrites:**
- User reviews changes in a diff view (green/red/yellow highlights)
- Incremental changes are easier to understand
- Preserves context and approved sections
- Shows the gradient of progress

**How to edit:**
1. Read the current plan file
2. Identify sections that need changes per feedback
3. Use Edit tool to modify specific sections
4. Keep unchanged sections intact
5. Resubmit

**Example revision cycle:**

```bash
# User feedback: "Add error handling section"

# Edit plan to add the section
# (Use Edit tool to insert new section)

# Resubmit
bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md
# Tool shows diff: +20 lines in "Error Handling" section
```

**Continue revising until approved (exit code 0).**

### 6. Automatic Version Tracking

The tool automatically:
- Saves each submission to `~/.plannotator/history/{project}/{slug}/`
- Numbers versions sequentially (001.md, 002.md, ...)
- Computes diffs between versions
- Shows diff stats in UI (+N/-M changes)

**You don't manage versions manually.**

Just edit the plan file and resubmit. The tool handles versioning.

### 7. After Approval

**Once plan is approved (exit code 0):**

1. **Read workflow skills** — check for post-planning steps:
   - Does the repo require TodoWrite tasks?
   - Are there phase/task artifact templates?
   - Should the plan be decomposed into cards?

2. **Read subagent delegation skills** — before implementing:
   - Should this be delegated to subagents?
   - Are there guidelines for task decomposition?
   - What's the coordination protocol?

3. **Proceed with implementation** following local guidelines.

**Example:**
```bash
# Plan approved
# Check for workflow requirements
grep -r "after.*plan.*approv" skills/ AGENTS.md

# Check for subagent guidelines
grep -r "subagent\|delegate\|task.*decomp" skills/

# Follow discovered guidelines
```

## Anti-Patterns

**❌ False decision reports:**

```markdown
Decision needed: should this stale tracker card be split, closed, or rewritten?
```

If the repo workflow already defines card atomicity and completion rules, this
is agent work. Read the rules, apply them, and submit only if a real owner-level
scope or policy choice remains.

**❌ Back-explaining the previous failure:**

```markdown
The last report was wrong because it treated this as parent-owned vs
component-owned. This revision fixes that mistake.
```

The report should be forward-facing. State the current truth and next action;
put process corrections in durable policy after the review.

**❌ Bare source dumps:**

```markdown
Source basis: CARD-123, SPEC-MAPPING-X, source/file.py.
```

Source lists are not useful unless the report explains which source content
controls the conclusion and what inference follows from it.

**❌ Treating feedback as form completion:**

```markdown
Please answer each item with approve/reject/defer and one sentence.
```

The user is exercising judgment, not filling fields for the agent. Ask for
machine-readable labels only when the user requested that interface.

**❌ Status-report laundering:**

```markdown
Here are 18 confusing items. Please decide what to do with them.
```

Do not launder unresolved agent reasoning into a user-facing report. Triage the
items first, remove facts and routine cleanup, and surface only decisions where
human authority changes the next action.

**❌ Proof-of-work instead of decision substance:**

```markdown
I audited many cards and found several possible method-boundary issues.
```

Volume of inspection is not a decision. The report must state the source basis,
the remaining conflict, the recommended path, and why user judgment is needed.

**❌ Wholesale rewrites:**
```markdown
# Version 1
## Approach
Use REST API

# Version 2 (REWRITE - BAD)
## Approach
Use GraphQL API with subscriptions and...
```

The user sees a giant red/green diff with no incremental understanding.

**✅ Targeted edits:**
```markdown
# Version 1
## Approach
Use REST API

# Version 2 (EDIT - GOOD)
## Approach
Use REST API with WebSocket fallback for real-time updates
```

The user sees: "Ah, they added WebSocket fallback. I can see the change."

**❌ Submitting before reading guidelines:**

Skipping local planning skills → submit generic plan → denied → wasted time.

**✅ Reading guidelines first:**

Check skills → draft plan meeting standards → submit → approved faster.

**❌ Manual daemon management:**

```bash
plannotator daemon start  # DON'T
plannotator submit plan.md
```

**✅ Submit handles daemon automatically:**

```bash
plannotator submit plan.md  # Auto-starts daemon if needed
```

**❌ Timeouts on user decisions:**

```bash
timeout 300 plannotator submit plan.md  # WRONG
```

**✅ Patient waiting:**

```bash
plannotator submit plan.md  # Waits as long as needed
```

**❌ Checking status and stopping:**

```bash
bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md &
bunx github:dzackgarza/plannotator-dzg-fork#main status
# WRONG: ending the turn here leaves feedback unread
```

**✅ Drain the blocking process:**

```bash
bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md
# Read the returned feedback and exit code, then revise or proceed.
```

## Background Terminal Pattern

**Optimal workflow with background terminal:**

```bash
# Terminal 1 (PTY/background - leave open)
bunx github:dzackgarza/plannotator-dzg-fork#main submit .agents/plans/feature.md
# ... blocking, waiting for user ...

# Terminal 2 (main agent)
# Continue other work
# Periodically check if decision arrived:
bunx github:dzackgarza/plannotator-dzg-fork#main status
# Shows: "awaiting-response" or "idle" (decision received)
```

When decision arrives, Terminal 1 unblocks with exit code and feedback.

**Mandatory follow-through:**

If Terminal 1 was launched through an agent tool, keep its session identifier and
read from it until it exits. Treat the unblocked process output as the source of
truth for the next action:
- exit `0`: proceed according to the approved plan and any returned notes
- exit `1`: edit the existing plan file to address the feedback, then resubmit
- exit `3`: stop the workflow as cancelled

Do not rely on the browser UI to notify the chat session. The CLI output is the
agent-facing notification channel.

## Key Principles

1. **CLI-first via bunx** — zero installation, works anywhere
2. **Durable plan files** — on disk, version-controlled, editable
3. **EDIT, don't rewrite** — readable diffs, incremental progress
4. **Submit auto-starts daemon** — no manual lifecycle management
5. **No timeouts** — user takes as long as needed
6. **Decision plans need executive framing** — separate real owner judgments from forced facts and agent work
7. **Read skills first** — meet guidelines before submitting
8. **Iterative collaboration** — revise until approved
9. **Follow post-approval workflow** — read workflow/delegation skills
10. **Background terminals** — optimal only if you drain the submit process
11. **Version tracking is automatic** — tool handles history

## Troubleshooting

**Q: Plan won't submit?**

Check daemon status:
```bash
bunx github:dzackgarza/plannotator-dzg-fork#main status
```

If stuck, clear and resubmit:
```bash
bunx github:dzackgarza/plannotator-dzg-fork#main clear
bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md
```

**Q: User keeps denying plan?**

Review feedback carefully. Are you:
- Making targeted edits (not rewrites)?
- Following local planning guidelines?
- Addressing all feedback points?
- Keeping approved sections intact?

**Q: Daemon port conflict?**

Set fixed port:
```bash
PLANNOTATOR_PORT=43000 bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md
```

**Q: Can't find planning skills?**

```bash
# Search for planning guidance
find . -name "*plan*.md" -o -name "*PLAN*.md"
grep -r "plan" AGENTS.md CLAUDE.md .claude/ skills/
```

## Summary Checklist

Before submitting plan:
- [ ] Read all relevant planning skills
- [ ] Plan meets local guidelines/templates
- [ ] Plan is in durable file location
- [ ] Plan has clear objective, approach, criteria
- [ ] Decision/status items separate executive decisions from forced facts and agent work

During revision:
- [ ] EDIT specific sections (not rewrite)
- [ ] Address all feedback points
- [ ] Keep approved sections intact
- [ ] Resubmit for another review

After approval:
- [ ] Read workflow skills for next steps
- [ ] Read subagent delegation skills if applicable
- [ ] Follow local implementation guidelines
- [ ] Create artifacts (tasks, cards) if required

Process:
- [ ] Submit via bunx (daemon auto-starts)
- [ ] No timeouts on waits
- [ ] Background terminal if available
- [ ] If submitted in a background terminal, return to it and drain output
- [ ] Check exit code before proceeding
