#!/usr/bin/env node
// QC Driver - Appium CLI helper for the QC skill.
// No external dependencies: it speaks the Appium REST API over Node's http.
// Session state is persisted between commands in one record per host repo
// (/tmp/qc-session-<repo>-<id>.json; QC_SESSION_FILE overrides it), so repos
// QC'd side by side never share a session.
// Every device, app and server value comes from qc.config.json via config.js.
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const device = require('./device.js');

// config.js is required lazily so `--help` works in a repo with no config yet.
function config() {
  // eslint-disable-next-line global-require
  return require('./config.js');
}

let sessionPath = null;
function sessionFile() {
  if (!sessionPath) {sessionPath = config().sessionFile();}
  return sessionPath;
}

// --- Appium endpoint ---------------------------------------------------------

// Resolved from qc.config.json, then overridden by the live session record so
// a session opened against another host keeps working.
let appiumTarget = null;

function target() {
  if (appiumTarget) {return appiumTarget;}
  const { devices } = config().loadConfig();
  const appium = (devices && devices.appium) || {};
  appiumTarget = { host: appium.host || '127.0.0.1', port: appium.port || 4723 };
  return appiumTarget;
}

// --- HTTP --------------------------------------------------------------------

function appiumRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const data = body !== null ? JSON.stringify(body) : null;
    const { host, port } = target();
    const options = {
      hostname: host,
      port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(options, res => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ raw });
        }
      });
    });
    req.on('error', reject);
    if (data) {req.write(data);}
    req.end();
  });
}

// --- Session -----------------------------------------------------------------

function loadSession() {
  if (!fs.existsSync(sessionFile())) {
    const self = process.argv[1] || 'driver.js';
    console.error(`ERROR: no active QC session (${sessionFile()} missing). Run:`);
    console.error(`   node ${self} connect --platform <profile>`);
    process.exit(1);
  }
  const session = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
  if (session.host && session.port) {
    appiumTarget = { host: session.host, port: session.port };
  }
  return session;
}

// --- Element finding ---------------------------------------------------------

async function tryFindAll(sessionId, using, value) {
  const res = await appiumRequest('POST', `/session/${sessionId}/elements`, { using, value });
  return Array.isArray(res.value) ? res.value.filter(el => getElementId(el)) : [];
}

async function elementRect(sessionId, el) {
  const res = await appiumRequest('GET', `/session/${sessionId}/element/${getElementId(el)}/rect`);
  return res.value && typeof res.value.x === 'number' ? res.value : null;
}

// All elements matching the selector (testID) or text, in document order.
async function findCandidates(sessionId, platform, selector, text) {
  if (selector) {
    const id = selector.startsWith('~') ? selector.slice(1) : selector;

    // 1. Accessibility ID - matches testID on iOS; on Android this only
    //    matches content-desc, which React Native testIDs do not set.
    const els = await tryFindAll(sessionId, 'accessibility id', id);
    if (els.length) {return els;}

    // 2. Android: React Native maps testID to resource-id, so search there.
    if (platform !== 'ios') {
      const els2 = await tryFindAll(sessionId, 'xpath', `//*[@resource-id="${id}"]`);
      if (els2.length) {return els2;}
    }
  }

  if (text) {
    if (platform === 'ios') {
      const els = await tryFindAll(
        sessionId,
        '-ios predicate string',
        `label == "${text}" OR value == "${text}" OR name == "${text}"`,
      );
      if (els.length) {return els;}
    } else {
      // Exact matches first. A substring search would also hit any longer text
      // that happens to contain the word, such as a paragraph above a tab bar,
      // and the first hit wins, so the tap lands on the wrong element.
      for (const value of [
        `new UiSelector().text("${text}")`,
        `new UiSelector().description("${text}")`,
      ]) {
        const els = await tryFindAll(sessionId, '-android uiautomator', value);
        if (els.length) {return els;}
      }
      const partial = await tryFindAll(
        sessionId,
        '-android uiautomator',
        `new UiSelector().textContains("${text}")`,
      );
      if (partial.length) {
        console.warn(`WARN: no exact match for "${text}", using a partial match (${partial.length} candidate(s)). Prefer a testID.`);
        return partial;
      }
    }

    const xpath =
      platform === 'ios'
        ? `//*[@label="${text}" or @value="${text}" or @name="${text}"]`
        : `//*[@text="${text}" or @content-desc="${text}"]`;
    const els2 = await tryFindAll(sessionId, 'xpath', xpath);
    if (els2.length) {return els2;}
  }

  return [];
}

async function findElement(sessionId, platform, selector, text, within, index) {
  const candidates = await findCandidates(sessionId, platform, selector, text);
  const idx = index !== undefined ? Number(index) : 0;
  if (!within) {return candidates[idx] || null;}

  // Scoped search: needed when the same testID repeats per list item (every
  // row carries the same action-button testID) - scope with the row's unique
  // container testID:
  //   --within list-item-4 --selector action-button
  // Scoping is by BOUNDS, not tree ancestry: view flattening can hoist a
  // container's children to siblings in the accessibility tree, so we take the
  // first candidate whose centre lies inside the scope element's rect.
  const parent = await findElement(sessionId, platform, within, null);
  if (!parent) {return null;}
  const p = await elementRect(sessionId, parent);
  if (!p) {return null;}

  for (const el of candidates) {
    const r = await elementRect(sessionId, el);
    if (!r) {continue;}
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (cx >= p.x && cx <= p.x + p.width && cy >= p.y && cy <= p.y + p.height) {
      return el;
    }
  }
  return null;
}

function getElementId(el) {
  return el['element-6066-11e4-a52e-4f735466cecf'] || el.ELEMENT;
}

// --- Pointer gestures (coordinate-based) -------------------------------------

