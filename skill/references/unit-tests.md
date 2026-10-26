# Extend unit tests for the ticket's new logic (phase `unit-tests`)

Device QC proves the flow works once. **Unit tests guard the new logic against
regressions.** Required for any ticket that adds or changes logic; skip only for
pure presentational changes (styles, copy, layout), which device QC covers.

`qc/` is the installed runtime inside the host repo and `ABC-123` stands for the
ticket id. Unit tests do not depend on the run's environment, and this phase
writes nothing into the run folder except through `state.js`. The test runner is `config.codeMap.testCommand`, the linter is
`config.codeMap.lintCommand`, and the type checker is
`config.codeMap.typecheckCommand`.

Sub-steps (record each with `node qc/state.js ABC-123 step unit-tests <name> <status>`):
`identify-units` (item 1) -> `extend-suites` (items 2 and 3) -> `run-green`
(item 4) -> `commit` (the closing commit), plus `repro-tests` when a device
case failed on a logic bug (see "A failing repro test" below; the step is
appended the first time you record it).

1. **List the new units to cover.** From the PR diff (the branch under test
   against `config.repo.defaultBranch`), pick the testable, non-UI pieces:
   - pure **helpers and flow logic** (`config.codeMap.utilsGlob`);
   - **validation** schemas and rules (`config.codeMap.validationGlob`);
   - **API services** (`config.codeMap.apiServicesGlob`): URL building,
     request-payload shaping, response mapping. Mock the HTTP client or the base
     service;
   - **mutation and query hooks with branching logic**
     (`config.codeMap.mutationsGlob`, `config.codeMap.queriesGlob`): wrap them in
     whatever provider the data layer needs and mock the service layer;
   - **security and token logic** when the ticket touches it, which the config
     does not map: find it in the PR diff.

   Skip screens and components (they are verified on-device); test the logic
   they call.

2. **Find the existing suite and EXTEND it.** Follow the repo's own layout and
   house style: open the nearest existing suite for the module you are touching
   and copy its mock and `describe`/`it` patterns. Add cases to an existing file
   rather than creating a parallel one; if no suite exists for a new unit,
   create one following the nearest sibling's structure.

3. **Cover behaviour that matters for this ticket:**
   - happy path (returns or persists the expected shape);
   - the **backend contract shape from the `contract` phase**: assert the
     method, path and body actually sent (for example that the new field is
     forwarded, and that a language header is set when relevant);
   - error and edge paths (network throws, missing id, empty response no-op);
   - locale-sensitive logic once per entry in `config.project.locales` where it
     applies, reading the strings from `config.codeMap.translationsDir`.

4. **Run only the affected suites and make them green:**
   ```bash
   <config.codeMap.testCommand> <NameOrPathPattern>    # e.g. yarn jest verificationFlow
   <config.codeMap.testCommand>                        # full suite if the change is broad
   ```
   Do not reduce existing coverage. All touched suites must pass before a PASS
   verdict. If the repo also defines `config.codeMap.lintCommand` and
   `config.codeMap.typecheckCommand`, run them over the files you touched too, so
   the tests you add do not break the build.

5. **Report it** in the Findings section: suites extended plus case counts, and
   flag any new logic deliberately left to device QC (no unit test) as a yellow
   finding, not a silent gap.

**Repo quirk: gitignored tests.** If `config.codeMap.testsGitignored` is true,
the repo's `.gitignore` excludes test paths, so new test files need
`git add -f` or they silently stay untracked. Check with
`git status --short <file>` after adding. Committing tests that are ignored by
default is worth a yellow finding suggesting the team un-ignore test paths.

Commit the tests with the ticket (same branch and PR), message
`test(ABC-123): ...`.

## A failing repro test for every logic FAIL (sub-step `repro-tests`)

A device FAIL says "it is broken"; a failing unit test says "here is the
broken line, and here is how you will know it is fixed". When a device case
FAILED on a **logic bug** (wrong state, wrong list, wrong calculation, a
missing reset; not layout, copy, backend or environment), hand the developer a
unit test that fails for the same reason.

1. **Find the unit that misbehaves.** Start from the cause in the finding (a
   code-review finding usually names it already). Pick the smallest unit that
   shows the bug: the store, bloc, hook, reducer or service, not the screen.
2. **Write the test for the correct behaviour,** in the nearest existing
   suite's style, named so nobody mistakes it for a regression:
   `[QC-REPRO ABC-123] <what should happen>`, for example
   `[QC-REPRO ABC-123] load-more after a failed sort refresh does not append the new query's page 2`.
   Reproduce the device sequence in the test (the failed call, then the next
   action) and assert what the user should have seen. Add a one-line comment
   above it: `Red until <the bug> is fixed. Found by QC on device (TC<n>).`
3. **Run it and watch it fail for the right reason.** Run just that test
   (`<config.codeMap.testCommand> <pattern>`). It must fail on the assertion
   that describes the bug, not on a mock you set up wrong, a missing import
   or a timeout. If it passes, your test does not reproduce the bug yet: fix
   the test, or say in the report that the bug could not be reproduced at unit
   level. Save the failing output's key lines (the assertion and the actual
   value) for the report.
4. **Never weaken it to pass.** Do not loosen the assertion, assert the buggy
   value, wrap it in `skip`/`xit`/`@Skip`, or mark it as an expected failure to
   get a green run. The test is the bug report; a green one says nothing. It
   stays red until the developer fixes the code, and their fix turns it green.
5. **Hand it over without breaking anyone's CI.** Do not commit a red test
   onto the PR branch or any shared branch. Either:
   - after the `commit` sub-step (so the green tests stay on the PR branch),
     commit it on a separate **local** branch off the PR branch,
     `qc-repro/ABC-123-<kebab-slug>`, with the message
     `test(ABC-123): failing repro for <bug> (red until fixed)`, switch back
     to the PR branch, and give the developer the branch name: they
     cherry-pick it under their fix (`git add -f` applies here too when
     `config.codeMap.testsGitignored` is true); or
   - when committing is not possible (eval mode, a read-only checkout),
     include the full test code in `report.md` under `## Unit tests`, with the
     file it belongs in.

   Do not push the repro branch unless the user asks. If the team wants the
   test merged before the fix, that is their call: suggest the framework's
   strict expected-failure marker (for example Jest `test.failing`, pytest
   `xfail(strict=True)`) with the ticket id, which turns into an error the
   moment the fix lands.
6. **Report it.** In `report.md` under `## Unit tests`, one line per repro
   test: `RED (expected): [QC-REPRO ABC-123] <name> fails with <actual vs
   expected>, branch qc-repro/ABC-123-<slug>`. In `review.md`, mention it in
   the must-fix item it belongs to ("A unit test that shows the bug is on
   branch ..."). A red repro test does not count against `run-green`: that
   step covers the suites you extended, which must still be green.

```bash
node qc/state.js ABC-123 step unit-tests repro-tests pass 1 failing repro test on qc-repro/ABC-123-<slug>
```
