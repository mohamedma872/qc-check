# Device passes: phone (required), tablet / iOS (on request) (phases `phone` / `tablet` / `ios`)

Only start here if the `smoke` phase was green. Never boot emulators against a
dead or erroring gateway.

Conventions used in this file:

| Placeholder | Comes from |
|-------------|-----------|
| `qc/` | where the installer put the runtime inside the host repo |
| `<reportsDir>/` | `config.project.reportsDir` (default `qc-reports`) |
| `ABC-123` | the ticket id |
| `<flavor>` | `QC_FLAVOR`, else `config.app.defaultFlavor` |
| `<pkg>` | `config.app.flavors[<flavor>].androidPackage` |

## Platforms

| Profile | Command | Runs when |
|---------|---------|-----------|
| Android phone | `connect --platform android` (auto-boots `config.devices.android.avd`) | required, `config.devices.android.enabled` |
| Android tablet | `connect --platform android_tablet` (auto-boots `config.devices.android_tablet.avd`) | only if requested, `config.devices.android_tablet.enabled` |
| iOS Simulator | `connect --platform ios` (`config.devices.ios.deviceName` / `.udid`) | only if the user explicitly asked, or the change is iOS-specific, `config.devices.ios.enabled` |

`connect` throws if that profile is disabled in the config. Do not ask which
platform to run: assume phone only unless the user says otherwise.

Run each form factor as its **own pass** (connect -> record -> cases -> stop
recording -> disconnect) with its own entry in your visible task list and its own
state entry. **Before starting the pass, plan its sub-steps**, one `case-N` per
TC in the approved test plan (`<reportsDir>/ABC-123-plan.md`; the numbering must
match):

```bash
node qc/state.js ABC-123 plan phone preflight,connect,login,record,case-1,case-2,...,teardown
```

Record every transition as you go:

```bash
node qc/state.js ABC-123 step phone case-2 pass|fail|blocked [note]
```

`preflight` = adb/Appium up · `connect` / `login` = the sections below ·
`record` = recording started · each `case-N` = one test case · `teardown` = stop
recording and disconnect. A failed case gets its note ("Expected vs Actual")
right on the step. As each case resolves, also flip that TC's cell in the plan
file (pass/fail/blocked glyph plus a short note): the approved plan doubles as
the progress board the user reviews.

## Build and install first

**The app must be built and installed on each target device before the pass**,
in the flavor the QC run targets (`<flavor>`). The command comes from the
config:

| Target | Key |
|--------|-----|
| Android phone and tablet | `config.app.build.android` |
| iOS Simulator | `config.app.build.ios` |

Run it from the host repo root with the target device already booted. **If the
key is an empty string, do not guess a build command:** ask the user how to
build and install the `<flavor>` flavor and wait for an answer (Claude Code:
AskUserQuestion; Codex and other agents: print the question and stop until the
user replies). Offer to record their answer in `qc.config.json` so the next run
does not have to ask.

`connect` failing with `ERROR: failed to create session` plus an "Activity
class ... does not exist" message from the device means the app (or the right
flavor) is not installed there: run the build command again for that device, or
ask the user to, then wait. The activity the driver launches is
`config.app.androidActivity`; the package is `<pkg>`.

**"Requested internal only, but not enough space" on install.** Debug builds can
be several hundred MB when they carry every ABI, and shared emulator images run
near-full. Fix both sides: free space (`adb shell df -h /data`, uninstall stale
dev apps) and build for the emulator's ABI only, which also installs much
faster. If `config.app.build.android` is a Gradle install task, that is, for
example:

```bash
adb shell getprop ro.product.cpu.abi          # the ABI the emulator wants
./gradlew installDebug -PreactNativeArchitectures=arm64-v8a
```

Then launch through `node qc/driver.js connect`, or by hand:

```bash
adb shell am start -n <pkg>/<config.app.androidActivity>
```

**The environment is usually baked in at build time** (product flavor -> env
file -> base URL). Most apps have no in-app environment switcher: if the app
hits the wrong backend, it is the wrong flavor build, so reinstall rather than
hunting for a hidden settings screen. `qc/api.js` (host side) and the installed
build must target the same environment (`config.backend.baseUrls[<env>]`).

## Pre-flight per pass

```bash
adb devices                                               # expect the target emulator
curl -s http://127.0.0.1:4723/status | head -c 60         # host/port from config.devices.appium
# if Appium is not up:
nohup appium --port 4723 --log /tmp/appium.log >/dev/null 2>&1 & sleep 5
```

Use `config.devices.appium.host` and `config.devices.appium.port` if they differ
from the defaults above. `driver.js`, `dump-tree.js` and `record.sh` share one
session record at `/tmp/qc-session.json`; set `QC_SESSION_FILE` to another path
when two repos are QC'd side by side, and export it for every command in the
pass, including `record.sh` and the iOS alert snippet below. iOS: `xcrun simctl list devices | grep Booted`, and
check the booted simulator matches `config.devices.ios.deviceName` /
`config.devices.ios.udid`. If `config.devices.<profile>.udid` is empty the driver
lets Appium pick the single attached device, which is what you want on a
one-emulator machine.

