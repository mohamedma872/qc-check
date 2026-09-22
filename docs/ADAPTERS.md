# Adapters: running this on any agent

The workflow is one file. `skill/SKILL.md` holds the entire QC procedure and
is installed verbatim as `WORKFLOW.md` next to whichever adapter you chose.
An adapter never restates the workflow. It only answers four questions about
the host agent.

That split is the point. When the procedure improves, it improves for every
agent at once, and the adapters stay a page long.

## The four capabilities

A host agent can run this skill if it can do these things. Everything else in
the workflow is plain shell and files.

| Capability | Why the workflow needs it |
|------------|---------------------------|
| **Run shell commands** | Drive the device, call the backend, record state. Every QC action is a script under `qc/`. |
| **Read and write files** | Read the code under test, write the plan, the report and the evidence. |
| **Show visible progress** | The run has ten phases and takes a long time. A human has to be able to watch it and stop it. |
| **Ask the user and wait** | The test plan is a hard approval gate. An agent that cannot block on a human answer can only run in headless mode. |

An agent missing the last one can still run with `QC_EVAL=1`, which
auto-approves the plan and skips publishing. Use that for automation, not for
work you intend to trust unreviewed.

## What ships

| Adapter | Installs to | Invocation |
|---------|-------------|------------|
| `agents/claude-code/` | `.claude/skills/qc-check/` in the repo | `/qc-check ABC-123` |
| `agents/codex/` | `~/.codex/skills/qc-check/` | `Use $qc-check for ABC-123` |
| `agents/generic/` | `./qc-check-skill/` in the repo | paste the bootstrap prompt from `AGENTS.md` |

Install one with:

```bash
npx qc-check install --agent claude    # or codex, or generic
```

## Writing a new adapter

Copy `agents/generic/` and change four things.

1. **Discovery.** How the host finds a skill. A frontmatter block, a manifest,
   a folder convention, or nothing at all, in which case the user pastes the
   bootstrap prompt.
2. **The tool-name map.** Name the host's equivalent of the four capabilities.
   For example, a visible task list is `TaskCreate` and `TaskUpdate` on one
   agent and `update_plan` on another.
3. **The ask.** How the agent puts a question to the user and blocks for the
   answer. If the host has a structured question tool, name it. If not, say
   plainly: ask in chat and wait, do not proceed.
4. **Quirks.** Anything the host does that would otherwise surprise the
   workflow. Session or approval behaviour, sandboxing, where the working
   directory is, whether restarting is needed after install.

Do not put QC procedure in an adapter. If you find yourself explaining a
phase, a gate or a selector strategy, it belongs in `skill/SKILL.md` or a
file under `skill/references/`, where every agent gets it.

## Keeping adapters honest

The runtime scripts are the contract between the workflow and the host. They
take their configuration from `qc.config.json` and hold the run state on disk,
so a run survives losing the agent entirely. If your adapter needs the agent to
remember something between phases, write it through `qc/state.js` instead.
That is what makes a run resumable after a crash, a closed session, or a switch
to a different agent mid-run.