// W3C pointer tap/hold at absolute screen coordinates. `holdMs` controls the
// dwell between down and up - a short value taps, a long value long-presses.
async function pointerAt(sessionId, x, y, holdMs = 60) {
  await appiumRequest('POST', `/session/${sessionId}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: holdMs },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
}

// Resolve the tap point: explicit --x/--y, else the centre of a found element.
async function resolvePoint(sessionId, platform, { x, y, selector, text, within }) {
  if (x !== undefined && y !== undefined) {
    return { x: Number(x), y: Number(y) };
  }
  if (selector || text) {
    const el = await findElement(sessionId, platform, selector, text, within);
    if (!el) {return null;}
    const rect = await appiumRequest('GET', `/session/${sessionId}/element/${getElementId(el)}/rect`);
    const r = rect.value || {};
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }
  return null;
}

// --- Arg parsing -------------------------------------------------------------

// Shared with test/driver.js, which checks it without a device.
const { parseArgs } = device;

// --- Device sharing between repos ---------------------------------------------

// Is another repo's recorded session still open on its Appium server? A
// record left behind by a crashed run answers no, so it never blocks anyone.
function sessionAlive(record) {
  return new Promise(resolve => {
    const req = http.request(
      {
        hostname: record.host || '127.0.0.1',
        port: record.port || 4723,
        path: `/session/${record.sessionId}/timeouts`,
        method: 'GET',
        timeout: 3000,
      },
      res => {
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          try {
            const v = JSON.parse(raw).value;
            resolve(Boolean(v) && !v.error);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Opening a session on a device another repo is driving kills that repo's
// session mid-pass. Find such a session before we connect. An unpinned
// profile (no udid or avd) lets Appium pick any device, so it clashes with
// every live session on the same platform.
async function deviceHolder(capabilities, basePlatform) {
  const want = capabilities['appium:udid'] || capabilities['appium:avd'] || null;
  for (const file of config().sessionFiles()) {
    if (file === sessionFile()) {continue;}
    let other;
    try {
      other = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!other.sessionId || other.platform !== basePlatform) {continue;}
    const theirs = other.deviceIds || [];
    if (want && theirs.length && !theirs.includes(want)) {continue;}
    if (await sessionAlive(other)) {return { file, other };}
  }
  return null;
}

// --- Commands ----------------------------------------------------------------

async function cmdConnect(opts) {
  const { capsFor, deviceProfiles, loadConfig } = config();
  const cfg = loadConfig();
  const profiles = deviceProfiles();
  const requested = opts.platform || opts.profile;
  const platform = typeof requested === 'string' ? requested : null;

  if (!platform || !profiles.includes(platform)) {
    const enabled = profiles.filter(p => cfg.devices[p].enabled);
    console.error(`Usage: connect --platform <${profiles.join('|')}> [--flavor <name>]`);
    console.error(`   Enabled in qc.config.json: ${enabled.join(', ') || 'none'}`);
    process.exit(1);
  }

  const flavor = typeof opts.flavor === 'string' ? opts.flavor : undefined;
  const deviceCfg = cfg.devices[platform] || {};
  if (platform === 'ios' && !deviceCfg.realDevice && process.platform === 'darwin') {
    // One-time build of the simulator WDA capsFor() hands to Appium. On failure
    // the session falls back to Appium's own xcodebuild launch.
    // eslint-disable-next-line global-require
    const res = require('./wda.js').prepare();
    if (res.error) {
      console.error(`WARN: no prebuilt WebDriverAgent (${res.error}); Appium will build it with xcodebuild.`);
      if (res.log) {console.error(`   see ${res.log}`);}
    }
  }
  let capabilities;
  try {
    capabilities = capsFor(platform, flavor);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  // Base platform drives selector strategies (predicate vs uiautomator); the
  // profile name (e.g. android_tablet) only selects which capabilities to use.
  const basePlatform = capabilities.platformName.toLowerCase() === 'ios' ? 'ios' : 'android';
  const { host, port } = target();

  const holder = await deviceHolder(capabilities, basePlatform);
  if (holder) {
    const device = capabilities['appium:udid'] || capabilities['appium:avd'] || `the ${basePlatform} device`;
    const owner = holder.other.project || holder.file;
    console.error(`ERROR: ${device} is in use by another QC run (${owner}).`);
    console.error('   Wait for that run to finish, or give this repo its own device:');
    const pin = basePlatform === 'ios' ? 'udid' : 'avd or .udid';
    console.error(`   set devices.${platform}.${pin} in qc.config.json.`);
    console.error(`   Stuck from a crashed run? Delete ${holder.file}`);
    process.exit(1);
  }

  // Android: pin the session to this profile's own device and refuse a sick
  // one up front. A device whose system_server keeps dying accepts the session
  // and then fails installs and launches silently, which reads as app bugs.
  let serial = null;
  if (basePlatform === 'android') {
    serial = androidPreflight(platform, deviceCfg, opts);
    // Pinned after the holder check, which compares the configured ids.
    if (serial && !capabilities['appium:udid']) {capabilities['appium:udid'] = serial;}
  }

  console.log(`Creating Appium session for ${platform} at ${host}:${port} ...`);

  const res = await appiumRequest('POST', '/session', {
    capabilities: { alwaysMatch: capabilities },
  });

  if (!res.value || !res.value.sessionId) {
    console.error('ERROR: failed to create session. Is Appium running? Is the app installed / emulator bootable?');
    console.error(`   Start Appium: appium --port ${port}`);
    console.error('   Response:', JSON.stringify(res, null, 2));
    process.exit(1);
  }

  const session = {
    sessionId: res.value.sessionId,
    profile: platform,
    platform: basePlatform,
    flavor: flavor || cfg.app.defaultFlavor,
    host,
    port,
    // The adb serial every adb call of this session targets (Android).
    ...(serial ? { serial } : {}),
    // Who holds the device, for other repos' deviceHolder() checks: the
    // configured ids plus whatever Appium actually picked.
    project: cfg.repoRoot,
    deviceIds: [
      ...new Set(
        [
          capabilities['appium:udid'],
          capabilities['appium:avd'],
          serial,
          res.value.capabilities && res.value.capabilities.udid,
          res.value.capabilities && res.value.capabilities.deviceUDID,
        ].filter(Boolean),
      ),
    ],
  };
  fs.writeFileSync(sessionFile(), JSON.stringify(session, null, 2));
  console.log(`OK: session created: ${session.sessionId}`);
  console.log(
    `   profile: ${platform} (${basePlatform}) | flavor: ${session.flavor} | app: ` +
      `${capabilities['appium:bundleId'] || capabilities['appium:appPackage']}`,
  );
}

async function cmdDisconnect() {
  const { sessionId } = loadSession();
  await appiumRequest('DELETE', `/session/${sessionId}`);
  if (fs.existsSync(sessionFile())) {fs.unlinkSync(sessionFile());}
  console.log('OK: session closed');
}

async function cmdTap({ selector, text, x, y, within, index }) {
  const { sessionId, platform } = loadSession();

  // Coordinate tap - for elements with no testID / not in the a11y tree.
  if (x !== undefined && y !== undefined) {
    await pointerAt(sessionId, Number(x), Number(y), 60);
    console.log(`OK: tapped at (${x}, ${y})`);
    return;
  }

  const el = await findElement(sessionId, platform, selector, text, within, index);
  if (!el) {
    const targetName = selector || text;
    console.error(`ERROR: element not found: "${targetName}"`);
    console.error('   Tip: run `find --text "..."` to inspect the element tree,');
    console.error('   or tap by coordinate: tap --x <n> --y <n>');
    process.exit(1);
  }
  const elId = getElementId(el);

  // A text label inside a button is often not clickable itself. An element
  // click on it is accepted and silently does nothing, which reads as a pass.
  // A real touch at its centre reaches the clickable parent, the way a finger
  // does, so use that whenever the match is not clickable.
  if (platform === 'android') {
    const attr = await appiumRequest('GET', `/session/${sessionId}/element/${elId}/attribute/clickable`);
    if (String(attr.value) === 'false') {
      const rect = (await appiumRequest('GET', `/session/${sessionId}/element/${elId}/rect`)).value || {};
      if (rect.width !== undefined) {
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        await pointerAt(sessionId, cx, cy, 60);
        console.log(`OK: tapped "${selector || text}" by touch at (${Math.round(cx)}, ${Math.round(cy)}), the match itself is not clickable`);
        return;
      }
    }
  }

  await appiumRequest('POST', `/session/${sessionId}/element/${elId}/click`, {});
  console.log(`OK: tapped "${selector || text}"`);
}

async function cmdLongPress({ selector, text, x, y, duration, within }) {
  const { sessionId, platform } = loadSession();
  const holdMs = duration ? Number(duration) : 1000;
  const point = await resolvePoint(sessionId, platform, { x, y, selector, text, within });
  if (!point) {
    console.error(`ERROR: long-press target not found: "${selector || text || `${x},${y}`}"`);
    console.error('   Provide --selector/--text or --x <n> --y <n>');
    process.exit(1);
  }
  await pointerAt(sessionId, point.x, point.y, holdMs);
  console.log(`OK: long-pressed (${Math.round(point.x)}, ${Math.round(point.y)}) for ${holdMs}ms`);
}

async function cmdAssertVisible({ selector, text, within }) {
  const { sessionId, platform } = loadSession();
  const el = await findElement(sessionId, platform, selector, text, within);
  if (!el) {
    console.error(`ASSERT FAILED - not visible: "${selector || text}"`);
    process.exit(1);
  }
  // Existing but hidden elements (e.g. a collapsed banner at 0 height) must
  // not pass a visibility assert.
  const shown = await appiumRequest(
    'GET',
    `/session/${sessionId}/element/${getElementId(el)}/displayed`,
  );
  if (shown.value === false) {
    console.error(`ASSERT FAILED - element exists but is not displayed: "${selector || text}"`);
    process.exit(1);
  }
  console.log(`OK: visible "${selector || text}"`);
}

async function cmdAssertNotVisible({ selector, text, within }) {
  const { sessionId, platform } = loadSession();
  const el = await findElement(sessionId, platform, selector, text, within);
  if (el) {
    console.error(`ASSERT FAILED - element IS visible (expected hidden): "${selector || text}"`);
    process.exit(1);
  }
  console.log(`OK: not visible, as expected: "${selector || text}"`);
}

async function cmdScreenshot({ name }) {
  const { sessionId } = loadSession();

  const res = await appiumRequest('GET', `/session/${sessionId}/screenshot`);
  // A dead/invalid session returns an error object in `value`, not a base64 string.
  if (typeof res.value !== 'string') {
    const msg = res.value && res.value.message ? res.value.message : JSON.stringify(res);
    console.error(`ERROR: screenshot failed: ${msg}`);
    console.error('   The session may have ended - reconnect with: connect --platform <profile>');
    process.exit(1);
  }

  savePng(Buffer.from(res.value, 'base64'), name);
}

// Save a PNG as numbered evidence inside the run in progress (runs.js), or
// _unsorted/ with a warning when no run is active.
function savePng(png, name, note = '') {
  // eslint-disable-next-line global-require
  const filepath = require('./runs.js').artifactPath(
    'screenshots',
    typeof name === 'string' ? name : 'screenshot',
    'png',
  );
  fs.writeFileSync(filepath, png);
  console.log(`OK: screenshot saved: ${filepath}${note}`);

  // A capture of a single flat colour compresses to almost nothing. Evidence
  // that is secretly a blank image is worse than no evidence, so say so.
  // Common cause: an emulator on host GPU rendering that screen capture cannot
  // read. Width and height sit at fixed offsets in the PNG header.
  if (png.length > 24 && png.toString('ascii', 12, 16) === 'IHDR') {
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    const bytesPerPixel = png.length / Math.max(1, w * h);
    if (bytesPerPixel < 0.01) {
      console.warn(`WARN: this screenshot looks blank (${png.length} bytes for ${w}x${h}). Do not use it as evidence.`);
      console.warn('   On an Android emulator, restart it with -gpu swiftshader_indirect and capture again.');
    }
  }
  return filepath;
}

// Read one credential field for the active environment. The value is returned
// to the caller and never logged, never placed in an error message and never
// passed on a command line: this is what keeps the agent out of the loop.
function credentialValue(field) {
  const { activeEnv, credentialsFor, envVarNames, loadCredentials } = config();
  const env = activeEnv();

  let creds;
  try {
    // Env vars first, then the credentials file block (config.js).
    creds = credentialsFor(env);
  } catch (err) {
    // config.js names the setup command and the env vars, never a value.
    const names = envVarNames(env);
    console.error(`ERROR: ${err.message || err}`);
    if (!/qc-check env credentials/.test(String(err.message))) {
      console.error(`   Set them with: qc-check env credentials ${env}`);
      console.error(`   or export ${names.user} and ${names.pass}.`);
    }
    process.exit(1);
  }

  if (field === 'username' || field === 'password') {return creds[field];}

  // Any other field (a PIN, a second factor seed) can only come from the
  // environment's block in a hand-written credentials file.
  let block = null;
  try {
    block = (loadCredentials() || {})[env] || null;
  } catch {
    block = null;
  }
  const value = block ? block[field] : undefined;
  if (typeof value !== 'string' || !value || value === 'CHANGE_ME') {
    const fields = ['username', 'password', ...Object.keys(block || {}).filter(
      k => k !== 'username' && k !== 'password',
    )].join(', ');
    console.error(
      `ERROR: credential field "${field}" is not set for environment "${env}" - fields available: ${fields}.`,
    );
    console.error(`   Set credentials with: qc-check env credentials ${env}`);
    process.exit(1);
  }
  return value;
}

async function cmdInput(opts) {
  const { text, credential } = opts;
  const hasText = typeof text === 'string';
  const hasCredential = credential !== undefined;

  if (hasText && hasCredential) {
    console.error('ERROR: --text and --credential are mutually exclusive.');
    console.error('   Use --credential <field> to type a value the agent never sees.');
    process.exit(1);
  }
  if (hasCredential && typeof credential !== 'string') {
    console.error('ERROR: --credential needs a field name, e.g. --credential password');
    process.exit(1);
  }
  // Where to type. The plan never holds the value (see device.inputTarget).
  const tgt = device.inputTarget(opts);
  if (tgt.error) {
    console.error(`ERROR: ${tgt.error}`);
    process.exit(1);
  }

  // Resolved before the session work so a config problem fails fast. From
  // here on the value only travels in the Appium request body below: never in
  // argv, never through adb (adbd writes every shell command to logcat), never
  // in a message.
  const value = hasCredential ? credentialValue(credential) : (hasText ? text : '');

  const { sessionId, platform } = loadSession();
  let el = null;
  if (tgt.kind === 'selector') {
    el = await findElement(sessionId, platform, tgt.selector, null, tgt.within, tgt.index);
  } else if (tgt.kind === 'class') {
    // Fields with no testID (a Flutter TextField shows up as a bare EditText)
    // are still reachable by class and position on screen.
    const all = await tryFindAll(sessionId, 'class name', tgt.cls);
    el = all[tgt.index] || null;
    if (!el && all.length) {
      console.error(`ERROR: only ${all.length} ${tgt.cls} on screen, --index ${tgt.index} is out of range`);
      process.exit(1);
    }
  } else {
    // Tap to focus, then type into whatever took the focus.
    await pointerAt(sessionId, tgt.x, tgt.y, 60);
    await new Promise(r => setTimeout(r, 400));
    const active = await appiumRequest('GET', `/session/${sessionId}/element/active`);
    el = active.value && getElementId(active.value) ? active.value : null;
    if (!el) {
      console.error(`ERROR: tapped ${tgt.label} but no field took the focus. Check the coordinates with dump-tree.js.`);
      process.exit(1);
    }
  }
  if (!el) {
    console.error(`ERROR: input field not found: "${tgt.label}"`);
    if (tgt.kind === 'selector') {
      console.error('   No testID? Try: input --class android.widget.EditText --index <n>  (see audit-ids)');
    }
    process.exit(1);
  }
  const elId = getElementId(el);
  await appiumRequest('POST', `/session/${sessionId}/element/${elId}/clear`, {});
  const res = await appiumRequest('POST', `/session/${sessionId}/element/${elId}/value`, {
    text: value,
    value: value.split(''),
  });
  if (res.value && res.value.error) {
    // Appium's message can echo the request, so only its error code is shown.
    console.error(`ERROR: typing into "${tgt.label}" failed (${res.value.error})`);
    process.exit(1);
  }
  // Typed values can be credentials, so only the length is ever reported.
  const what = hasCredential ? `credential "${credential}"` : 'text';
  console.log(`OK: typed ${what} (${value.length} characters) into "${tgt.label}"`);
}

async function cmdSwipe({ direction }) {
  const valid = ['up', 'down', 'left', 'right'];
  if (!valid.includes(direction)) {
    console.error(`Usage: swipe --direction ${valid.join('|')}`);
    process.exit(1);
  }

  const { sessionId } = loadSession();
  const winRes = await appiumRequest('GET', `/session/${sessionId}/window/rect`);
  const { width = 390, height = 844 } = winRes.value || {};
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const delta = Math.floor(height * 0.35);

  const vectors = {
    up:    [cx, cy + delta, cx, cy - delta],
    down:  [cx, cy - delta, cx, cy + delta],
    left:  [cx + delta, cy, cx - delta, cy],
    right: [cx - delta, cy, cx + delta, cy],
  };
  const [sx, sy, ex, ey] = vectors[direction];

  await appiumRequest('POST', `/session/${sessionId}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: sx, y: sy },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 100 },
          { type: 'pointerMove', duration: 600, x: ex, y: ey },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
  console.log(`OK: swiped ${direction}`);
}

