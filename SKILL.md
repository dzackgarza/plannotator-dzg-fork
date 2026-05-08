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

**In a background terminal/PTY:**

If you have access to a background terminal or PTY, submit there and let it run:

```bash
# Terminal 1 (background)
bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md
# ... blocks until user acts ...

# Terminal 2 (continue working)
# Agent can do other work while waiting
```

**Alternatively, poll for decision:**

```bash
# Submit
bunx github:dzackgarza/plannotator-dzg-fork#main submit plan.md

# In another process/turn, check if done
bunx github:dzackgarza/plannotator-dzg-fork#main wait
```

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

## Key Principles

1. **CLI-first via bunx** — zero installation, works anywhere
2. **Durable plan files** — on disk, version-controlled, editable
3. **EDIT, don't rewrite** — readable diffs, incremental progress
4. **Submit auto-starts daemon** — no manual lifecycle management
5. **No timeouts** — user takes as long as needed
6. **Read skills first** — meet guidelines before submitting
7. **Iterative collaboration** — revise until approved
8. **Follow post-approval workflow** — read workflow/delegation skills
9. **Background terminals** — optimal for long waits
10. **Version tracking is automatic** — tool handles history

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
- [ ] Check exit code before proceeding
