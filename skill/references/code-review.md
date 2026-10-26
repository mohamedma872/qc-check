# Code review: predict the bugs, then plan to reproduce them (phase `code-review`)

Why: a device pass that only walks the acceptance criteria finds the bugs the
developer already thought about. The ones that ship are on paths nobody walked:
a refresh that fails halfway, a second tap while a request is in flight, page 2
of a list after the filter changed. Reading the diff first tells you where
those paths are. Every risky spot you find becomes a **"try to reproduce"**
test case in the plan, so the device pass goes looking for it on purpose.

A real case: the review noticed that a failed sort refresh left the old list
on screen but kept the new sort as the active query, and that load-more
appended the next page of whatever the active query was. It predicted that
"failed sort refresh, then scroll to the bottom" would append page 2 of the
new sort to the old list. The device case reproduced it exactly. Without the
review nobody would have tried that sequence.

`qc/` is the installed runtime inside the host repo, `<run>/` is this run's
folder, and `ABC-123` stands for the ticket id. This phase runs after `ticket`
and before `test-plan`. It needs no approval: its output goes into the plan,
and the plan is what the user approves.

Sub-steps (record each with `node qc/state.js ABC-123 step code-review <name> <status>`):
`read-diff` -> `risks` -> `repro-cases`.

**Skip it** only when there is no diff to review: full-app sweep mode
(`set code-review skipped full sweep, no diff`) or a ticket with no code change
on this branch (`set code-review skipped no diff against <base>`).

**Time cap: about 15 minutes of reading,** or roughly 10% of
`config.budget.runCap` for a very large diff. When the cap hits, stop, record
what you have, and list the files you did not read as a yellow finding
("code review covered X of Y files"). The review feeds the device pass; it
does not replace it.

## 0. Static leads first (part of `read-diff`)

```bash
node qc/review-scan.js --save        # base: repo.defaultBranch; --base <ref> for a release branch; --lint adds the linter
```

It reads only the lines this branch added and prints **leads** in six groups:
`owasp` (secrets, cleartext/TLS bypass, sensitive logs, plain storage,
WebView, exported components, weak crypto, deep-link input, dependency
changes, each tagged with its OWASP Mobile Top 10 id), `perf`, `memory`,
`concurrency`, `standards` (lint, debug leftovers, TODOs, size) and
`architecture` (layer imports from `config.review.layers`, or the built-in
data/domain/presentation rules). `--save` keeps `<run>/review/scan.json` and
`scan.md`. Secret values are always masked; never unmask one into a report.

The rules are regexes with a little brace counting, so **a lead is not a
finding**. Open every lead you keep in the code (section 1) and record it only
when the code confirms it, with what the user would see (section 2). Drop the
rest without a finding. A noisy rule for this repo goes into
`config.review.disable`. Say in the `read-diff` step how many you kept, e.g.
`... step code-review read-diff pass 12 files, 23 scan leads, 4 confirmed`.

## 1. `read-diff` - read what changed, in context

```bash
BASE=$(node -p "require('./qc.config.json').repo.defaultBranch")
git diff --stat "$(git merge-base HEAD "$BASE")"...HEAD
git diff "$(git merge-base HEAD "$BASE")"...HEAD -- <file>
```

Use the base the `ticket` phase settled on (a release branch, if that is what
the PR targets). Read in this order: state and data-layer code (stores, blocs,
reducers, hooks, services) first, then the screens that call them, then tests.
For each changed function, open enough of the surrounding file to see who
calls it and what state it reads. A diff hunk alone hides the bug as often as
it shows it.

**Delegate when the diff is large.** Over about 25 changed source files, or
several unrelated modules, hand each module to a sub-agent if your agent can
spawn one (Claude Code: the Agent tool; other agents: do it yourself, module by
module). Give each one the file list, the ticket's acceptance criteria and the
checklist in section 2, and ask for findings in the format of section 2 with
file and function names. You still own the merge: drop duplicates, and check
every finding against the code yourself before it goes into the plan.

## 2. `risks` - what to look for

Look for the failure classes that unit tests and a happy-path walk miss:

- **State and lifecycle.** State updated before the request succeeds and not
  rolled back on failure. A value that outlives the screen (a singleton, a
  cached store, a controller not disposed). A listener or timer registered
  twice. A widget or component that uses its state after it is gone (async
  work finishing after navigation away).
- **Error paths.** What the user sees when the call fails, times out, or
  returns an empty or partial body. A catch that swallows the error and leaves
  a spinner forever. Retry that repeats a non-idempotent write.
- **Pagination and lists.** The page counter or cursor not reset when the
  query, filter, sort or search changes. "Has more" computed from the wrong
  page. Load-more allowed while a refresh is in flight. Duplicates or gaps at
  page boundaries.
- **Races.** Two requests whose responses can arrive in either order (type
  ahead, fast filter switching, pull-to-refresh during load-more). A double
  tap on a submit button. Navigation while a write is pending.
- **Null and shape handling.** Optional fields read as required, a list
  assumed non-empty, a number parsed from a string that can be missing, an
  enum value the app does not know.
- **Security and privacy.** Tokens, keys or personal data logged, cached in
  plain storage, put in a URL, or shown to the wrong user after logout.
  Authorisation checked only in the UI.
- **Locale and direction,** when `config.project.locales` has more than one
  entry: strings concatenated instead of formatted, layout that assumes
  left-to-right.

For each risk, record a finding at once, marked as unconfirmed:

```bash
node qc/state.js ABC-123 finding yellow "from code review, not yet reproduced: <what the user would see> when <sequence>. Cause: <file>:<function> <one line>. Repro: TC<n>"
```

Use `yellow` for a predicted bug. When the device case reproduces it, record a
new `red` finding that cites the evidence and names the code-review finding it
confirms; when the case passes, the prediction was wrong and the plan cell says
so. Never promote a code-review finding to a must-fix item without a device
reproduction or a failing unit test (`references/unit-tests.md`).

Not every oddity is a risk worth a test case. Keep the ones where you can say
what the user would see. Style, naming and refactor ideas are out of scope
here; note them in one yellow finding at most.

## 3. `repro-cases` - turn every risk into a test case

Each risk becomes one test case in the plan with the prefix **"Repro:"** in its
name, so the plan, the report and the review comment can tell a predicted bug
from an acceptance check. A good repro case:

- names the **exact sequence** that triggers the bug, including how to force
  the failure: airplane mode for a failed request (see "Offline and API-down
  resilience" in `references/device-driving.md`), a fast double tap, rotating
  or backgrounding mid-request;
- states the **expected correct behaviour** as the expected result, not the
  bug. The case passes when the app behaves correctly;
- says what the bug would look like, so the person driving the device knows
  what to watch for.

Example:

| # | Test case | Steps (selectors) | Expected | Phone |
|---|-----------|-------------------|----------|:-----:|
| TC7 | Repro: failed sort refresh, then load more | open the list; airplane mode on; pick sort "price low to high" (`~sort-price-asc`); see the error; airplane mode off; scroll to the bottom | the list is either the old query's page 1 + 2, or the new query from page 1; never the old list with the new query's page 2 appended | pending |

Write the cases into a short list now (the case text plus the finding it
proves) so `test-plan` can number them. Mark `repro-cases` pass with the count:

```bash
node qc/state.js ABC-123 step code-review repro-cases pass 4 repro cases
node qc/state.js ABC-123 set code-review pass 4 risks, 4 repro cases
```

A risk you cannot turn into a device case (it needs a backend fault you cannot
force, or a timing window too narrow to hit by hand) goes into the plan as a
unit-test item instead, and into "Out of scope" for the device pass with that
reason.