async function cmdBack() {
  const { sessionId, platform } = loadSession();
  if (platform !== 'android') {
    console.error('ERROR: back is Android only (iOS has no hardware back button)');
    process.exit(1);
  }
  await appiumRequest('POST', `/session/${sessionId}/back`, {});
  console.log('OK: Android back pressed');
}

async function cmdFind({ text, selector, within }) {
  const { sessionId, platform } = loadSession();
  const el = await findElement(sessionId, platform, selector, text, within);

  if (!el) {
    const query = text || selector;
    console.log(`Element not found for: "${query}"`);
    console.log('Dumping page source (first 4000 chars) for selector debugging ...');
    const src = await appiumRequest('GET', `/session/${sessionId}/source`);
    // `value` is normally an XML string, but can be an object on a dead session.
    const xml = typeof src.value === 'string' ? src.value : JSON.stringify(src.value);
    if (xml) {
      process.stdout.write(xml.slice(0, 4000));
      console.log('\n...(truncated)');
    }
    return;
  }

  const elId = getElementId(el);
  const [textRes, labelRes, valueRes, enabledRes, visibleRes] = await Promise.all([
    appiumRequest('GET', `/session/${sessionId}/element/${elId}/text`),
    appiumRequest('GET', `/session/${sessionId}/element/${elId}/attribute/label`),
    appiumRequest('GET', `/session/${sessionId}/element/${elId}/attribute/value`),
    appiumRequest('GET', `/session/${sessionId}/element/${elId}/attribute/enabled`),
    appiumRequest('GET', `/session/${sessionId}/element/${elId}/displayed`),
  ]);

  console.log('Element found:');
  console.log(`   id:         ${elId}`);
  console.log(`   text:       ${textRes && textRes.value}`);
  console.log(`   label:      ${labelRes && labelRes.value}`);
  console.log(`   value:      ${valueRes && valueRes.value}`);
  console.log(`   enabled:    ${enabledRes && enabledRes.value}`);
  console.log(`   displayed:  ${visibleRes && visibleRes.value}`);
}

