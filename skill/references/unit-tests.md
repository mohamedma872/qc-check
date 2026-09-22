# Extend unit tests for the ticket's new logic (phase `unit-tests`)

Device QC proves the flow works once. **Unit tests guard the new logic against
regressions.** Required for any ticket that adds or changes logic; skip only for
pure presentational changes (styles, copy, layout), which device QC covers.

`qc/` is the installed runtime inside the host repo and `ABC-123` stands for the
ticket id. The test runner is `config.codeMap.testCommand`, the linter is
`config.codeMap.lintCommand`, and the type checker is
`config.codeMap.typecheckCommand`.

Sub-steps (record each with `node qc/state.js ABC-123 step unit-tests <name> <status>`):
`identify-units` (item 1) -> `extend-suites` (items 2 and 3) -> `run-green`
(item 4) -> `commit` (the closing commit).

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
