#!/usr/bin/env node
// QC Driver - Appium CLI helper for the QC skill.
// No external dependencies: it speaks the Appium REST API over Node's http.
// Session state is persisted between commands (default /tmp/qc-session.json,
// override with QC_SESSION_FILE when several repos are QC'd side by side).
// Every device, app and server value comes from qc.config.json via config.js.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const SESSION_FILE = process.env.QC_SESSION_FILE || '/tmp/qc-session.json';

// config.js is required lazily so `--help` works in a repo with no config yet.
function config() {
  // eslint-disable-next-line global-require
  return require('./config.js');
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
  if (!fs.existsSync(SESSION_FILE)) {
    const self = process.argv[1] || 'driver.js';
    console.error(`ERROR: no active QC session (${SESSION_FILE} missing). Run:`);
    console.error(`   node ${self} connect --platform <profile>`);
    process.exit(1);
  }
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
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

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      result[key] = next && !next.startsWith('--') ? (i++, next) : true;
    }
  }
  return result;
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
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  console.log(`OK: session created: ${session.sessionId}`);
  console.log(
    `   profile: ${platform} (${basePlatform}) | flavor: ${session.flavor} | app: ` +
      `${capabilities['appium:bundleId'] || capabilities['appium:appPackage']}`,
  );
}

async function cmdDisconnect() {
  const { sessionId } = loadSession();
  await appiumRequest('DELETE', `/session/${sessionId}`);
  if (fs.existsSync(SESSION_FILE)) {fs.unlinkSync(SESSION_FILE);}
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
  const dir = config().reportsDir();

  const res = await appiumRequest('GET', `/session/${sessionId}/screenshot`);
  // A dead/invalid session returns an error object in `value`, not a base64 string.
  if (typeof res.value !== 'string') {
    const msg = res.value && res.value.message ? res.value.message : JSON.stringify(res);
    console.error(`ERROR: screenshot failed: ${msg}`);
    console.error('   The session may have ended - reconnect with: connect --platform <profile>');
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = (typeof name === 'string' ? name : 'screenshot')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '');
  const filepath = path.join(dir, `${slug || 'screenshot'}-${ts}.png`);
  const png = Buffer.from(res.value, 'base64');
  fs.writeFileSync(filepath, png);
  console.log(`OK: screenshot saved: ${filepath}`);

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
}

// Read one credential field for the active environment. The value is returned
// to the caller and never logged, never placed in an error message and never
// passed on a command line: this is what keeps the agent out of the loop.
function credentialValue(field) {
  const { loadConfig, loadCredentials } = config();
  const cfg = loadConfig();
  const file = cfg.credentialsFile || 'qc.credentials.js';

  let creds;
  try {
    creds = loadCredentials();
  } catch (err) {
    // The loader's message names the file and the config key, never a value.
    console.error(`ERROR: ${err.message || err}`);
    process.exit(1);
  }

  // QC_ENV wins over the file's own `env`; a flat file with no env blocks is
  // accepted as its own block, matching how api.js resolves credentials.
  const envName = process.env.QC_ENV || creds.env || cfg.backend.defaultEnv || '';
  const block = creds[envName] || (creds.username ? creds : null);
  if (!block) {
    const blocks = Object.keys(creds).filter(k => k !== 'env').join(', ') || '(none)';
    console.error(
      `ERROR: no credentials for env "${envName}" in ${file} - blocks present: ${blocks}`,
    );
    console.error('   Set the env with QC_ENV, or with "env" in the credentials file.');
    process.exit(1);
  }

  const value = block[field];
  if (typeof value !== 'string' || !value) {
    const fields = Object.keys(block).join(', ') || '(none)';
    console.error(
      `ERROR: credential field "${field}" is missing for env "${envName}" in ${file} ` +
        `(the path comes from "credentialsFile" in qc.config.json) - fields present: ${fields}`,
    );
    process.exit(1);
  }
  if (value === 'CHANGE_ME') {
    console.error(
      `ERROR: ${file} still has the placeholder for "${field}" in env "${envName}" - ` +
        'fill in the QC test account.',
    );
    process.exit(1);
  }
  return value;
}

async function cmdInput({ selector, text, credential, within, index }) {
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

  // Resolved before the session work so a config problem fails fast.
  const value = hasCredential ? credentialValue(credential) : (hasText ? text : '');

  const { sessionId, platform } = loadSession();
  const el = await findElement(sessionId, platform, selector, null, within, index);
  if (!el) {
    console.error(`ERROR: input field not found: "${selector}"`);
    process.exit(1);
  }
  const elId = getElementId(el);
  await appiumRequest('POST', `/session/${sessionId}/element/${elId}/clear`, {});
  await appiumRequest('POST', `/session/${sessionId}/element/${elId}/value`, {
    text: value,
    value: value.split(''),
  });
  // Typed values can be credentials, so only the length is ever reported.
  const what = hasCredential ? `credential "${credential}"` : 'text';
  console.log(`OK: typed ${what} (${value.length} characters) into "${selector}"`);
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
  screenshot          --name <label>              Save PNG to the reports dir (project.reportsDir)
  input               --selector <testID>         Type into a field
                      --text "value"              Type a literal value
                      --credential <field>        Type a field from the credentials file
                                                  (username | password | any field in the
                                                  block for the active environment). The
                                                  value never appears on a command line,
                                                  in the log or in an error message.
                                                  Mutually exclusive with --text.
                      --index <n>                 Pick the nth match (default 0)
  swipe               --direction up|down|left|right
  back                                            Android back button
  find                --text "Label"              Inspect element (debug selectors)

Selector tips:
  --selector <testID>  Matches the testID prop (preferred). iOS: accessibility id;
                       Android: falls back to resource-id.
  --within <testID>    Works on tap / long-press / assert-* / find / input. Use when a
                       testID repeats per list item - scope with the list item's
                       unique container testID (bounds-based, survives view flattening).
  --index <n>          Works on tap / input when several elements share a testID.
  Text fallback        Matches label/value/name attributes or text content.

Configuration:
  qc.config.json in the host repo supplies the device profiles, app packages,
  Appium host/port and the reports directory. Run this script from anywhere
  inside that repo. Credentials live in the gitignored file named by
  "credentialsFile" and are read only by --credential, never by the agent.

Environment:
  QC_ENV            credentials environment for --credential (overrides the
                    credentials file's own "env")
  QC_FLAVOR         default app flavor
  QC_SESSION_FILE   session state path (default /tmp/qc-session.json)
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
