# Fix loop: turn findings into verified fixes and PRs

Triggered when the argument starts with `fix`. It takes the findings of a prior
run (default: the most recent `<reportsDir>/*-state.json` that has findings, or
the given RUN-ID, for example `fix FULL-SWEEP` or `fix ABC-123`) and loops
**triage -> root-cause -> fix -> re-verify on device -> branch -> push -> PR**
until every app-side finding is fixed and verified, or explicitly deferred.

Track progress in `<reportsDir>/<RUN-ID>-fixes.md` (the fix board) and in your
visible task list, one task per fix (Claude Code: TaskCreate/TaskUpdate; Codex
and other agents: whatever plan or todo surface they show the user).

`qc/` is the installed runtime inside the host repo and `<reportsDir>/` is
`config.project.reportsDir` (default `qc-reports`).

## 1. Triage: classify every finding first

Write the fix board (`<reportsDir>/<RUN-ID>-fixes.md`) with one row per finding:
`F<n> | finding | class | branch/PR | status`. Classes:

- **app-fix** - a defect in the app code, fixable here (wrong binding, dead
  handler, wrong copy, missing gate). The loop works these in severity order.
- **be** - backend scope (broken endpoint, seed data). Not fixable here: it goes
  to the report and the ticket for the backend team, and the loop skips it.
- **product** - needs a product decision (for example remove a menu row versus
  build the screen behind it). Collect these and **ask the user once**, with a
  recommendation for each. Do not silently pick.
- **env/tooling** - the QC environment, `qc.config.json`, or the installed
  runtime under `qc/`. Fix the config directly; a runtime bug also belongs
  upstream in the skill's own repo. These do not need a device re-verify beyond
  re-running the affected script.

## 2. Per fix: the loop body (strict order)

1. **Root-cause before touching anything.** Read the component or hook, find the
   exact broken line(s), and write the cause into the fix board. If several
   findings share one root cause (for example several dead rows from one broken
   handler pattern), group them into ONE fix.
2. **Branch off the run's base branch:** `git checkout -b qc-fix/<kebab-slug>`.
   One branch per independent fix. The base is the branch the QC run tested,
   which is `config.repo.defaultBranch` unless the run tested a feature or
   release branch, or the user names another.
3. **Fix minimally.** The smallest change that kills the defect, matching house
   style, with no drive-by refactors. Add or extend a test suite when the fix is
   logic (and remember `git add -f` if `config.codeMap.testsGitignored` is true).
4. **Re-verify ON DEVICE.** Rebuild and reinstall with
   `config.app.build.android` (or `config.app.build.ios`), asking the user for
   the command and waiting if that key is empty. Then drive to the screen with
   `node qc/driver.js` and screenshot the proof to
   `<reportsDir>/fix-<slug>-verified.png`. Debug builds
   that load their bundle from a dev server often only need an app relaunch;
   rebuild when native or bundle configuration changed. **A fix that was not
   re-verified on device is not "fixed": it stays in progress.** Also make
   `<config.codeMap.testCommand> <touched-suites>` green.
5. **Commit** with a QC-traceable message:
   `fix(qc): <what> - found by QC run <RUN-ID> (F<n>)`, with the body giving the
   root cause and the verification evidence path.
6. **Push and open the PR.** `git push -u origin qc-fix/<slug>`, then:
   - if `config.repo.prCommand` is set (for example `gh pr create --fill`), run
     it to open the PR against `config.repo.defaultBranch` and give the user the
     link it prints;
   - if it is empty, derive the "new pull request" URL from
     `git remote get-url origin` and print that link instead. Do not invent a PR
     command.

   Either way, write the ready-to-paste PR description to
   `<reportsDir>/fix-<slug>-pr.md`: what and why, the root cause, the evidence
   screenshots, the QC run reference, and verification steps for the reviewer.
7. **Flip the fix board row** (fixed, plus branch and PR link) and update the
   original run's plan and report cells if the fix clears a failed case.

## 3. Loop control

- **The loop is AUTONOMOUS.** Once started it works the entire `app-fix` queue
  without pausing for permission between cycles: finish a fix, post the one-line
  status and PR link, pick the next row, keep going. Do NOT stop after one cycle
  to ask "continue?". The only legitimate stops are a product decision (batch
  them, ask once, keep working the non-blocked rows meanwhile), a guardrail
  trigger (section 4), or an empty queue.
- Work findings **in severity order** (red app-fix first), one at a time. Never
  batch unrelated fixes into one branch.
- After each fix, return to the board and pick the next. The loop ends when no
  `app-fix` row is unresolved.
- **Verify the SERVED bundle, not the source.** If the app loads its JavaScript
  bundle from a dev server, a branch switch or cherry-pick can leave a stale
  bundle being served silently. Before driving the device, restart the bundler
  with its cache reset if in doubt, and grep the served bundle for a marker
  string from your change:
  ```bash
  curl -s "http://localhost:8081/index.bundle?platform=android&dev=true" | grep -c "<marker>"
  ```
  A device pass against a stale bundle proves nothing.
- **Re-verification failed?** Go back to the root cause. Do not stack guesses.
  After two failed attempts, mark the row `needs-human` with what was learned.
- **Product decisions:** batch the questions and ask the user once when they
  block the queue, then wait for the answer (Claude Code: AskUserQuestion;
  Codex and other agents: print the questions and stop until the user replies).
- Everything on the board must be true from disk state. The loop must survive
  interruption like every other QC phase: on resume, re-read the board, run
  `git branch --list 'qc-fix/*'`, and check the open PRs.
- Keep an eye on `config.budget.runCap`: a long fix loop costs real money, so
  report the spend when you hand back.

## 4. Scope guardrails

- Only fix what a finding evidences. A new defect discovered while fixing gets
  recorded as a finding first
  (`node qc/state.js <RUN-ID> finding <red|yellow> '<text>'`), then queued.
- Backend and seed-data findings never get "fixed" by hiding the symptom in the
  app (for example hardcoding a value to mask an empty server response).
- If a fix needs more than roughly 50 lines, or touches navigation or auth
  architecture, pause and confirm the approach with the user first (a one-liner
  with options).