// --- Device targeting (Android serial pinning) ----------------------------------

// The session record without exiting when there is none: health, open-url and
// log-mark also work before connect.
function readSessionSoft() {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    if (s.host && s.port) {appiumTarget = { host: s.host, port: s.port };}
    return s;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Profile, device block and app ids a device-level command acts on:
// --platform, else the live session's profile, else android.
function deviceContext(opts) {
  const cfg = config().loadConfig();
  const session = readSessionSoft();
  const profile = typeof opts.platform === 'string' ? opts.platform
    : (session && session.profile) || 'android';
  const deviceCfg = cfg.devices[profile];
  if (!deviceCfg || profile === 'appium') {
    console.error(`ERROR: unknown device profile "${profile}" (devices.* in qc.config.json)`);
    process.exit(1);
  }
  const isIOS = profile === 'ios';
  const flavor = typeof opts.flavor === 'string' ? opts.flavor
    : (session && session.flavor) || cfg.app.defaultFlavor;
  const flavorCfg = (cfg.app.flavors || {})[flavor] || {};
  return {
    cfg,
    session: session && session.profile === profile ? session : null,
    profile,
    deviceCfg,
    isIOS,
    flavor,
    pkg: flavorCfg.androidPackage || '',
    activity: flavorCfg.androidActivity || cfg.app.androidActivity || '',
    bundleId: flavorCfg.iosBundleId || '',
  };
}

// The adb serial of this profile's own device, or exit with the reason. With
// several devices attached it matches the configured avd (by
// ro.boot.qemu.avd_name) or udid and never falls back to another device.
function serialOrExit(ctx) {
  const want = { avd: ctx.deviceCfg.avd || '', udid: ctx.deviceCfg.udid || '' };
  const res = device.resolveSerial(want, { preferred: ctx.session && ctx.session.serial });
  if (!res.serial) {
    console.error(`ERROR: ${res.error}`);
    if (res.notRunning && want.avd) {
      console.error(`   Boot it with: node ${process.argv[1]} health --fix   (or connect, which boots it)`);
    }
    process.exit(1);
  }
  return res.serial;
}

// --- Health -----------------------------------------------------------------------

function healthOf(serial) {
  try {
    return device.parseHealth(device.adb(serial, ['shell', device.HEALTH_SHELL], { timeout: 15000 }));
  } catch (err) {
    const why = String(err.stderr || err.message || err).trim().split('\n')[0];
    return { healthy: false, problems: [`adb shell failed: ${why}`], load: [], cpus: null };
  }
}

function printHealth(serial, avd, h) {
  console.log(`   device: ${serial}${avd ? ` (avd ${avd})` : ''}`);
  if (h.bootCompleted !== undefined) {
    console.log(`   sys.boot_completed: ${h.bootCompleted ? '1' : 'no'}`);
    console.log(`   service package: ${h.packageService} | service activity: ${h.activityService}`);
  }
  if (h.load && h.load.length) {
    console.log(`   load average: ${h.load.join(' ')}${h.cpus ? ` (${h.cpus} CPUs)` : ''}`);
  }
  if (h.overloaded) {
    console.warn(`WARN: the device is overloaded (load ${h.load[0]} on ${h.cpus} CPUs). Expect slow, flaky steps; close other emulators or wait.`);
  }
}

function emulatorBinary() {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'emulator', 'emulator');
    if (fs.existsSync(p)) {return p;}
  }
  return 'emulator';
}

