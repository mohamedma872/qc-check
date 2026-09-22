# Test plan: DoD + test cases, user-approved (phase `test-plan`)

Why: QC against an unwritten bar drifts. Cases get invented mid-run and the
verdict cannot be audited. This phase pins down **what "done" means** (DoD) and
**exactly how it will be verified** (numbered test cases) BEFORE any backend
call or emulator boot, writes both to a reviewable markdown file, and **stops
for the user's approval**. The approved file then doubles as the live progress
board: later phases flip its status cells as cases resolve.

`qc/` is the installed runtime inside the host repo, `<run>/` is this run's folder (it is in your prompt, in `$QC_RUN_DIR`, and
`node qc/runs.js current` prints it), `<env>` is the run's
environment (`QC_ENV`), and `ABC-123` stands for the ticket id (validated
against `config.tracker.ticketPattern`).

Sub-steps (record each with `node qc/state.js ABC-123 step test-plan <name> <status>`):
`dod` -> `test-cases` -> `write-md` -> `approval`.

## 1. `dod` - Definition of Done

Derive from the ticket's acceptance criteria plus the code read in the `ticket`
phase. One row per independently verifiable outcome, each mapped to what proves
it (test case(s), unit tests, or server-side readback). Always include:

- an **end-to-end persistence** item for every write the feature performs (the
  server shows the change after the action, verified with a `qc/api.js`
  readback, not by the UI looking right) whenever `config.backend.enabled` is
  true;
- a **unit-tested** item for any new non-UI logic (helpers, validation,
  services, hooks), proven by `config.codeMap.testCommand`;
- a **per-locale** item for any UI change when `config.project.locales` has more
  than one entry, and a **direction** item as well when any of them is in
  `config.project.rtlLocales`. Mirrored-layout bugs are a recurring failure
  class. With a single locale, skip both and say so in "Out of scope".

## 2. `test-cases` - numbered, concrete, executable

`TC1...TCN`, each with real selectors (the `testID`s found in the PR diff, the
branch under test against `config.repo.defaultBranch`),
concrete steps, and a single expected result. Cover:

- the happy path;
- the error / edge path;
- one case per additional entry in `config.project.locales` when the ticket
  touches UI, including the mirrored-layout check for `config.project.rtlLocales`;
- offline behaviour when relevant;
- the end-to-end persistence case(s).

Cases run on the Android phone. Add Tablet / iOS columns only when those passes
were requested (`-` where not applicable). A case you cannot make concrete
(missing testID, unreachable screen) is a finding to note in the plan, not a
reason to skip planning it.

## 3. `write-md` - write `<run>/plan.md`

```markdown
# QC Test Plan - ABC-123: <title>
Status: AWAITING APPROVAL   <!-- flip to: APPROVED by user on YYYY-MM-DD -->
Environment: <env> · Branch: <branch> · PR: #<n> · Backend: <config.backend.baseUrls[env]> · Platforms: Android phone[ + tablet + iOS]

## Definition of Done
| # | Done means | Verified by | Status |
|---|-----------|-------------|:------:|
| D1 | <outcome from AC> | TC1, TC3 | pending |
| D2 | <write persists: server shows X after Y> | TC4 (E2E readback) | pending |
| D3 | <UI correct in <locale>, mirrored if RTL> | TC5 | pending |
| D4 | <new logic covered by unit tests> | unit-tests phase | pending |

## Test cases
| # | Test case | Steps (selectors) | Expected | Phone |
|---|-----------|-------------------|----------|:-----:|
| TC1 | <name> | tap `~apply-button` -> ... | <single observable result> | pending |

Legend: pending · PASS · FAIL · BLOCKED · n/a for this form factor

## Out of scope
- <explicitly not verified + why>
```

The plan covers one environment, the run's `<env>`. A case that only makes
sense on another environment goes under "Out of scope" with that reason; it
belongs to a separate run.

Use whatever status glyphs the rest of the run uses, as long as the plan, the
state file and the report agree. Keep the table columns stable: the device
phases edit these cells in place.

## 4. `approval` - HARD GATE: the user must approve

1. Post a short summary to the user: the environment, DoD count, case count,
   what is covered, anything you flagged out of scope, plus the path of
   `<run>/plan.md` so they can open it.
2. **Ask the user and wait for an answer**: *"Approve the QC test plan for
   ABC-123?"* with the options **Approve** and **Request changes** (their notes
   come back with it). Use whatever your agent offers for a blocking question
   (Claude Code: AskUserQuestion; Codex and other agents: print the question and
   stop until the user replies). Never assume approval, and never proceed on
   silence.
3. **Request changes** -> revise the file, summarize the delta, ask again.
4. **Approve** -> flip the file's `Status:` line to `APPROVED by user on <date>`,
   then:
   ```bash
   node qc/state.js ABC-123 step test-plan approval pass
   node qc/state.js ABC-123 set test-plan pass
   ```

`qc/state.js` **enforces** this gate: no later phase can go `in_progress` until
`test-plan` is `pass`. Never work around it.

On resume with `test-plan` already `pass`, do NOT re-ask. The approval stands
unless the user asks to change the plan, in which case edit the file and
re-approve.

## Keeping the plan file live (later phases)

- **Device passes:** as each `case-N` resolves, flip that TC's cell (pass, fail,
  or blocked, plus a short note on fail or blocked). The case numbering in
  `node qc/state.js ABC-123 plan phone ...,case-1,...` MUST match the plan's TC
  numbers.
- **Contract and smoke:** a write discovered late gets its TC and DoD row
  appended, marked *(added post-approval)*, and you tell the user in the status
  one-liner.
- **Unit-tests and report:** flip the DoD rows those phases prove. The final
  report's verdict must agree with the plan board's final state.
