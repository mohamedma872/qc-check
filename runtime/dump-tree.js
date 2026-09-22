#!/usr/bin/env node
// QC - dump the live accessibility tree of the current Appium session.
// Cross-platform: parses iOS XCUITest XML and Android UiAutomator2 XML.
// Prints one line per named/tappable element with its enabled state and
// center coordinates (feed straight into `driver.js tap --x <n> --y <n>`).
'use strict';

const fs = require('fs');
const http = require('http');

const SESSION_FILE = process.env.QC_SESSION_FILE || '/tmp/qc-session.json';

// Required lazily so `--help` works in a repo with no qc.config.json yet.
function config() {
  // eslint-disable-next-line global-require
  return require('./config.js');
}

function printHelp() {
  console.log(`
QC tree dump - list the elements of the current screen

Usage: node dump-tree.js [--all] [--grep <substring>] [--save [name]]

Options:
  --all            include elements without a name/text (normally filtered out)
  --grep <text>    only print lines containing the substring (case-insensitive)
  --save [name]    also write the dump to the run's trees/ folder, numbered
                   in capture order (001-<name>.txt); _unsorted/ when no run
                   is in progress
  --help           show this help

Requires an active session created by driver.js connect. The Appium host and
port come from the session record, or from devices.appium in qc.config.json.

Environment:
  QC_SESSION_FILE   session state path (default /tmp/qc-session.json)
  QC_RUN_DIR        run folder to save into (set by qc-check run)
`);
}

function attr(s, name) {
  const m = s.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
}

function parseIOS(xml, showAll) {
  const lines = [];
  const re = /<(XCUIElementType\w+)([^>]*?)(\/>|>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[1].replace('XCUIElementType', '');
    const s = m[0];
    const name = attr(s, 'name');
    if ((!name || /scroll bar/.test(name)) && !showAll) {continue;}
    const x = +attr(s, 'x'), y = +attr(s, 'y');
    const w = +attr(s, 'width'), h = +attr(s, 'height');
    lines.push(
      `${tag} ~${name} enabled=${attr(s, 'enabled')} @${x},${y} center ${x + w / 2},${y + h / 2}`
    );
  }
  return lines;
}

function parseAndroid(xml, showAll) {
  const lines = [];
  // UiAutomator2 emits either <node .../> or class-named tags like
  // <android.widget.FrameLayout .../> depending on driver version - accept both.
  const re = /<(?:node|[\w$]+(?:\.[\w$]+)+)((?:[^>"]|"[^"]*")*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const s = m[0];
    if (s.startsWith('<hierarchy')) {continue;}
    const desc = attr(s, 'content-desc');
    const text = attr(s, 'text');
    const resId = attr(s, 'resource-id');
    const label = desc || text;
    const clickable = attr(s, 'clickable') === 'true';
    if (!label && !resId && !showAll) {continue;}
    if (!label && !clickable && !showAll) {continue;}
    const b = attr(s, 'bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const center = b
      ? `${(+b[1] + +b[3]) / 2},${(+b[2] + +b[4]) / 2}`
      : '?';
    const cls = (attr(s, 'class') || 'node').split('.').pop();
    lines.push(
      `${cls} ~${desc || ''}${text ? ` text="${text}"` : ''}${resId ? ` id=${resId}` : ''}` +
        ` enabled=${attr(s, 'enabled')} clickable=${clickable} center ${center}`
    );
  }
  return lines;
}

// Session record first (it knows which server the session lives on), then the
// configured default.
function appiumTarget(session) {
  if (session.host && session.port) {
    return { host: session.host, port: session.port };
  }
  const { devices } = config().loadConfig();
  const appium = (devices && devices.appium) || {};
  return { host: appium.host || '127.0.0.1', port: appium.port || 4723 };
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printHelp();
    process.exit(0);
  }

  if (!fs.existsSync(SESSION_FILE)) {
    console.error(`ERROR: no active QC session (${SESSION_FILE} missing). Run driver.js connect first.`);
    process.exit(1);
  }
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const { sessionId, platform } = session;
  const showAll = args.includes('--all');
  const grepIdx = args.indexOf('--grep');
  const grep = grepIdx >= 0 ? (args[grepIdx + 1] || '').toLowerCase() : null;
  const saveIdx = args.indexOf('--save');
  const save = saveIdx >= 0;
  const saveName = save && args[saveIdx + 1] && !args[saveIdx + 1].startsWith('--')
    ? args[saveIdx + 1]
    : 'screen';

  const { host, port } = appiumTarget(session);

  const xml = await new Promise((resolve, reject) => {
    http
      .get({ hostname: host, port, path: `/session/${sessionId}/source` }, res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try {
            const value = JSON.parse(raw).value;
            if (typeof value !== 'string') {
              // Appium returns an error object (e.g. "invalid session id") here
              reject(new Error(`Appium error: ${(value && value.error) || 'unknown'} - ${(value && value.message) || ''}. Reconnect with driver.js connect.`));
              return;
            }
            resolve(value);
          } catch (e) {
            reject(new Error(`Bad response from Appium: ${raw.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });

  const isIOS = platform === 'ios' || /XCUIElementType/.test(xml);
  let lines = isIOS ? parseIOS(xml, showAll) : parseAndroid(xml, showAll);
  if (grep) {lines = lines.filter(l => l.toLowerCase().includes(grep));}
  if (!lines.length) {
    console.log('(no matching elements - try --all, or the screen may be a system dialog)');
  } else {
    lines.forEach(l => console.log(l));
  }

  if (save) {
    // eslint-disable-next-line global-require
    const file = require('./runs.js').artifactPath('trees', saveName, 'txt');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    console.log(`OK: tree saved: ${file}`);
  }
})().catch(err => {
  console.error('ERROR:', err.message || err);
  process.exit(1);
});