function attachedSerials() {
  try {
    return device.parseAdbDevices(device.adb(null, ['devices'], { timeout: 10000 }));
  } catch {
    return [];
  }
}

// Cold boot the profile's AVD on a given console port: no snapshot, so a
// corrupted system_server state cannot come back with it.
async function coldBoot(ctx, serial, port, timeoutMs) {
  const avd = ctx.deviceCfg.avd;
  if (serial) {
    console.log(`   killing ${serial} ...`);
    try {
      device.adb(serial, ['emu', 'kill'], { timeout: 15000 });
    } catch {
      // A wedged emulator may not answer the console; wait for it to go anyway.
    }
    const until = Date.now() + 60000;
    while (attachedSerials().some(d => d.serial === serial)) {
      if (Date.now() > until) {
        console.error(`ERROR: ${serial} did not shut down within 60s. Close that emulator window, then run health --fix again.`);
        process.exit(1);
      }
      await sleep(1000);
    }
  }
  const extra = Array.isArray(ctx.deviceCfg.emulatorArgs) ? ctx.deviceCfg.emulatorArgs.map(String) : [];
  const args = ['-avd', avd, '-port', String(port), '-no-snapshot-load', '-no-boot-anim', ...extra];
  const logFile = path.join(os.tmpdir(), `qc-emulator-${port}.log`);
  const out = fs.openSync(logFile, 'a');
  console.log(`   cold booting ${avd} on port ${port} (log: ${logFile}) ...`);
  const child = spawn(emulatorBinary(), args, { detached: true, stdio: ['ignore', out, out] });
  child.on('error', err => {
    console.error(`ERROR: could not start the emulator (${err.code || err.message}). Set ANDROID_HOME.`);
    process.exit(1);
  });
  child.unref();

  const newSerial = `emulator-${port}`;
  const started = Date.now();
  let h = null;
  while (Date.now() - started < timeoutMs) {
    await sleep(3000);
    if (!attachedSerials().some(d => d.serial === newSerial && d.state === 'device')) {continue;}
    h = healthOf(newSerial);
    if (h.healthy) {break;}
  }
  return { serial: newSerial, health: h, seconds: Math.round((Date.now() - started) / 1000) };
}

async function cmdHealth(opts) {
  const ctx = deviceContext(opts);
  if (ctx.isIOS) {
    console.warn('WARN: health checks Android devices only (boot flag and system services via adb); nothing to check on iOS.');
    return;
  }
  const fix = opts.fix === true;
  const timeoutMs = Number(opts.timeout) || 300000;
  const want = { avd: ctx.deviceCfg.avd || '', udid: ctx.deviceCfg.udid || '' };
  const res = device.resolveSerial(want, { preferred: ctx.session && ctx.session.serial });

  if (!res.serial) {
    // Not running at all: --fix may boot it, on a port no other emulator uses.
    if (fix && res.notRunning && want.avd && !want.udid) {
      const port = device.freeEmulatorPort(res.devices || []);
      const booted = await coldBoot(ctx, null, port, timeoutMs);
      return reportFixed(ctx, booted);
    }
    console.error(`ERROR: ${res.error}`);
    process.exit(1);
  }

  const serial = res.serial;
  const h = healthOf(serial);
  printHealth(serial, res.avd, h);
  if (h.healthy) {
    console.log(fix ? 'OK: healthy, nothing to fix' : 'OK: healthy');
    return;
  }
  console.error(`ERROR: unhealthy - ${h.problems.join('; ')}`);
  if (!fix) {
    console.error('   Installs and launches fail silently on a device in this state.');
    console.error(`   Cold boot it with: node ${process.argv[1]} health --fix`);
    process.exit(1);
  }
  const port = device.emulatorPort(serial);
  if (!want.avd || port === null) {
    console.error(`ERROR: --fix cold boots an emulator from its configured avd; ${serial} is ${port === null ? 'not an emulator' : 'not pinned by devices.' + ctx.profile + '.avd'}.`);
    console.error('   Restart the device by hand.');
    process.exit(1);
  }
  if (ctx.session) {
    console.warn('WARN: this ends the open Appium session; connect again afterwards.');
  }
  const booted = await coldBoot(ctx, serial, port, timeoutMs);
  reportFixed(ctx, booted);
}

function reportFixed(ctx, booted) {
  if (!booted.health || !booted.health.healthy) {
    const why = booted.health ? booted.health.problems.join('; ') : 'it never came online';
    console.error(`ERROR: still unhealthy after ${booted.seconds}s - ${why}`);
    console.error('   Wipe the AVD data in Device Manager, or report it as a blocker.');
    process.exit(1);
  }
  printHealth(booted.serial, ctx.deviceCfg.avd, booted.health);
  console.log(`OK: healthy after a cold boot (${booted.seconds}s)`);
}

