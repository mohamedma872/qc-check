# qc-check for any other agent

This file is the generic adapter. It does not contain the workflow.

**The canonical workflow is `WORKFLOW.md` in this same directory**, installed
at `qc-check-skill/WORKFLOW.md` in the host repository, with its reference docs
in `qc-check-skill/references/`. Every agent reads that same file, so the QC
run is the same work in the same order no matter who drives it. This adapter
only says how to wire a host that has no purpose-built adapter.

The runtime scripts the workflow calls are at `qc/` in the repository root, and
every project fact comes from `qc.config.json` there.

If your agent is Claude Code or Codex, install `agents/claude-code/` or
`agents/codex/` instead.

## What your agent must be able to do

Four capabilities. Without all four, the run cannot honour the workflow's
gates.

| # | Capability | Used for |
|---|---|---|
| 1 | Run shell commands and see their output | Every `node qc/*.js` call, Appium, the emulator, git, the test command |
| 2 | Read and write files | Reading `qc.config.json` and the app's source, writing the plan, the report, and the evidence under the configured reports directory |
| 3 | Show progress to the user | The per-phase task list and the one-line status message at each transition |
| 4 | Ask the user a question and wait for the answer | The test-plan approval gate, and any question the workflow raises |

Capability 4 is the strict one. The workflow stops at the test-plan gate and
must not continue until a human approves. An agent that cannot block on a reply
may only run with `QC_EVAL=1`, where the workflow defines the auto-approve
path.

## Bootstrap prompt

Paste this into the agent, from the host repository root:

```text
You are running the qc-check skill for this repository.

1. Read qc-check-skill/WORKFLOW.md in full. It is the canonical QC workflow
   and it overrides your own habits about ordering, gates, and reporting.
2. Read qc.config.json at the repo root. Every project-specific fact comes
   from it. Never read or print the file named by credentialsFile; the
   scripts in qc/ consume it for you.
3. Read a file in qc-check-skill/references/ only when the workflow tells you
   to, at the phase that needs it.
4. Map the workflow's four capabilities onto your own tools before you start,
   and tell me the mapping in one line each: visible task list (one task per
   phase), ask me a question and wait, read and write files, run shell
   commands.
5. Do Step 0 first: check for a resumable run with
   `node qc/state.js <TICKET> get`, take the cost baseline with
   `node qc/cost.js <TICKET> snapshot baseline`, then create the task list.
6. Stop at the test-plan gate and wait for my approval. Do not start any later
   phase until `node qc/state.js <TICKET> get` shows test-plan as pass.

Target: ABC-123
```

Replace `ABC-123` with the ticket ID, or with `full` for a sweep, or
`fix <RUN-ID>` for the fix loop.

## Capability mapping table

Fill the right column with your host's tool names before the first run, and
keep the filled table with your agent's configuration so later runs do not
rediscover it.

| Workflow capability | Claude Code | Codex | Your agent |
|---|---|---|---|
| Visible task list | `TaskCreate` / `TaskUpdate` | `update_plan` | |
| Ask the user and wait | `AskUserQuestion` | plain chat, end the turn | |
| Read and search files | `Read`, `Glob`, `Grep` | `shell` with `cat` and `rg` | |
| Write and edit files | `Write`, `Edit` | `apply_patch` | |
| Run shell commands | `Bash` | `shell` | |
| Tracker calls in `config.tracker.tools.*` | MCP tool by that name | MCP tool by that name | |

If your host has no task list at all, substitute a one-line chat message at
every phase and sub-step transition. The state file under the configured
reports directory is the durable record either way, so the run still resumes.

If your host cannot call the tracker tools named in `config.tracker.tools.*`,
treat those names as empty and follow the degraded publish path in the
workflow: assemble the report, print it and the evidence paths, and let the
user post it.

## Host quirks to write down

Before the first real run, find out and record these. They break device passes
everywhere.

- How long a shell command may run before the host kills it, and how to run a
  long one, such as an emulator boot or an app build, in the background.
- Whether a background process such as the Appium server survives between
  commands.
- Whether shell commands are sandboxed away from the network or the emulator,
  and how to escalate once instead of per command.
- Whether the host truncates command output. `node qc/dump-tree.js --grep`
  exists for exactly that reason.
- Where the agent's working directory is. The workflow's paths are relative to
  the repository root.

When you have those answers, you have written a real adapter. Copy this file
into `agents/<your-host>/`, fill in the mapping, and keep the QC procedure out
of it.
