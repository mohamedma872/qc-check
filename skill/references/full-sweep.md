# Full-app sweep mode: QC every screen, no ticket needed

Triggered when the argument is `full`, `all` or `sweep` instead of a ticket id.
The run uses the pseudo-ticket **`FULL-SWEEP`** for state, plan and evidence
(`node qc/state.js FULL-SWEEP ...`). Everything in the main skill still applies:
resume rules, the visible task list, the findings log, and the test-plan
approval gate.

`qc/` is the installed runtime inside the host repo and `<reportsDir>/` is
`config.project.reportsDir` (default `qc-reports`).

## Phase mapping in sweep mode

| Phase | Sweep meaning |
|-------|---------------|
| `ticket` | Build the **screen inventory from the navigation code** (below). Derive it fresh every run: new screens must appear in the sweep |
| `test-plan` | Auto-generate the per-screen checklist into `<reportsDir>/FULL-SWEEP-plan.md`. **The user approval gate still applies** |
| `contract` | `set contract skipped sweep mode` (there is no single feature contract) |
| `smoke` | Health and auth, plus **one authenticated read per main screen's endpoint**, so a dead endpoint is known before the emulator boots |
| `phone` | The sweep itself: one sub-step per screen (`plan` them all before starting), one round per entry in `config.project.locales` |
| `tablet` / `ios` | Only if explicitly requested, same sweep |
| `unit-tests` | `set unit-tests skipped sweep mode` (no new logic under test) |
| `report` / `publish` | Sweep report (matrix below). With no ticket, save `<reportsDir>/FULL-SWEEP-report.md` and ask the user whether they want it posted anywhere. If `config.tracker.kind` is `"none"`, skip `publish` and leave the report on disk |

## Screen inventory (derive fresh in the `ticket` phase)

Source of truth: `config.codeMap.navigationGlob`. Grep each navigator for its
screen registrations (for a React Navigation app, the `name` prop on
`<*.Screen>`; for other stacks, the route table they declare) and list every
screen with the navigator it belongs to. Group the list the way the app is
built, for example:

- auth and onboarding screens;
- the main tabs;
- each tab's detail stack;
- settings / profile / support stacks;
- any multi-step form flow.

Do not carry a screen list over from a previous run, and never trust a list
written in a document: the inventory is whatever the navigation code says today.
Note any screen the grep finds that nobody expected, and any screen that has
disappeared.

Sub-step names: kebab-case each screen (`s-login`, `s-home`,
`s-personal-information`, and so on) and `plan` the full list on the phone phase
before starting:

```bash
node qc/state.js FULL-SWEEP plan phone preflight,connect,login,s-login,s-home,...,teardown
```

Add one round marker per extra locale (for example `...,s-profile,ar-round,teardown`
when `config.project.locales` is `["en","ar"]`).

## How to reach each screen (build the navigation map)

Write a "Reach via" cell for every screen in the plan before the sweep starts.
Derive it from the navigation code plus a first walk of the app:

- **Auth screens** need a logged-out state. If the build ships a dev-only "clear
  tokens" control, use it; otherwise clear app data (`adb shell pm clear <pkg>`,
  where `<pkg>` is `config.app.flavors[<flavor>].androidPackage`) and accept the
  re-login cost.
- **Tabs**: the bottom or side bar. Dump the tree first, because tab testIDs
  often exist.
- **Detail screens**: tap the first list item on the corresponding list screen.
  An empty list means widen or reset the filters; if it is still empty, check
  the endpoint with `node qc/api.js GET ...` and mark the screen BLOCKED by
  data, not silently skipped.
- **Filter and modal screens**: the control that opens them on the parent
  screen.
- **Multi-step forms**: walk them in order from their entry point, one sub-step
  per step.
- **Flow-gated outcome screens** (success, failure, cancellation confirmations)
  are reachable only by completing the action. On a test account, safe writes
  are allowed, and a round-trip that cleans up after itself (create then cancel)
  covers two screens at once. If an action cannot be performed safely, mark the
  screen "not reachable" with the reason in the plan. Never fake a pass.
- **Screens gated by real out-of-band codes** (OTP, payment confirmations):
  reach the screen, screenshot it, and back out rather than consuming a real
  code.

## Per-screen checks (the screen contract, every screen, every locale)

1. **Renders.** Screenshot named `FULL-SWEEP-<screen>-<locale>`. No crash
   overlay, no perpetual spinner (over 10 seconds), no blank screen.
2. **Key elements present.** `node qc/dump-tree.js`: the title and the primary
   content or CTA are visible. Record any interactive element with **no testID**
   (one yellow finding per screen, listing the elements).
3. **No error state.** No error toast, banner or error-empty state unless that
   state is legitimate. When in doubt, replay the screen's endpoint with
   `qc/api.js` and attribute the failure (red backend finding versus app bug).
4. **Data sanity.** List screens show data consistent with the API response;
   spot-check one field, for example the first item's title.
5. **Locale rounds.** After the first round, repeat the walk once per remaining
   entry in `config.project.locales`: switch the language in-app, restart the
   app if a locale in `config.project.rtlLocales` needs it to apply
   (`adb shell am force-stop <pkg>`), then check the layout mirrors for RTL
   locales and that no text is clipped, overlapping or untranslated. The
   reference for translated strings is `config.codeMap.translationsDir`, and an
   untranslated string is a yellow finding. With a single locale in
   `config.project.locales` there is only one round.
6. **Scroll check.** On scrollable screens, swipe to the bottom once. Clipped or
   overlapping content down there counts too.

## Sweep plan file (`<reportsDir>/FULL-SWEEP-plan.md`)

```markdown
# QC Full Sweep - all screens
Status: AWAITING APPROVAL
Backend: <env> · Build v<x.y.z> (<flavor> flavor) · Account: masked · Platforms: Android phone

| # | Screen | Reach via | <locale-1> | <locale-2> | Evidence |
|---|--------|-----------|:----------:|:----------:|----------|
| S1 | Login | clear tokens | pending | pending | |
| S2 | Signup | Login -> Sign Up | pending | pending | |
| ... | | | | | |

Legend: pending · PASS · FAIL · BLOCKED · not reachable (reason)

## Out of scope
- <e.g. consuming real one-time codes, destructive writes>
```

One status column per entry in `config.project.locales`. The report mirrors this
matrix plus the findings log and an overall verdict. Flip cells as screens
resolve: the plan is the live progress board.

## Sweep-specific rules

- **Order.** Logged-in screens first (tabs, then their stacks, then the form
  flows), auth screens last, because clearing the session ends the logged-in
  half of the sweep.
- **Recording.** One recording per locale round
  (`<reportsDir>/FULL-SWEEP-phone-<locale>.mp4`), restarted between rounds:
  30 minutes is the Appium cap.
- **Budget.** A full sweep is long. Persist every screen result the moment you
  observe it (`step phone s-<screen> pass|fail [note]` plus the plan cell) so an
  interrupted sweep resumes at the exact screen. Watch the run against
  `config.budget.runCap`, and tell the user before you blow through it rather
  than after.
- **Writes.** Safe writes are allowed on a test account (for example sending a
  support message, or a create-then-cancel round-trip). Never delete data the
  account needs to stay usable, and never touch another account's data.