// connect's pre-check. Returns the serial to pin, or null when the AVD is not
// running yet (Appium boots it from appium:avd).
function androidPreflight(profile, deviceCfg, opts) {
  const want = { avd: deviceCfg.avd || '', udid: deviceCfg.udid || '' };
  const res = device.resolveSerial(want);
  if (!res.serial) {
    if (res.notRunning && want.avd) {
      console.log(`   ${want.avd} is not running; Appium will boot it.`);
      return null;
    }
    console.error(`ERROR: ${res.error}`);
    process.exit(1);
  }
  if (opts['skip-health'] === true) {return res.serial;}
  const h = healthOf(res.serial);
  if (!h.healthy) {
    console.error(`ERROR: ${res.serial} is unhealthy - ${h.problems.join('; ')}`);
    console.error(`   Cold boot it with: node ${process.argv[1]} health --fix   then connect again.`);
    process.exit(1);
  }
  if (h.overloaded) {
    console.warn(`WARN: ${res.serial} is overloaded (load ${h.load[0]} on ${h.cpus} CPUs); steps will be slow.`);
  }
  console.log(`   device ${res.serial}${res.avd ? ` (avd ${res.avd})` : ''}: healthy`);
  return res.serial;
}

// --- Deep links ----------------------------------------------------------------------

