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

The review covers six areas on every PR, plus plain correctness:

| Area | Key | What it is about | How a finding is proven |
|------|-----|------------------|-------------------------|
| Security (OWASP Mobile Top 10) | `owasp` | secrets, storage, transport, logging, WebView, deep-link input, manifest, crypto, dependencies | code + a device or API check where one exists |
| Performance | `perf` | non-lazy lists, work in `build`, N+1 requests, uncached images, jank, start time | `Probe:` case on device (`perf`, `startup`) |
| Memory leaks | `memory` | subscriptions, controllers, listeners, timers, unbounded caches, held `BuildContext` | `Probe:` case on device (`leak-loop`, `mem`) |
| Concurrency | `concurrency` | `context`/`setState` after `await`, bloc handlers without a transformer, double submit, out-of-order responses | `Repro:` case on device |
| Code standards | `standards` | the project's linter, debug leftovers, suppressed lints, untranslated strings, oversized files and functions | code only |
| Architecture | `architecture` | layer rules (domain, data, presentation), cross-feature imports, HTTP clients that bypass the shared one, service locators in widgets | code only, new violations only |

`qc/` is the installed runtime inside the host repo, `<run>/` is this run's
folder, and `ABC-123` stands for the ticket id. This phase runs after `ticket`
and before `test-plan`. It needs no approval: its output goes into the plan,
and the plan is what the user approves.

Sub-steps (record each with `node qc/state.js ABC-123 step code-review <name> <status>`):
`read-diff` -> `scan` -> `risks` -> `repro-cases`.

**Skip it** only when there is no diff to review: full-app sweep mode
(`set code-review skipped full sweep, no diff`) or a ticket with no code change
on this branch (`set code-review skipped no diff against <base>`).

**Time cap: about 20 minutes of reading,** or roughly 10% of
`config.budget.runCap` for a very large diff. When the cap hits, stop, record
what you have, and list the files you did not read as a yellow finding
("code review covered X of Y files"). The review feeds the device pass; it
does not replace it.

## 1. `read-diff` - read what changed, in context

```bash
BASE=$(node -p "require('./qc.config.json').repo.defaultBranch")
git diff --stat "$(git merge-base HEAD "$BASE")"...HEAD
git diff "$(git merge-base HEAD "$BASE")"...HEAD -- <file>
```

Use the base the `ticket` phase settled on (a release branch, if that is what
the PR targets). For a PR run, run these inside the build worktree
(`node qc/build.js path`), not the repository root. Read in this order: state
and data-layer code (stores, blocs, reducers, hooks, services) first, then the
screens that call them, then manifests and dependency files, then tests. For
each changed function, open enough of the surrounding file to see who calls it
and what state it reads. A diff hunk alone hides the bug as often as it shows
it.

**Delegate when the diff is large.** Over about 25 changed source files, or
several unrelated modules, hand each module to a sub-agent if your agent can
spawn one (Claude Code: the Agent tool; other agents: do it yourself, module by
module). Give each one the file list, the ticket's acceptance criteria, the
scan leads for its files and the checklist in section 3, and ask for findings
in the format of section 3 with file and function names. You still own the
merge: drop duplicates, and check every finding against the code yourself
before it goes into the plan.

## 2. `scan` - let the script find the mechanical leads

```bash
node qc/review-scan.js --base "$BASE" --lint --save
```

It reads only the lines this PR adds, sorts what it finds into the six areas,
and saves `<run>/review/scan.md` and `scan.json`. `--lint` also runs the
project's linter (`config.review.lintCommand`, or `flutter analyze` / `eslint`
when none is set) and keeps only the issues on lines this PR touched.
Architecture rules come from `config.review.layers`; with none set, the script
applies the usual `features/<name>/{data,domain,presentation}` rules when the
repository has that layout.

