---
name: qc-check
description: Device-level QC for a mobile app. Fetches the ticket, gets a numbered test plan approved, verifies the backend REST contract, drives the real app on an Android emulator or iOS simulator through Appium, extends unit tests, and publishes an evidence-backed report. Use when asked to QC check, device-test, smoke-test, sweep the app, or validate a ticket, PR, or release build.
---

# qc-check for Claude Code

This file is the Claude Code adapter. It does not contain the workflow.

**Read the canonical workflow first: `WORKFLOW.md` in this same directory**
(`.claude/skills/qc-check/WORKFLOW.md`). Its reference docs are in
`references/` beside it. Read each one when the workflow reaches that phase.
Phases, gates, resume rules, evidence paths, and eval mode live there and are
identical for every agent, so a run driven from Claude Code and a run driven
from another agent do the same work in the same order.

The runtime scripts the workflow calls are at `qc/` in the repository root, and
every project fact comes from `qc.config.json` there.

Then apply the Claude Code notes below.

## Invocation

| The user types | You do |
|---|---|
| `/qc-check ABC-123` | Standard per-ticket run. `$ARGUMENTS` is the ticket ID |
| `/qc-check` | No argument. Derive the ticket ID from the branch, as Phase 1 says |
| `/qc-check full` (or `all`, `sweep`) | Sweep mode. Read `references/full-sweep.md` first |
| `/qc-check fix ABC-123` | Fix loop. Read `references/fix-loop.md` first |
| "QC check ABC-123 on the tablet too" | Same as the first row, plus the `tablet` phase |

## Tool mapping

| Workflow capability | Claude Code tool |
|---|---|
| Visible task list, one task per phase | `TaskCreate` once in Step 0, then `TaskUpdate` for every status change |
| Live sub-step label on the running task | `TaskUpdate` with `activeForm` set to `<phase> [k/N] <sub-step>` |
| Ask the user and wait | `AskUserQuestion`, with Approve and Request changes as the options at the test-plan gate |
| Read and search files | `Read`, `Glob`, `Grep` |
| Write and edit files | `Write`, `Edit` |
| Run shell commands | `Bash` |
| Tracker calls named in `config.tracker.tools.*` | Call the MCP tool by exactly that name, for example `mcp__<server>__<tool>` |

## Host notes

- Installed by `qc-check install --agent claude` into
  `.claude/skills/qc-check/`: this `SKILL.md`, `WORKFLOW.md`, and `references/`.
- `Bash` has a default timeout well under an emulator cold boot. Raise
  `timeout` for boot, build, and install commands, or run them in the
  background and poll.
- Keep the Appium server in a background shell for the whole device phase.
  Starting it per command loses the session.
- `node qc/*.js` commands run many times per run. Allowlisting them in
  `.claude/settings.json` avoids a permission prompt on every step.
- In eval mode (`QC_EVAL=1`) never call `AskUserQuestion`. Headless runs have
  nobody to answer and the run would stall. `WORKFLOW.md` says what to do
  instead at each gate.
- Never read or print the file named by `config.credentialsFile`. The runtime
  scripts consume it.