async function cmdOpenUrl(opts) {
  const url = opts.url;
  if (typeof url !== 'string' || !url) {
    console.error('Usage: open-url --url <url> [--platform <profile>] [--flavor <name>]');
    process.exit(1);
  }
  const ctx = deviceContext(opts);

  if (ctx.isIOS) {
    if (ctx.deviceCfg.realDevice) {
      console.warn('WARN: open-url drives simulators only; on a physical iPhone open the link from Notes or Safari by hand.');
      process.exit(2);
    }
    const udid = ctx.deviceCfg.udid || 'booted';
    try {
      // execFile, no shell: the URL is one argv entry, so & and ? are inert.
      execFileSync('xcrun', ['simctl', 'openurl', udid, url], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      });
    } catch (err) {
      console.error(`ERROR: simctl openurl failed: ${String(err.stderr || err.message).trim().split('\n').pop()}`);
      process.exit(1);
    }
    console.log(`OK: opened ${url} on simulator ${udid}`);
    return;
  }

  if (!ctx.pkg) {
    console.error(`ERROR: app.flavors.${ctx.flavor}.androidPackage is not set in qc.config.json`);
    process.exit(1);
  }
  const serial = serialOrExit(ctx);
  let out;
  try {
    out = String(device.adb(serial, ['shell', device.amStartViewCommand(url, ctx.pkg, ctx.activity)], { timeout: 30000 }));
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}` || String(err.message);
  }
  const failed = device.amStartFailed(out);
  if (failed) {
    console.error(`ERROR: the link did not open: ${failed}`);
    if (/unable to resolve|does not exist/i.test(failed)) {
      console.error(`   Is ${ctx.pkg} installed, and does it declare an intent filter for this URL?`);
    }
    process.exit(1);
  }
  const how = device.amStartOutcome(out);
  console.log(`OK: opened ${url} in ${ctx.pkg} on ${serial}${how ? ` (${how})` : ''}`);
}

// --- Network assertions from logcat ---------------------------------------------------

// Bookmarks live next to the session record, one file per repo.
function marksFile() {
  return `${sessionFile()}.logmarks`;
}

function readMarks() {
  try {
    return JSON.parse(fs.readFileSync(marksFile(), 'utf8'));
  } catch {
    return {};
  }
}

// The device clock, so host/device clock skew cannot move the window.
function deviceEpoch(serial) {
  const out = String(device.adb(serial, ['shell', 'date +%s.%N'], { timeout: 10000 })).trim();
  const n = Number(out);
  if (!Number.isNaN(n)) {return n;}
  return Number(String(device.adb(serial, ['shell', 'date +%s'], { timeout: 10000 })).trim());
}

async function cmdLogMark(opts) {
  const ctx = deviceContext(opts);
  if (ctx.isIOS) {
    console.warn('WARN: log-mark and assert-request read adb logcat and are not supported on iOS. Verify calls with qc/api.js instead.');
    process.exit(2);
  }
  const serial = serialOrExit(ctx);
  const name = typeof opts.name === 'string' ? opts.name : 'default';
  if (opts.clear === true) {
    device.adb(serial, ['logcat', '-c'], { timeout: 15000 });
  }
  const epoch = deviceEpoch(serial);
  const marks = readMarks();
  marks[name] = { epoch, serial, at: new Date().toISOString() };
  marks.__last = name;
  fs.writeFileSync(marksFile(), JSON.stringify(marks, null, 2));
  console.log(`OK: log mark "${name}" set on ${serial}${opts.clear === true ? ' (log cleared)' : ''}; assert-request now counts from here`);
}

// The app's uid, so only its own log lines count.
function appUid(serial, pkg) {
  try {
    const out = String(device.adb(serial, ['shell', 'pm', 'list', 'packages', '-U', pkg], { timeout: 15000 }));
    const line = out.split('\n').find(l => l.trim().startsWith(`package:${pkg} `));
    const m = line && /uid:(\d+)/.exec(line);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function cmdAssertRequest(opts) {
  if (typeof opts.grep !== 'string' || !opts.grep) {
    console.error('Usage: assert-request --grep <regex> [--count N | --min N | --max N] [--since <mark>] [--all-processes] [--all-lines]');
    process.exit(1);
  }
  const ctx = deviceContext(opts);
  if (ctx.isIOS) {
    console.warn('WARN: assert-request is not supported on iOS (no adb logcat). This check was NOT run: mark the case blocked or verify with qc/api.js.');
    process.exit(2);
  }
  let re;
  try {
    re = new RegExp(opts.grep, opts['ignore-case'] === true ? 'i' : '');
  } catch (err) {
    console.error(`ERROR: --grep is not a valid regex: ${err.message}`);
    process.exit(1);
  }
  const verdictSpec = { count: opts.count, min: opts.min, max: opts.max };
  const probe = device.evalCount(0, verdictSpec);
  if (probe.error) {
    console.error(`ERROR: ${probe.error}`);
    process.exit(1);
  }

  const serial = serialOrExit(ctx);
  const marks = readMarks();
  let markName = typeof opts.since === 'string' ? opts.since : marks.__last;
  let since = null;
  if (markName) {
    const mark = marks[markName];
    if (!mark || markName === '__last') {
      console.error(`ERROR: no log mark "${markName}". Set one with: log-mark --name ${markName}`);
      process.exit(1);
    }
    if (mark.serial !== serial) {
      console.warn(`WARN: mark "${markName}" was set on ${mark.serial}, not ${serial}`);
    }
    since = mark.epoch;
  } else {
    console.warn('WARN: no log-mark set, so this counts the whole log buffer. Run log-mark before the action under test.');
    markName = null;
  }

  let uid = null;
  if (opts['all-processes'] !== true) {
    uid = appUid(serial, ctx.pkg);
    if (!uid) {
      console.warn(`WARN: could not find the uid of ${ctx.pkg || 'the app'}; counting every process.`);
    }
  }
  const text = String(device.adb(serial, ['logcat', '-d', '-v', 'epoch,uid'], { timeout: 60000 }));
  const result = device.countRequests(text, {
    grep: re, since, appUid: uid, allLines: opts['all-lines'] === true,
  });
  const verdict = device.evalCount(result.count, verdictSpec);
  const window = markName ? `since mark "${markName}"` : 'in the whole log buffer';
  const summary = `${result.count} call(s) matching /${opts.grep}/ ${window}`;

  result.matches.slice(0, 5).forEach(e => {
    const t = `${new Date(e.ts * 1000).toISOString().slice(11, 23)}Z`;
    console.log(`   ${t} ${e.tag}: ${device.redactLine(e.msg)}`);
  });
  if (result.matches.length > 5) {console.log(`   ... ${result.matches.length - 5} more`);}

  // Lost lines can only lower the count, so a truncated window still proves a
  // minimum but not an exact count or a maximum.
  const needsWholeWindow = opts.count !== undefined || opts.max !== undefined;
  if (result.truncated && needsWholeWindow) {
    console.error(`ASSERT FAILED - inconclusive: the log buffer rotated past mark "${markName}", so calls may be missing (${summary}).`);
    console.error('   Set log-mark right before the action, or enlarge the buffer: adb -s <serial> logcat -G 16M');
    process.exit(1);
  }
  if (!verdict.ok) {
    console.error(`ASSERT FAILED - ${summary}, expected ${verdict.expected}`);
    process.exit(1);
  }
  console.log(`OK: ${summary} (expected ${verdict.expected})`);
}

// --- wait-for: catch short-lived UI ------------------------------------------------------

function uiString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// A cheaper finder than findCandidates for polling: no XPath (it dumps the
// whole tree on every call). Partial text matches count too, since Flutter
// merges a widget's labels into one content-desc.
async function quickFind(sessionId, platform, selector, text) {
  if (platform === 'ios') {return (await findCandidates(sessionId, platform, selector, text))[0] || null;}
  const tries = [];
  if (selector) {
    const id = selector.startsWith('~') ? selector.slice(1) : selector;
    tries.push(['accessibility id', id], ['-android uiautomator', `new UiSelector().resourceId("${uiString(id)}")`]);
  }
  if (text) {
    const t = uiString(text);
    tries.push(
      ['-android uiautomator', `new UiSelector().text("${t}")`],
      ['-android uiautomator', `new UiSelector().description("${t}")`],
      ['-android uiautomator', `new UiSelector().textContains("${t}")`],
      ['-android uiautomator', `new UiSelector().descriptionContains("${t}")`],
    );
  }
  for (const [using, value] of tries) {
    const els = await tryFindAll(sessionId, using, value);
    if (els.length) {return els[0];}
  }
  return null;
}

// Fastest capture available: adb screencap streams a PNG straight off the
// device in a fraction of an Appium screenshot's time.
async function fastCapture(sessionId, platform, serial) {
  if (platform === 'android' && serial) {
    try {
      const png = device.adb(serial, ['exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 15000 });
      if (png.length > 24 && png.toString('ascii', 1, 4) === 'PNG') {return { png, via: 'adb screencap' };}
    } catch {
      // Fall through to Appium.
    }
  }
  const res = await appiumRequest('GET', `/session/${sessionId}/screenshot`);
  if (typeof res.value !== 'string') {return null;}
  return { png: Buffer.from(res.value, 'base64'), via: 'appium' };
}

async function cmdWaitFor(opts) {
  const selector = typeof opts.selector === 'string' ? opts.selector : null;
  const text = typeof opts.text === 'string' ? opts.text : null;
  if (!selector && !text) {
    console.error('Usage: wait-for --text <t> | --selector <id> [--gone] [--timeout ms] [--screenshot <name>]');
    process.exit(1);
  }
  const gone = opts.gone === true;
  const timeoutMs = opts.timeout !== undefined ? Number(opts.timeout) : 10000;
  const interval = opts.interval !== undefined ? Number(opts.interval) : 150;
  const shot = opts.screenshot === true ? 'wait-for' : (typeof opts.screenshot === 'string' ? opts.screenshot : null);

  const { sessionId, platform, serial: sessionSerial } = loadSession();
  // Resolved before polling, so the capture right after the hit costs nothing extra.
  let serial = sessionSerial || null;
  if (shot && platform === 'android' && !serial) {
    const ctx = deviceContext({});
    serial = device.resolveSerial({ avd: ctx.deviceCfg.avd || '', udid: ctx.deviceCfg.udid || '' }).serial || null;
  }

  const label = selector || text;
  const started = Date.now();
  for (;;) {
    const el = await quickFind(sessionId, platform, selector, text);
    if (gone ? !el : Boolean(el)) {break;}
    if (Date.now() - started > timeoutMs) {
      if (shot) {
        const cap = await fastCapture(sessionId, platform, serial);
        if (cap) {savePng(cap.png, `${shot}-timeout`, ` (${cap.via}, at timeout)`);}
      }
      console.error(`ASSERT FAILED - "${label}" ${gone ? 'still on screen' : 'did not appear'} after ${timeoutMs}ms`);
      process.exit(1);
    }
    await sleep(interval);
  }
  const hitMs = Date.now() - started;
  if (shot) {
    const cap = await fastCapture(sessionId, platform, serial);
    if (!cap) {
      console.error('ERROR: the element matched but the screenshot failed. The session may have ended.');
      process.exit(1);
    }
    savePng(cap.png, shot, ` (${cap.via}, ${Date.now() - started - hitMs}ms after the match)`);
  }
  console.log(`OK: "${label}" ${gone ? 'is gone' : 'appeared'} after ${hitMs}ms`);
}

// --- audit-ids: what a selector cannot reach ------------------------------------------------

async function cmdAuditIds() {
  const { sessionId, platform } = loadSession();
  const src = await appiumRequest('GET', `/session/${sessionId}/source`);
  if (typeof src.value !== 'string') {
    console.error('ERROR: could not read the screen (the session may have ended). Reconnect with connect.');
    process.exit(1);
  }
  const { interactive, missing } = platform === 'ios' ? device.auditIOS(src.value) : device.auditAndroid(src.value);
  console.log(`${missing.length} of ${interactive} interactive element(s) on this screen have no ${platform === 'ios' ? 'accessibility identifier' : 'resource-id or content-desc'}:`);
  for (const m of missing) {
    const short = m.cls.split('.').pop().replace('XCUIElementType', '');
    const bits = [
      m.text ? `text="${m.text}"` : '',
      m.hint ? `hint="${m.hint}"` : '',
      m.password ? 'password' : '',
      m.center ? `center ${m.center.x},${m.center.y}` : '',
    ].filter(Boolean).join(' ');
    console.log(`FINDING: ${short} #${m.classIndex} (${m.kind}) ${bits}`);
    console.log(`   drive it with: node qc/driver.js ${m.drive}`);
  }
  if (missing.length) {
    const names = missing.slice(0, 6).map(m => `${m.cls.split('.').pop().replace('XCUIElementType', '')} #${m.classIndex}`).join(', ');
    console.log('Suggested finding (yellow):');
    console.log(`   node qc/state.js <ticket> finding yellow '<screen>: ${missing.length} interactive element(s) without a testID (${names}). Add a testID / Semantics identifier / accessibilityIdentifier so QC can target them.'`);
  }
  console.log(`OK: audit done (${missing.length} without an id)`);
}