**Every scan hit is a lead, not a finding.** The rules are patterns and they
have false positives: a "controller never disposed" whose dispose lives in a
mixin, a `context` after `await` that sits behind a `mounted` check two lines
up. Open each lead, decide, and carry only the real ones into `risks`. A rule
that is mostly noise for this repository goes into `config.review.disable`.
Secret values are always masked in the output; never unmask one into a report
or a finding. Mark the step with the counts:

```bash
node qc/state.js ABC-123 step code-review scan pass 23 leads, 7 kept
```

Two things the scan gives you that the diff alone does not:

- **Pre-existing counts for architecture rules.** If the codebase already has
  40 presentation-to-data imports, a new one is a yellow "please don't add
  more", not a red. Only imports this PR adds are leads.
- **Lint issues split by origin:** on added lines (this PR's) versus elsewhere
  in touched files (already there). Only the first kind goes in the review.

When the script is missing (an older install) or fails, say so in the step
note and do the same checks by reading. The scan saves time; it is not the
review.

## 3. `risks` - what to look for

Work through every area below for the changed code. The scan covers the
mechanical part of each; the rest needs a reader who knows what the code is
supposed to do.

**Correctness** (these are the bugs that ship most often):

- **State and lifecycle.** State updated before the request succeeds and not
  rolled back on failure. A value that outlives the screen (a singleton, a
  cached store). A widget or component that uses its state after it is gone.
- **Error paths.** What the user sees when the call fails, times out, or
  returns an empty or partial body. A catch that swallows the error and leaves
  a spinner forever. Retry that repeats a non-idempotent write. Every failure
  shown with the same message ("not found" when it was really offline).
- **Pagination and lists.** The page counter or cursor not reset when the
  query, filter, sort or search changes. "Has more" computed from the wrong
  page. Duplicates or gaps at page boundaries.
- **Null and shape handling.** Optional fields read as required, a list
  assumed non-empty, a number parsed from a string that can be missing, an
  enum value the app does not know.
- **Locale and direction,** when `config.project.locales` has more than one
  entry: strings concatenated instead of formatted, layout that assumes
  left-to-right.

**Security, against the OWASP Mobile Top 10 (2024).** Name the category in
the finding (for example "M9 Insecure Data Storage"):

- **M1 Credentials:** keys, tokens or passwords in the source or the build
  config. A key that has to ship in the app (a public search key) is fine; a
  server secret is not.
- **M3 Authentication and authorisation:** a screen or action that checks the
  user only in the UI; data from the previous user visible after logout or
  account switch; a token that is not cleared on logout.
- **M4 Input validation:** deep-link and push payload values used in a URL,
  a WebView or a request without validation or an allowlist; WebView with
  JavaScript bridges that load content the app does not control.
- **M5 Transport:** `http://`, disabled certificate checks, cleartext
  allowed in the manifest or `Info.plist`.
- **M6 and M9 Privacy and storage:** tokens or personal data logged, put in a
  URL, sent to analytics, or kept in plain preferences instead of the
  Keychain or Keystore (`flutter_secure_storage`, `EncryptedSharedPreferences`).
- **M8 Misconfiguration:** new exported components, `debuggable`,
  `allowBackup`, new permissions the feature does not need.
- **M2 Supply chain:** each new or bumped dependency. Check it is maintained
  and has no open advisory (`osv-scanner`, `npm audit`, the package page).
- **M10 Cryptography:** MD5 or SHA1 for anything security-related,
  non-secure random for tokens or nonces.

Where the device or API can prove it, plan a case: log in, log out, and check
the previous user's data is gone; look for the token in `adb logcat` during
the flow (`assert-request` with the token name and `--count 0`); call the
endpoint without the token and expect 401.

**Performance:**

- Lists built eagerly (`ListView(children: ...map(...))`, `shrinkWrap: true`
  inside a scroll) where the data can be long; use the builder form.
- Work done on every rebuild: parsing, sorting, formatting, regexes, or
  network calls inside `build` or a render function.
- One request per item in a loop (N+1) where one batched call exists.
- Network images decoded at full size (no `cacheWidth` / resize) in long
  lists.
- A `setState` on every scroll tick, or a provider or bloc that rebuilds the
  whole screen for a change to one field.
- Anything on the app start path (new initialisation, a blocking call before
  the first frame).

Plan a `Probe:` case for each real risk (section 4).

**Memory leaks:**

- A `StreamSubscription`, `Timer`, `AnimationController`,
  `TextEditingController`, `ScrollController`, `FocusNode`,
  `StreamController` or listener that is created and never cancelled,
  disposed or removed. In a bloc or cubit, a subscription not cancelled in
  `close()`.
- A controller created inside `build`, so it is recreated on every rebuild.
- A `BuildContext`, widget or screen stored in a long-lived object.
- A static or module-level cache that only grows.
- Native: an `Activity` or `Context` held by a singleton, a listener
  registered with the system and never removed.

Plan a `Probe:` leak loop that opens and leaves the affected screen
repeatedly (section 4).

**Concurrency:**

- `context` (navigation, snackbars, dialogs, `context.read`) or `setState`
  used after an `await` with no `mounted` check: it crashes or acts on the
  wrong screen when the user leaves first.
- A bloc handler for search, filter, sort, refresh or load-more registered
  without a transformer. Since bloc 8 handlers run concurrently, so two
  requests can finish in either order and the older result wins. Use
  `restartable()`, `droppable()` or `sequential()` as fits.
- Out-of-order responses in type-ahead and fast filter switching, with no
  request id or cancellation.
- A submit button that stays tappable while its request runs (double order,
  double payment).
- Navigation while a write is pending; pull-to-refresh during load-more.
- Shared mutable state (static fields, module-level variables) written from
  more than one async flow.

These become `Repro:` cases: tap twice fast, leave the screen mid-request,
switch filters quickly, throttle the network.

**Code standards** (code only, never a device case):

- New analyzer or lint issues on lines this PR added (from the scan).
- Debug leftovers (`print`, `console.log`), suppressed lints
  (`// ignore:`, `eslint-disable`) without a reason, new TODOs without a
  ticket.
- Hardcoded user-facing strings in a localised app.
- Oversized new functions or files, duplicated logic that already has a
  helper in the codebase.
- The repo's own conventions: read `CONTRIBUTING`, `analysis_options.yaml`
  or the lint config, and the code around the change, and flag what breaks
  them.

**Architecture** (code only):

- An import that crosses a layer the wrong way: domain importing data,
  presentation or the framework; presentation importing data directly; one
  feature reaching into another feature's data or presentation internals.
- A new HTTP client created outside the shared network module, which skips
  its interceptors (auth, logging, retry).
- A service locator used inside widgets instead of constructor injection or
  a provider.
- Business logic in a widget that belongs in the bloc or use case, or in a
  repository that belongs in the domain.
- Only **new** violations count. When the pattern already exists elsewhere
  in the codebase, say so in the finding ("the codebase already has 34 of
  these") and keep it yellow.

For each risk you keep, record a finding at once. Start the text with the
area key, and say whether it is still unconfirmed:

```bash
node qc/state.js ABC-123 finding yellow "concurrency, from code review, not yet reproduced: <what the user would see> when <sequence>. Cause: <file>:<function> <one line>. Repro: TC<n>"
node qc/state.js ABC-123 finding yellow "owasp M9, from code review: refresh token written to plain SharedPreferences in <file>:<function>. Suggest flutter_secure_storage"
node qc/state.js ABC-123 finding yellow "architecture, from code review: presentation imports data (<file> -> <import>); the codebase already has 34. New in this PR"
```

**Severity:**

- `red` only with proof: a device reproduction, a failing unit test
  (`references/unit-tests.md`), a failed probe, or, for security, a secret or
  cleartext call you can see in the build or traffic. A predicted bug stays
  `yellow` until it is proven; when the device case reproduces it, record a
  new `red` finding that cites the evidence and names the code-review finding
  it confirms. When the case passes, the prediction was wrong and the plan
  cell says so.
- A server secret committed to the repo is `red` on sight: it is already
  leaked, whatever the device shows.
- Code standards and architecture findings are `yellow` (or `minor` in the
  review comment). Group them: one finding per rule with the file list, not
  one per line.

Not every oddity is a risk worth a test case. Keep the ones where you can say
what the user, the business or the next developer would suffer. Style
preferences that are not in the repo's own rules are out of scope.

## 4. `repro-cases` - turn every risk into a test case

Correctness and concurrency risks become **`Repro:`** cases. Performance and
memory risks become **`Probe:`** cases. Security risks become one or the other
when the device or API can show them. Code standards and architecture
findings get no test case; they go straight to the report and the review
comment.

A good `Repro:` case:

- names the **exact sequence** that triggers the bug, including how to force
  the failure: airplane mode for a failed request (see "Offline and API-down
  resilience" in `references/device-driving.md`), a fast double tap, rotating
  or backgrounding mid-request;
- states the **expected correct behaviour** as the expected result, not the
  bug. The case passes when the app behaves correctly;
- says what the bug would look like, so the person driving the device knows
  what to watch for.

A good `Probe:` case names the flow, the driver command that measures it and
the threshold (defaults come from `config.perf`):

- **Leak loop:** the screen the PR touched, opened and left N times.
  `node qc/driver.js leak-loop --steps "open-url --url <deep link>; sleep --ms 4000; key --code BACK" --times 10 --label pdp`.
  Give each visit time to load before leaving, or Back may leave the app instead.
  It fails when memory grows past `config.perf.maxMemGrowthMb` or the
  Activity or view counts grow. Use a deep link or adb-only steps where you
  can, so the loop does not depend on selectors.
- **Jank:** `node qc/driver.js perf --reset`, then drive the flow (scroll the
  new list to the end, open the new sheet), then
  `node qc/driver.js perf --label <name>`. It fails on more than
  `config.perf.maxJankPct` janky frames or a slow 90th percentile.
- **Start time,** when the PR touches start-up:
  `node qc/driver.js startup --cold --times 3`.

Measure on the build under test and, for any probe that fails, once on the
base build with the same steps (`references/baseline.md`). A probe failure is
only a PR finding when the base build passes or is clearly better. Debug
builds are slow and memory-heavy: state the build type with every number,
and treat absolute values from a debug build as indicative. Compare the two
builds rather than judging one number.

Example:

| # | Test case | Steps (selectors) | Expected | Phone |
|---|-----------|-------------------|----------|:-----:|
| TC7 | Repro: failed sort refresh, then load more | open the list; airplane mode on; pick sort "price low to high" (`~sort-price-asc`); see the error; airplane mode off; scroll to the bottom | the list is either the old query's page 1 + 2, or the new query from page 1; never the old list with the new query's page 2 appended | pending |
| TC8 | Repro: double tap Place order | fill checkout; tap Place order twice fast | one order created, button disabled while it runs | pending |
| TC9 | Probe: product page leak loop | `leak-loop --steps "open-url --url <pdp link>; sleep --ms 4000; key --code BACK" --times 10` | memory growth under 25 MB, Activity count unchanged | pending |
| TC10 | Probe: search list jank | `perf --reset`; search "table"; scroll to the end; `perf --label search` | janky frames under 10% | pending |

Write the cases into a short list now (the case text plus the finding it
proves) so `test-plan` can number them. Mark `repro-cases` pass with the count:

```bash
node qc/state.js ABC-123 step code-review repro-cases pass 3 repro, 2 probe cases
node qc/state.js ABC-123 set code-review pass 9 risks (2 owasp, 1 perf, 1 memory, 2 concurrency, 2 standards, 1 architecture), 5 cases
```

A risk you cannot turn into a device case (it needs a backend fault you cannot
force, or a timing window too narrow to hit by hand) goes into the plan as a
unit-test item instead, and into "Out of scope" for the device pass with that
reason.
