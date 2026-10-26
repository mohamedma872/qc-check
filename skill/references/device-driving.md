# Device passes: phone (required), tablet / iOS (on request) (phases `phone` / `tablet` / `ios`)

Only start here if the `smoke` phase was green. Never boot emulators against a
dead or erroring gateway.

Conventions used in this file:

| Placeholder | Comes from |
|-------------|-----------|
| `qc/` | where the installer put the runtime inside the host repo |
| `<run>/` | this run's folder: in your prompt, in `$QC_RUN_DIR`, printed by `node qc/runs.js current` |
| `ABC-123` | the ticket id |
| `<env>` | the run's environment, `QC_ENV`. It does not change during the run |
| `<flavor>` | `QC_FLAVOR`, else the flavor named `<env>`, else `config.app.defaultFlavor` |
| `<pkg>` | `config.app.flavors[<flavor>].androidPackage` |

## Platforms

| Profile | Command | Runs when |
|---------|---------|-----------|
| Android phone | `connect --platform android` (auto-boots `config.devices.android.avd`) | required, `config.devices.android.enabled` |
| Android tablet | `connect --platform android_tablet` (auto-boots `config.devices.android_tablet.avd`) | only if requested, `config.devices.android_tablet.enabled` |
| iOS (simulator or iPhone) | `connect --platform ios` (`config.devices.ios.deviceName` / `.udid`; a physical iPhone when `config.devices.ios.realDevice` is true) | only if the user explicitly asked, or the change is iOS-specific, `config.devices.ios.enabled` |

`connect` throws if that profile is disabled in the config. Do not ask which
platform to run: assume phone only unless the user says otherwise.