// --- Help --------------------------------------------------------------------

function printHelp() {
  console.log(`
QC Driver - Appium CLI for the QC skill

Usage: node driver.js <command> [options]

Commands:
  connect             --platform <profile>        Create session. Profiles come from
                                                  devices.* in qc.config.json
                                                  (android | android_tablet | ios).
                                                  Android profiles auto-boot their AVD.
                      --flavor <name>             App flavor from app.flavors.*
                                                  (default: app.defaultFlavor)
                      --skip-health               Skip the Android health pre-check
  disconnect                                      End session
  tap                 --selector <testID>         Tap by testID (accessibility id, then resource-id)
                      --text "Label"              Tap by visible text
                      --within <testID>           Scope the search to the given element's bounds
                                                  (e.g. tap --within list-item-4
                                                            --selector action-button)
                      --index <n>                 Pick the nth match (default 0)
                      --x <n> --y <n>             Tap at screen coordinates (no testID needed)
  long-press          --selector/--text <val>     Long-press an element
                      --x <n> --y <n>             Long-press at coordinates
                      --duration <ms>             Hold time (default 1000ms)
  assert-visible      --selector/--text <val>     Fail if element not on screen
  assert-not-visible  --selector/--text <val>     Fail if element IS on screen
  screenshot          --name <label>              Save PNG to the run's screenshots/ folder,
                                                  numbered in capture order (001-<label>.png)
  input               --selector <testID>         Type into a field
                      --class <className>         ... or the nth field of a class, for fields
                                                  with no testID (android.widget.EditText)
                      --x <n> --y <n>             ... or tap there to focus, then type
                      --text "value"              Type a literal value
                      --credential <field>        Type a credential of the active environment
                                                  (username | password; from QC_CRED_<ENV>_*
                                                  env vars or the credentials file). The
                                                  value never appears on a command line,
                                                  in the log or in an error message.
                                                  Mutually exclusive with --text.
                      --index <n>                 Pick the nth match (default 0)
  swipe               --direction up|down|left|right
  back                                            Android back button
  find                --text "Label"              Inspect element (debug selectors)
  wait-for            --text <t> | --selector <id>
                                                  Poll until it appears, then capture at once
                                                  (snackbars, loaders)
                      --gone                      Wait for it to disappear instead
                      --timeout <ms>              Default 10000; ASSERT FAILED on timeout
                      --screenshot <name>         Capture on the match (adb screencap on
                                                  Android), numbered like screenshot
  audit-ids                                       List interactive elements with no
                                                  resource-id / content-desc / identifier,
                                                  with the command that still reaches each
  open-url            --url <url>                 Fire a deep link / App Link at the app
                                                  (Android: am start VIEW+BROWSABLE;
                                                  iOS simulator: simctl openurl)
  log-mark            [--name <n>] [--clear]      Bookmark adb logcat (Android) so
                                                  assert-request counts from here
  assert-request      --grep <regex>              Count the app's network calls in logcat
                      --count N | --min N | --max N
                                                  (default: at least 1)
                      --since <mark>              Window start (default: the latest mark)
                      --all-processes             Count lines from every process
                      --all-lines                 Also count response echoes of a URL
  health              [--fix] [--timeout <ms>]    Android: boot flag, package/activity
                                                  services, load average. --fix cold boots
                                                  the profile's AVD when unhealthy

Selector tips:
  --selector <testID>  Matches the testID prop (preferred). iOS: accessibility id;
                       Android: falls back to resource-id.
  --within <testID>    Works on tap / long-press / assert-* / find / input. Use when a
                       testID repeats per list item - scope with the list item's
                       unique container testID (bounds-based, survives view flattening).
  --index <n>          Works on tap / input when several elements share a testID.
  --platform <profile> On open-url / log-mark / assert-request / health: the device
                       profile (default: the session's, else android).
  Text fallback        Matches label/value/name attributes or text content.

Devices:
  Every adb call names the profile's own device: devices.<profile>.udid, else
  the emulator whose ro.boot.qemu.avd_name is devices.<profile>.avd. Other
  attached devices are never touched.

Configuration:
  qc.config.json in the host repo supplies the device profiles, app packages,
  Appium host/port and the reports directory. Run this script from anywhere
  inside that repo. Credentials come from QC_CRED_<ENV>_USERNAME/_PASSWORD or
  the gitignored file named by "credentialsFile" (set them with
  qc-check env credentials <env>) and are read only by --credential, never by
  the agent.

Environment:
  QC_ENV            environment under test: selects the credentials used by
                    --credential and the run folder evidence is saved to
  QC_RUN_DIR        run folder to save evidence into (set by qc-check run)
  QC_FLAVOR         default app flavor
  QC_SESSION_FILE   session state path (default: one per repo, see config.js --session-file)
  QC_EVAL           marks a headless eval run
`);
}

// --- Main --------------------------------------------------------------------

(async () => {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  const commands = {
    connect: cmdConnect,
    disconnect: cmdDisconnect,
    tap: cmdTap,
    'tap-text': cmdTap,
    'long-press': cmdLongPress,
    longpress: cmdLongPress,
    'assert-visible': cmdAssertVisible,
    'assert-not-visible': cmdAssertNotVisible,
    screenshot: cmdScreenshot,
    input: cmdInput,
    swipe: cmdSwipe,
    back: cmdBack,
    find: cmdFind,
    'open-url': cmdOpenUrl,
    'log-mark': cmdLogMark,
    'assert-request': cmdAssertRequest,
    'wait-for': cmdWaitFor,
    'audit-ids': cmdAuditIds,
    health: cmdHealth,
  };

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    process.exit(0);
  }

  if (!commands[command]) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  try {
    await commands[command](opts);
  } catch (err) {
    console.error('ERROR:', err.message || err);
    process.exit(1);
  }
})();
