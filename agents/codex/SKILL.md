---
name: qc-check
description: Device-level QC for a mobile app. Fetches the ticket, gets a numbered test plan approved, verifies the backend REST contract, drives the real app on an Android emulator or iOS simulator through Appium, extends unit tests, and publishes an evidence-backed report. Use when the user asks Codex to QC check, device-test, smoke-test, sweep the app, or validate a ticket or release build.
---

# qc-check for Codex

This file is the Codex adapter. It does not contain the workflow.

**Read the canonical workflow first: `WORKFLOW.md` in this same directory**
(`~/.codex/skills/qc-check/WORKFLOW.md`). Its reference docs are in
`references/` beside it. Read each one when the workflow reaches that phase.
Phases, gates, resume rules, evidence paths, and eval mode live there and are
identical for every agent, so a Codex run and a run from any other agent do the
same work in the same order.

The runtime scripts the workflow calls are at `qc/` in the host repository
root, and every project fact comes from `qc.config.json` there. Start Codex
from that repository root so the relative paths resolve.

Then apply the Codex notes below.

## Invocation

| The user says | You do |
|---|---|
| `Use $qc-check for ABC-123` | Standard per-ticket run |
| `Use $qc-check` | No target. Derive the ticket ID from the branch, as Phase 1 says |
| `Use $qc-check for full` (or `all`, `sweep`) | Sweep mode. Read `references/full-sweep.md` first |
| `Use $qc-check for fix ABC-123` | Fix loop. Read `references/fix-loop.md` first |

A `/qc-check <target>` typed by a user who came from another agent means the
same thing. Treat it as `Use $qc-check for <target>`.

## Tool mapping

| Workflow capability | Codex tool |
|---|---|
| Visible task list, one task per phase | `update_plan`, one plan item per phase |
| Live sub-step label on the running task | `update_plan` again with the current item rewritten as `<phase> [k/N] <sub-step>` |
| Ask the user and wait | Plain chat. State the question, list the options (Approve, Request changes), stop, and wait for the reply. There is no structured ask tool |
| Read and search files | `shell` with `cat`, `rg`, `sed -n` |
| Write and edit files | `apply_patch` |
| Run shell commands | `shell` |
| Tracker calls named in `config.tracker.tools.*` | Call the configured MCP tool by that exact name. If it is not available in this session, follow the empty-tool-name path in the workflow's publish table |

## Host notes

- Installed by `npx qc-check install --agent codex` into
  `~/.codex/skills/qc-check/`: this `SKILL.md`, `openai.yaml`, `WORKFLOW.md`,
  and `references/`. Restart Codex afterwards so the skill list refreshes.
- The skill folder is global but the run is repo-local. `WORKFLOW.md` is read
  from the skill folder; `qc/`, `qc.config.json`, and the reports directory are
  read from the repository you launched Codex in.
- Codex does not block on an approval prompt the way a structured question tool
  does. At the test-plan gate, end your turn after asking. Do not start Phase 3
  in the same turn.
- Long device work needs a shell that outlives one command. Start the Appium
  server in the background and keep the emulator up for the whole phase.
- Device and network commands may need escalated permissions or a
  non-sandboxed shell. Ask for the escalation once, up front, rather than
  failing mid-pass.
- In eval mode (`QC_EVAL=1`) auto-approve the test plan exactly as
  `WORKFLOW.md` says, and never wait for a human reply.
- Never `cat` the file named by `config.credentialsFile` and never echo a
  credential. The runtime scripts read it.