Run each form factor as its **own pass** (connect -> record -> cases -> stop
recording -> disconnect) with its own entry in your visible task list and its own
state entry. **Before starting the pass, plan its sub-steps**, one `case-N` per
TC in the approved test plan (`<run>/plan.md`; the numbering must
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
in the flavor the QC run targets (`<flavor>`, which follows `<env>`). The
command comes from the config, and a `{flavor}` in it is replaced with
`<flavor>` (for example `yarn android:{flavor}` becomes `yarn android:uat`):

| Target | Key |
|--------|-----|
| Android phone and tablet | `config.app.build.android` |
| iOS (simulator or iPhone) | `config.app.build.ios` |

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
Fix a mismatch by installing the `<env>` build, never by changing `QC_ENV`
mid-run.

## Pre-flight per pass

```bash
adb devices                                               # expect the target emulator
curl -s http://127.0.0.1:4723/status | head -c 60         # host/port from config.devices.appium
# if Appium is not up:
nohup appium --port 4723 --log /tmp/appium.log >/dev/null 2>&1 & sleep 5
```

Use `config.devices.appium.host` and `config.devices.appium.port` if they differ
from the defaults above.

**Android: check the device is healthy before you trust it.**

```bash
node qc/driver.js health            # boot flag, package/activity services, load average
```

`OK: healthy` means go. `ERROR: unhealthy - service package: not found` (or
`sys.boot_completed` not 1) means system_server is down or crash-looping: installs
then fail silently and launches hang, and every result from that device is
noise. Only a cold boot fixes it:

```bash
node qc/driver.js health --fix      # emu kill, then boot the configured AVD with -no-snapshot-load
```

Run `--fix` only after `health` said unhealthy (or that the AVD is not
running): it ends any open session, so `connect` again afterwards. If it is
still unhealthy after the cold boot, stop and report a blocker owned by the
user. `WARN: the device is overloaded` is not a failure, but expect slow,
flaky steps: allow more time per step rather than retrying in a loop.
`connect` runs the same check first and refuses an unhealthy device
(`--skip-health` exists for diagnosis, not for a pass).

**One device per profile, always.** With several devices attached, the driver
targets only the emulator whose AVD name is `config.devices.<profile>.avd` (or
the serial in `.udid`) and passes that serial to every adb call it makes.
`connect` records it in the session, and `record.sh` exports it as
`ANDROID_SERIAL`. When you run adb by hand, do the same: `adb -s <serial> ...`
with the serial `health` printed. Never run a bare `adb` command, and never
touch a device the config does not name: another lane may be driving it. `driver.js`, `dump-tree.js` and `record.sh` share one
session record per repo (`node qc/config.js --session-file` prints it), so
another repo QC'd on the same machine never touches this run's session; do not
set `QC_SESSION_FILE` yourself. If `connect` says the device is in use by
another QC run, do not delete that run's session file or retry in a loop: stop
and tell the user, and record it as a blocker owned by the user (they wait, or
give this repo its own `avd` / `udid`). iOS simulator:
`xcrun simctl list devices | grep Booted`, and check the booted simulator
matches `config.devices.ios.deviceName` / `config.devices.ios.udid`. If
`config.devices.<profile>.udid` is empty the driver lets Appium pick the single
attached device, which is what you want on a one-emulator machine.

**iOS with Xcode 27 (Device Hub):** Simulator.app is gone; simulators and
physical iPhones are both shown in Device Hub, and `xcrun devicectl list
devices` lists both (its `Reality` column says `simulated` or `physical`).
Never try `open -a Simulator`. To let the user watch a simulator pass, run
`open -b com.apple.dt.Devices`. When `config.devices.ios.realDevice` is true,
check the iPhone with that `udid` shows `connected` in `devicectl` before
`connect`; if it does not, stop and ask the user to unlock it, plug it in and
trust this Mac. The first session on a real device builds and signs
WebDriverAgent, which can take several minutes: that is not a hang. A signing
error names `config.devices.ios.teamId` as the fix; report it as a blocker owned
by the user, do not edit the config yourself. A real device keeps its own
state between runs, so log out at the end of the pass when a case logged in.

**iOS simulator WebDriverAgent:** the first simulator `connect` may print
`Building WebDriverAgent ...` and take about a minute: it is a one-time build
(`qc/wda.js`) that later sessions reuse, so do not interrupt it. Sessions then
start in about ten seconds. If `connect` still fails on iOS, read the failure
before retrying: `WARN: no prebuilt WebDriverAgent` means the build failed (its
log path is printed) and Appium fell back to xcodebuild, which hangs under
Xcode 26; "WebDriverAgentRunner-Runner cannot be opened" on the simulator, or
"Failed to start the preinstalled WebDriverAgent", means a stale cache, fixed
by `node qc/wda.js --rebuild`. Do not raise WDA timeouts or add WDA caps to
`qc.config.json` to work around it; report it as a blocker with the log.

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

`ASSERT FAILED - not visible` here means the wrong flavor build, that is, not
the `<env>` build. Reinstall (see the build note above) instead of continuing:
results from a build pointed at another environment prove nothing.

When `config.app.envBanner` is empty, verify the environment the slower way:
perform one read in the app and confirm the same data comes back from
`node qc/api.js GET <the-screen-endpoint>` against
`config.backend.baseUrls[<env>]`.

### Login (the `<env>` account, typed by the driver, never seen by you)

The login request is `config.backend.auth.method` on
`config.backend.auth.path`; the two fields on screen carry
`config.backend.auth.usernameField` and `config.backend.auth.passwordField`.
Each environment has its own QC account, kept in the gitignored
`config.credentialsFile` or in `QC_CRED_<ENV>_USERNAME` / `_PASSWORD`. You never
read either: do not open, `cat` or `require` the file, and do not echo the
variables. Never put a credential value into the transcript, a screenshot
caption, a report, or a ticket.

Selectors drift, so **dump the tree before you trust one**:

```bash
node qc/dump-tree.js --grep input          # confirm field ids and positions
```

Common realities worth checking rather than assuming:

- Input fields often have **no unique testID** and share one generic
  accessibility label, so a selector like `~Input Field` hits the first match
  only. On Flutter they often have **no name at all** (`EditText ~` in
  `dump-tree.js --all`), so no `--selector` reaches them. Run
  `node qc/driver.js audit-ids` on the screen: it lists every interactive
  element with no resource-id / content-desc (iOS: no identifier) and the
  command that still drives each one, usually
  `input --class android.widget.EditText --index <n>`. Record its suggested
  yellow finding with the ids you propose.
- Buttons are usually reachable by label (`~Log in`, `~Sign Up`, `~Remember me`,
  `~Forgot Password?`), but the label is locale-dependent (see below).
- Debug builds sometimes **prefill** a test account. Verify what is in the
  fields instead of assuming they are empty.
- Some builds ship a dev-only panel that clears stored tokens. If this one does,
  use it when a pass needs a fresh logged-out state instead of reinstalling.

A working shape for the typed login. `--credential` types the `<env>` account
straight into the field; the value never appears on a command line or in the
output:

```bash
node qc/driver.js input --selector "~Input Field" --index 0 --credential username
node qc/driver.js input --selector "~Input Field" --index 1 --credential password   # second field sharing the label
node qc/driver.js tap --selector "~Log in"
sleep 5
node qc/driver.js screenshot --name "after-login"
```

Fields with no testID at all, by class and position (`audit-ids` prints the
exact command), or by tapping a point to focus and typing into it:

```bash
node qc/driver.js audit-ids                                                      # which fields lack ids
node qc/driver.js input --class android.widget.EditText --index 0 --credential username
node qc/driver.js input --class android.widget.EditText --index 1 --credential password
node qc/driver.js input --x 540 --y 987 --credential password                    # tap to focus, then type
```

Use real testIDs when the fields have them. `--index` picks the nth match when
two fields share one label (or the nth field of a `--class`, in screen order).
`--credential` works the same with every target: the value goes straight to
Appium and never through adb, whose daemon logs every shell command into
logcat. If the driver says there are no credentials for
`<env>`, stop and ask the user to run `qc-check env credentials <env>`. Do not
type a value you got any other way.

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
SID=$(node -p "require('$(node qc/config.js --session-file)').sessionId")
curl -s -X POST "http://127.0.0.1:4723/session/$SID/alert/accept" -d '{}' -H 'Content-Type: application/json'
# .../alert/dismiss for the negative button
```

## Executing test cases (per pass)

**Start the recording first**, run the cases, then stop and save before
disconnecting:

```bash
qc/record.sh start 1800
# ... test cases ...
qc/record.sh stop phone       # or tablet / ios; saved as <run>/recordings/NNN-phone.mp4
node qc/driver.js disconnect
```

Pass a bare name, never a path. The script numbers the file and prints where it
went.

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
node qc/driver.js screenshot --name "tc2-saved"   # <run>/screenshots/NNN-tc2-saved.png
node qc/driver.js find --text "Label"
node qc/dump-tree.js --save "tc2-form"            # <run>/trees/NNN-tc2-form.txt
node qc/driver.js wait-for --text "Saved" --screenshot "tc3-snackbar"   # capture the instant it shows
node qc/driver.js wait-for --selector "~spinner" --gone --timeout 20000 # wait out a loader
node qc/driver.js open-url --url "https://www.example.com/p/ABC-123"     # deep link / App Link
node qc/driver.js log-mark                                              # start a network window (Android)
node qc/driver.js assert-request --grep 'products/ABC-123' --min 1      # the app called it
node qc/driver.js assert-request --grep 'recsForPlacements' --count 0   # the app did NOT call it
node qc/driver.js audit-ids                                             # interactive elements with no id
```

**Short-lived UI (snackbars, toasts, loaders).** A plain `screenshot` after the
tap is usually too late. `wait-for` polls (every 150 ms) until the element
matches and captures immediately, with `adb screencap` on Android; the
screenshot is numbered like any other and its path is printed. Text matches
include partial content-desc matches, since Flutter merges a widget's labels
into one. A timeout prints `ASSERT FAILED - ... did not appear` and still saves
a `<name>-timeout` capture of what was on screen instead. `--gone` waits for the
element to disappear (a loader finishing) and is the right way to wait instead
of `sleep`.

**Deep links.** `open-url` fires the URL at the app under test only (Android:
`am start` with `VIEW` + `BROWSABLE` and the `<pkg>` / activity from the
config; iOS simulator: `simctl openurl`). Pass the URL as given, quoted for
your own shell; the driver quotes it for the device. `OK: ... (delivered to the
running activity)` is a pass: the app was already open and received the link
in place. Then assert the screen it should land on, with `wait-for` or
`assert-visible`; `OK:` only proves the link was delivered, not routed. Each
`open-url` pushes a new screen, so press `back` once per link to unwind.

**Network assertions (Android only).** `assert-request` counts the app's own
network calls in `adb logcat`, so it only works when the build logs its
requests (most debug builds do: Dio's `LogInterceptor`, OkHttp's logging
interceptor). The shape is always mark, act, wait, assert:

```bash
node qc/driver.js log-mark                       # the window starts here
node qc/driver.js open-url --url "<link>"        # or the tap under test
node qc/driver.js wait-for --text "<something the screen shows when loaded>"
node qc/driver.js assert-request --grep 'recsForPlacements' --count 0
```

Wait for the screen to finish loading before asserting: an assert run right
after the action can say 0 because the call has not been made yet, which
passes a `--count 0` for the wrong reason. Counting rules: only lines from the
app's own process, never adbd's echo of your own commands, and a URL printed
again under a response header is not counted twice (`--all-lines` counts every
line, `--all-processes` every process). `--grep` is a regex. `--since <name>`
picks a mark set with `log-mark --name <name>`; with no `--since` the latest
mark is used, and with no mark at all the whole buffer is (a `WARN` says so).
`ASSERT FAILED - inconclusive: the log buffer rotated` means part of the window
is gone, so `--count` / `--max` cannot be proven: mark closer to the action and
run the step again. If the build does not log its requests, say so in the
case note and verify server-side with `qc/api.js` instead. On iOS,
`assert-request` and `log-mark` print `WARN: ... not supported on iOS` and exit
2: the check was not run, so mark that case blocked, never passed.

**Performance and memory probes (Android only).** Run these when the plan
asks for performance, a screen feels slow, or the change touches lists,
images, navigation or lifecycle code. They read `adb dumpsys`; on iOS they
print `WARN: ... Android-only` and exit 2 (profile with Instruments by hand and
mark the case blocked). Exit codes: `0` + `OK:` within limits, `3` + `FAIL:`
over a limit (record it as a finding, quoting the line), `2` + `WARN:` not
enough data or not comparable (not a pass), `1` + `ERROR:` the probe could not
run. Limits come from `config.perf` (`maxJankPct` 10, `maxP90Ms` 32,
`maxMemGrowthMb` 25, `maxColdStartMs` 4000, `leakLoopTimes` 10); a flag
overrides each. With `--label`, results are saved as JSON under `<run>/perf/`.

```bash
# Frames: reset, exercise the screen for a few seconds, read
node qc/driver.js perf --reset
node qc/driver.js swipe --direction up            # scroll / animate what is under test
node qc/driver.js perf --label tc4-scroll         # gfxinfo: jank %, p50/p90/p95/p99, slow UI thread...
node qc/driver.js perf --source surfaceflinger --label tc4-scroll-sf   # Flutter: see below

# Memory snapshot (MB: Java / Native heap, Code, Graphics, TOTAL PSS / RSS, Activities, Views...)
node qc/driver.js mem --gc --label before
node qc/driver.js mem --compare before            # vs now; --to <label> compares two saved ones

# Leak probe: warm-up, baseline, repeat the flow n times, measure, compare
node qc/driver.js leak-loop --label pdp --times 10 \
  --steps "open-url --url https://www.example.com/p/ABC-123; sleep --ms 4000; key --code BACK; sleep --ms 2000"

# Launch time: force-stop + am start -W, median of n runs
node qc/driver.js startup --cold --times 3
```

- **Flutter and gfxinfo.** gfxinfo counts frames drawn by Android views. A
  Flutter app draws through its own raster thread into a SurfaceView, so
  gfxinfo sees almost none of its frames and `perf` says `WARN: not enough
  data`. Use `perf --source surfaceflinger`, which times the app's SurfaceView
  buffer layer (frame time = gap between presents, jank = a frame over 1.5
  refresh periods, idle gaps excluded: approximate), or `flutter run
  --profile` with DevTools for a real frame breakdown.
- **Debug builds** are JIT-compiled with asserts on: frame and launch times
  are many times slower than release. The driver detects `DEBUGGABLE` and
  turns an over-limit result into `WARN: ... indicative only`. File a
  performance finding only from a profile or release build.
- **Memory.** A Flutter app's Dart heap is not in Java Heap: it is counted in
  Native Heap and Private Other. `--gc` sends `am send-trim-memory ... RUNNING_MODERATE`
  and waits 2 s (never a signal); it steadies the number but is not a full
  GC. Compare snapshots taken on the same screen, in the foreground, in one
  app session (a pid change makes `mem --compare` a WARN, exit 2): `mem`
  warns when the app is in the background, where Android trims it. TOTAL
  PSS includes swapped pages on recent releases; a WARN flags a swap shift
  between snapshots (device memory pressure), so check TOTAL RSS too.
- **What a leak looks like.** `mem --compare` and `leak-loop` fail when TOTAL
  PSS grows more than `maxMemGrowthMb` (or `--max-growth-pct`), or when
  Activities, ViewRootImpl or AppContexts grew: a screen that is gone but
  still referenced. One step of growth after the first pass is a cache (that
  is why leak-loop runs one warm-up first, `--warmup n`); steady growth per
  iteration is a leak. Re-run with a higher `--times` before filing it.
- **leak-loop steps** are driver commands separated by `;`, each run as its
  own `node qc/driver.js ...` process (quote values with spaces). They must end
  on the screen they start from: leak-loop aborts if an iteration leaves the
  app (a `back` / `key --code BACK` on the root screen, or a back pressed before
  the pushed screen appeared: add `sleep --ms`), and fails if the app process
  changes (a crash). `key --code BACK` needs only adb; `back`, `tap` and
  `wait-for` need the Appium session.

Screenshots land in `<run>/screenshots/`, numbered in capture order, and the
driver prints each path. That path, relative to `<run>/`, is what the report's
Evidence column cites. Name captures after the case (`tc2-...`) so the report is
easy to assemble. Never write evidence to a path of your own. A `WARN` that a
capture went to `_unsorted/` means no run is active: fix that first (see
"Where evidence goes" in the skill) and capture again. Save a tree with
`--save` when a finding depends on what the tree showed, for example a missing
testID.

The driver reports in plain text, not glyphs: `OK:` for a completed command,
`WARN:` for something that degraded, `ERROR:` for a failure, and
`ASSERT FAILED - <reason>` plus a non-zero exit code for a failed assertion.
Judge a step by the exit code and that marker, and quote the marker line in the
sub-step note when a case fails.

**Selector order:** `~testID` -> `--text` (current locale) -> `dump-tree.js` ->
coordinate tap (iOS scale: screenshot pixels divided by 3 = points on a 3x
device).

**Gotchas:**

- Elements with no testID or label are absent from the plain tree dump
  (`dump-tree.js --all` shows them, with a `class-index` you can pass to
  `input --class ... --index`). `audit-ids` lists them with a command for each;
  coordinate-tap the controls, and record every missing testID as a finding:
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