**Android notes:**

- `testID` maps to `content-desc` / `resource-id`, so `~my-test-id` selectors
  work. `--text` matches `text` or `content-desc`.
- System dialogs: tap by text (`tap --text "Allow"`, `"While using the app"`).
- Hardware back: `node qc/driver.js back`.

**Tablet-specific checks (when requested):** verify the **responsive layout**.
No clipped or overlapping elements, modals sized for the wider screen, touch
targets reachable. Screenshot and compare against the phone pass, and note any
layout that does not adapt.

## Connect and branch on what you see

```bash
node qc/driver.js connect --platform android    # or android_tablet / ios
node qc/driver.js screenshot --name "after-connect"
```

Look at the screenshot, then handle whichever state you are in. With
`noReset: true` the app keeps its previous state, so you may land on a login
screen, an onboarding or language screen, or already inside the app (a previous
QC session's login can persist in the platform keychain/keystore).

### Verify the environment FIRST

`config.app.envBanner` is the text the app shows to mark a non-production
build. When it is set, assert it before anything else: it proves the right
flavor is installed.

```bash
node qc/driver.js assert-visible --text "<config.app.envBanner>"
```

`ASSERT FAILED - not visible` here means the wrong flavor build. Reinstall (see
the build note above) instead of continuing: results from a build pointed at
another environment prove nothing.

When `config.app.envBanner` is empty, verify the environment the slower way:
perform one read in the app and confirm the same data comes back from
`node qc/api.js GET <the-screen-endpoint>` against
`config.backend.baseUrls[<env>]`.

### Login (credentials from `config.credentialsFile`, never hardcoded)

The login request is `config.backend.auth.method` on
`config.backend.auth.path`; the two fields on screen carry
`config.backend.auth.usernameField` and `config.backend.auth.passwordField`.
Credentials live in `config.credentialsFile` at the host repo root, which is
gitignored. Never echo a credential value into the transcript, a screenshot
caption, a report, or a ticket.

Selectors drift, so **dump the tree before you trust one**:

```bash
node qc/dump-tree.js --grep input          # confirm field ids and positions
```

Common realities worth checking rather than assuming:

- Input fields often have **no unique testID** and share one generic
  accessibility label, so a selector like `~Input Field` hits the first match
  only. Target the second field by its center coordinates from `dump-tree.js`,
  and record the missing testIDs as a yellow finding with the ids you suggest.
- Buttons are usually reachable by label (`~Log in`, `~Sign Up`, `~Remember me`,
  `~Forgot Password?`), but the label is locale-dependent (see below).
- Debug builds sometimes **prefill** a test account. Verify what is in the
  fields instead of assuming they are empty.
- Some builds ship a dev-only panel that clears stored tokens. If this one does,
  use it when a pass needs a fresh logged-out state instead of reinstalling.

A working shape for the typed login, with the values read from the credentials
file and never printed:

```bash
USER=$(node -p "const c=require('./qc.credentials.js'); c[c.env].username")
PASS=$(node -p "const c=require('./qc.credentials.js'); c[c.env].password")
node qc/driver.js input --selector "~Input Field" --text "$USER"
node qc/driver.js tap --x <px> --y <py>       # password field center from dump-tree
adb shell input text "$PASS"                   # types into the focused field
node qc/driver.js tap --selector "~Log in"
sleep 5
node qc/driver.js screenshot --name "after-login"
```

(Use the path in `config.credentialsFile`; the example above is the default
`qc.credentials.js`.)

- **5xx here** means the backend is erroring: re-check `node qc/api.js --health`.
- **"Network request failed"** means a wrong or unreachable host, which is almost
  certainly the wrong flavor build (see the build note above).
- **Post-login routing depends on the account's server state.** An account with
  an incomplete profile or a pending step can land on an onboarding screen
  rather than the home screen. Check the account state server-side first
  (`node qc/api.js GET <profile-endpoint>`) and plan the test cases around the
  state the QC account is actually in, or move it into the right state
  deliberately.
- An **OTP or second-factor screen** may appear. If the code arrives
  out-of-band, ask the user for it and wait for an answer (Claude Code:
  AskUserQuestion; Codex and other agents: print the question and stop until the
  user replies). If a second factor blocks every QC login, record a yellow
  tooling finding: QC needs an exempt test account.
- Accept the **notification** permission prompt, and grant camera/location
  prompts when a flow needs them (Android: tap by text; iOS: see the alert
  endpoint below).

### Language and direction

Driven by `config.project.locales` and `config.project.rtlLocales`.

- **One locale in `config.project.locales`:** there is no language round. Use
  `testID` selectors anyway, and read display strings from
  `config.codeMap.translationsDir` when you need to tap by text.
- **More than one locale:** `--text` matches the **current locale's** strings,
  so look them up in `config.codeMap.translationsDir` before tapping by text,
  and prefer `testID` selectors, which are language-independent. For UI tickets
  the approved plan should include one case per additional locale: switch the
  language in-app and confirm the screen is translated with no clipped or
  overlapping text. Screenshot every locale for the evidence trail.
- **A locale listed in `config.project.rtlLocales`** also needs a direction
  check: the layout must mirror (icons, back arrows, text alignment). A
  direction change often needs an app restart to fully apply, so relaunch
  (`adb shell am force-stop <pkg>`, then reconnect) and do not count that
  restart as a bug.

### Offline and API-down resilience (errors appear mid-run)

If the app starts erroring mid-run (empty lists, error toasts), pinpoint the
failing request by replaying it from the host:

```bash
node qc/api.js GET '/v1/<the-screen-endpoint>'
```

Report the exact status and body as a **backend finding** if it errors. That is
usually a backend problem, not your test. Retry the device action once it
recovers.

For offline-behaviour test cases, actually **cut the network**. `adb` stays
alive, since the debug-server tunnel is independent of the radio:

```bash
D=emulator-5554                       # the target device serial
adb -s $D shell svc wifi disable
adb -s $D shell svc data disable
adb -s $D shell cmd connectivity airplane-mode enable
sleep 6                               # let the app's connectivity listener propagate
# ... drive the app: expect its offline/error state, not a crash ...
adb -s $D shell cmd connectivity airplane-mode disable
adb -s $D shell svc wifi enable && adb -s $D shell svc data enable
```

**Debug build plus airplane mode caveat.** A debug build that fetches its
JavaScript bundle from a dev server on cold start will fail to boot while
offline ("Unable to load script"). That is a build-harness artifact, not a
product bug. For a true cold offline restart, ask for a release build.

**System dialogs can hide your screen (Android).** Platform dialogs (for
example a location-accuracy prompt from Play services) can pop over a screen and
reappear. Dismiss them by text (`node qc/driver.js tap --text "No thanks"`). If a
tree dump shows only a dialog's strings, that is why your selector "vanished".

### iOS system dialogs (only on iOS passes)

Springboard alerts are not in the app's tree, so `tap --text "Allow"` misses
them:

```bash
SID=$(node -p "require(process.env.QC_SESSION_FILE || '/tmp/qc-session.json').sessionId")
curl -s -X POST "http://127.0.0.1:4723/session/$SID/alert/accept" -d '{}' -H 'Content-Type: application/json'
# .../alert/dismiss for the negative button
```

## Executing test cases (per pass)

**Start the recording first**, run the cases, then stop and save before
disconnecting:

```bash
qc/record.sh start 1800
# ... test cases ...
qc/record.sh stop <reportsDir>/ABC-123-phone.mp4    # or -tablet.mp4 / -ios.mp4
node qc/driver.js disconnect
```

Recording is flaky on headless emulators; `record.sh stop` says so if the file
is empty. Fall back to screenshots and note it. **Never block QC on video.**
Per-step screenshots are the primary evidence; the video is the walkthrough.

Driver commands:

```bash
node qc/driver.js tap --selector "~testID"      # preferred
node qc/driver.js tap --text "Label"
node qc/driver.js tap --x <n> --y <n>           # from dump-tree centers
node qc/driver.js long-press --selector "~id" --duration 800
node qc/driver.js input --selector "~id" --text "value"
node qc/driver.js assert-visible --selector "~id"      # non-zero exit + "ASSERT FAILED - ..." = FAIL
node qc/driver.js assert-not-visible --text "Error"
node qc/driver.js swipe --direction up
node qc/driver.js screenshot --name "step"
node qc/driver.js find --text "Label"
```

Screenshots land in `<reportsDir>/`, which is what the report's Evidence column
points at.

The driver reports in plain text, not glyphs: `OK:` for a completed command,
`WARN:` for something that degraded, `ERROR:` for a failure, and
`ASSERT FAILED - <reason>` plus a non-zero exit code for a failed assertion.
Judge a step by the exit code and that marker, and quote the marker line in the
sub-step note when a case fails.

**Selector order:** `~testID` -> `--text` (current locale) -> `dump-tree.js` ->
coordinate tap (iOS scale: screenshot pixels divided by 3 = points on a 3x
device).

**Gotchas:**

- Elements with no testID or label are absent from the accessibility tree.
  Coordinate-tap them, and record every missing testID as a finding:
  `node qc/state.js ABC-123 finding yellow '<Component> missing testID ...'`.
- A repeated testID across list items? Scope with `--within <container-testID>`
  (bounds-based, so it survives view flattening).
- Long lists make automation calls slow. Add `sleep`, do not spam retries.
- Session ended? **Reconnect.** App state persists (`noReset: true`), so a modal
  you opened is still open.
- Toggling the network mid-session can drop the Appium session, which is
  expected on offline tests. Reconnect, and prefer verifying post-reconnect
  state **server-side** with a `qc/api.js` readback.
- Never assume a selector from a previous run still exists. Dump the tree, look
  at the screenshot, and react to what is on screen.
