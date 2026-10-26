// QC - device helpers for driver.js: pure logic (argument parsing, adb shell
// quoting, serial selection, logcat counting, health parsing, the testID audit,
// frame / memory / startup parsing for the perf probes) plus thin adb wrappers.
// The pure parts take plain strings and return plain values so test/driver.js
// and test/perf.js can check them with no device attached.
'use strict';

const { execFileSync } = require('child_process');

// --- Arguments -----------------------------------------------------------------

// `--key value` pairs; a flag with no value (or followed by another flag) is true.
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      result[key] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    }
  }
  return result;
}

// --- adb shell quoting ---------------------------------------------------------

// `adb shell` joins its arguments with spaces and hands the result to the
// device's /system/bin/sh, so a URL with `&` or `?` would be split into
// background jobs and globs. Single quotes stop every expansion; a single quote
// inside the value is closed, escaped and reopened.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The device-side command that fires a deep link / App Link at one app.
// BROWSABLE makes it resolve like a tap on a link in a browser, which is what
// App Link verification and most deep-link routers expect. With no activity
// configured, `-p` still restricts resolution to the app under test.
function amStartViewCommand(url, pkg, activity) {
  if (!url) {throw new Error('a URL is required');}
  if (!pkg) {throw new Error('the app package is required');}
  const parts = [
    'am start -W',
    '-a android.intent.action.VIEW',
    '-c android.intent.category.BROWSABLE',
    `-d ${shellQuote(url)}`,
  ];
  if (activity) {
    const component = activity.includes('/') ? activity : `${pkg}/${activity}`;
    parts.push(`-n ${shellQuote(component)}`);
  } else {
    parts.push(`-p ${shellQuote(pkg)}`);
  }
  return parts.join(' ');
}

// `am start` exits 0 even when nothing started; the verdict is in its output.
// "Activity not started, intent has been delivered to currently running
// top-most instance" is a success: a singleTop app (Flutter's default) gets
// the link through onNewIntent instead of a fresh activity. "Its current task
// has been brought to the front" is not a failure either: the app's task came
// forward (another app, such as a browser, was on top) and a singleTop or
// singleTask app still receives the intent, but Android does not confirm it,
// so the caller warns and the test must check the screen.
function amStartFailed(output) {
  const text = String(output);
  const m = text.match(/^(Error[^\n]*|.*Activity not started[^\n]*|.*unable to resolve Intent[^\n]*)/im);
  if (!m) {return null;}
  if (/^Error/im.test(text)) {return m[1].trim();}
  if (/delivered to currently running top-most instance|current task has been brought to the front/i.test(m[1])) {return null;}
  return m[1].trim();
}

// How the link reached the app, for the OK line.
function amStartOutcome(output) {
  const text = String(output);
  if (/delivered to currently running top-most instance/i.test(text)) {return 'delivered to the running activity';}
  if (/current task has been brought to the front/i.test(text)) {return 'task brought to the front';}
  const m = /LaunchState: (\w+)/.exec(text);
  return m ? `launch: ${m[1].toLowerCase()}` : '';
}

// --- Serial selection ------------------------------------------------------------

// `adb devices` output -> [{ serial, state }].
function parseAdbDevices(text) {
  return String(text)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^List of devices/.test(l) && !l.startsWith('*'))
    .map(l => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state: state || 'unknown' };
    })
    .filter(d => d.serial);
}

// AVD names are shown with spaces in some tools and underscores in others.
function normalizeAvd(name) {
  return String(name || '').trim().replace(/\s+/g, '_').toLowerCase();
}

// Pick the one device this profile owns. Never falls back to "the first
// device" when several are attached: the other one belongs to someone else.
//   devices: parseAdbDevices() output
//   avdOf:   { serial: avdName } for the emulators among them
//   want:    { udid, avd } from the device profile
function selectSerial(devices, avdOf, want) {
  const online = devices.filter(d => d.state === 'device');
  const list = devices.map(d => `${d.serial} (${d.state})`).join(', ') || 'none';
  if (want.udid) {
    const hit = devices.find(d => d.serial === want.udid);
    if (!hit) {return { error: `configured udid ${want.udid} is not attached (adb devices: ${list})` };}
    if (hit.state !== 'device') {return { error: `${want.udid} is ${hit.state}, not ready` };}
    return { serial: hit.serial };
  }
  if (want.avd) {
    const target = normalizeAvd(want.avd);
    const hits = online.filter(d => normalizeAvd(avdOf[d.serial]) === target);
    if (hits.length === 1) {return { serial: hits[0].serial };}
    if (hits.length > 1) {
      return { error: `AVD ${want.avd} is running more than once (${hits.map(d => d.serial).join(', ')}); set the profile's udid to pick one` };
    }
    return { error: `AVD ${want.avd} is not running (adb devices: ${list})`, notRunning: true };
  }
  if (online.length === 1) {return { serial: online[0].serial };}
  if (!online.length) {return { error: `no device attached (adb devices: ${list})`, notRunning: true };}
  return {
    error: `${online.length} devices are attached (${online.map(d => d.serial).join(', ')}) and the profile names none; set its avd or udid in qc.config.json`,
  };
}

// emulator-5554 -> 5554 (the console port), anything else -> null.
function emulatorPort(serial) {
  const m = /^emulator-(\d+)$/.exec(String(serial || ''));
  return m ? Number(m[1]) : null;
}

// First even console port from 5554 that no attached emulator uses.
function freeEmulatorPort(devices) {
  const used = new Set(devices.map(d => emulatorPort(d.serial)).filter(Boolean));
  for (let p = 5554; p <= 5682; p += 2) {
    if (!used.has(p)) {return p;}
  }
  return null;
}

// --- adb wrappers ------------------------------------------------------------------

// Every call names its device. `exec` is injectable for tests.
function adb(serial, args, { exec = execFileSync, timeout = 30000, encoding = 'utf8' } = {}) {
  const argv = serial ? ['-s', serial, ...args] : args;
  return exec('adb', argv, { encoding, timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function avdNameOf(serial, opts) {
  if (emulatorPort(serial) === null) {return '';}
  for (const prop of ['ro.boot.qemu.avd_name', 'ro.kernel.qemu.avd_name']) {
    try {
      const v = String(adb(serial, ['shell', 'getprop', prop], { ...opts, timeout: 8000 })).trim();
      if (v) {return v;}
    } catch {
      // An emulator still booting may refuse the shell; try the next prop.
    }
  }
  return '';
}

// Resolve the serial for a profile against the live `adb devices` list.
// `preferred` (the serial a session recorded) is re-checked rather than trusted,
// so a restarted emulator that changed port is found again.
function resolveSerial(want, { preferred, exec } = {}) {
  let devices;
  try {
    devices = parseAdbDevices(adb(null, ['devices'], { exec, timeout: 10000 }));
  } catch (err) {
    return { error: `adb is not available (${err.code || err.message})` };
  }
  const avdOf = {};
  const check = d => {
    if (d.state === 'device' && want.avd && !want.udid) {avdOf[d.serial] = avdNameOf(d.serial, { exec });}
  };
  const pre = preferred && devices.find(d => d.serial === preferred);
  if (pre) {
    check(pre);
    const only = selectSerial([pre], avdOf, want);
    if (only.serial) {return { ...only, devices, avd: avdOf[only.serial] || '' };}
  }
  devices.forEach(check);
  const res = selectSerial(devices, avdOf, want);
  return { ...res, devices, avd: res.serial ? avdOf[res.serial] || '' : '' };
}

// --- Health ------------------------------------------------------------------------

// One round trip: boot flag, the two system services every install and launch
// needs, the load average and the CPU count.
const HEALTH_SHELL =
  'echo "boot=$(getprop sys.boot_completed)"; service check package; service check activity; ' +
  'echo "load=$(cat /proc/loadavg)"; echo "cpus=$(nproc 2>/dev/null)"';

function parseHealth(output) {
  const text = String(output);
  const boot = (text.match(/^boot=(.*)$/m) || [])[1];
  const svc = name => {
    const m = text.match(new RegExp(`^Service ${name}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim() : 'no answer';
  };
  const load = ((text.match(/^load=(.*)$/m) || [])[1] || '').trim().split(/\s+/);
  const cpus = Number((text.match(/^cpus=(\d+)/m) || [])[1]) || null;
  const h = {
    bootCompleted: String(boot || '').trim() === '1',
    packageService: svc('package'),
    activityService: svc('activity'),
    load: load.slice(0, 3).map(Number).filter(n => !Number.isNaN(n)),
    cpus,
  };
  h.problems = [];
  if (!h.bootCompleted) {h.problems.push(`sys.boot_completed is "${String(boot || '').trim()}", not 1`);}
  if (h.packageService !== 'found') {h.problems.push(`service package: ${h.packageService}`);}
  if (h.activityService !== 'found') {h.problems.push(`service activity: ${h.activityService}`);}
  h.healthy = h.problems.length === 0;
  // A saturated emulator is not broken, but every step gets slow and flaky.
  h.overloaded = Boolean(h.load.length && h.cpus && h.load[0] > h.cpus * 2);
  return h;
}

// --- Logcat request assertions ------------------------------------------------------

// `logcat -v epoch,uid`: "  1793041435.587 shell   451   451 I adbd    : msg".
const LOGCAT_RE = /^\s*(\d+\.\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s?(.*)$/;

function parseLogcatLine(line) {
  const m = LOGCAT_RE.exec(line);
  if (!m) {return null;}
  return { ts: Number(m[1]), uid: m[2], pid: m[3], tid: m[4], level: m[5], tag: m[6], msg: m[7] };
}

// logcat prints app uids as numbers (10242) or as user names (u0_a242).
function uidMatches(lineUid, appUid) {
  if (!appUid) {return true;}
  const n = Number(appUid);
  if (String(lineUid) === String(appUid)) {return true;}
  const m = /^u(\d+)_a(\d+)$/.exec(lineUid);
  return Boolean(m) && Number(m[1]) * 100000 + 10000 + Number(m[2]) === n;
}

// HTTP loggers such as Dio's LogInterceptor print the URI under a request
// header and again under the response (or error) header. Only the request copy
// is a call, so a match is skipped when the latest header from the same process
// is a response or error one.
const DEFAULT_REQUEST_MARKER = /\*{3}\s*Request\s*\*{3}|-->\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i;
const DEFAULT_RESPONSE_MARKER = /\*{3}\s*(Response|DioException|DioError|Error)\s*\*{3}|<--\s*\d{3}\b|<--\s*HTTP FAILED/i;

// Count the app's calls matching `grep` in logcat text.
//   since:     epoch seconds (device clock); older lines are ignored
//   appUid:    only lines from this uid (null = every process)
//   allLines:  count every matching line, response echoes included
// Lines from adbd are always dropped: adbd logs each shell command it runs, so
// the URL passed to open-url would otherwise count as a call.
function countRequests(text, { grep, since = null, appUid = null, allLines = false,
  requestMarker = DEFAULT_REQUEST_MARKER, responseMarker = DEFAULT_RESPONSE_MARKER } = {}) {
  const re = grep instanceof RegExp ? grep : new RegExp(grep);
  const lastHeader = {};
  const matches = [];
  let oldest = null;
  let parsed = 0;
  for (const raw of String(text).split('\n')) {
    const e = parseLogcatLine(raw);
    if (!e) {continue;}
    parsed += 1;
    if (oldest === null || e.ts < oldest) {oldest = e.ts;}
    if (e.tag === 'adbd') {continue;}
    if (!uidMatches(e.uid, appUid)) {continue;}
    // Headers before the mark still decide what the first lines after it are.
    if (responseMarker.test(e.msg)) {lastHeader[e.pid] = 'response';}
    else if (requestMarker.test(e.msg)) {lastHeader[e.pid] = 'request';}
    if (since !== null && e.ts < since) {continue;}
    if (!re.test(e.msg)) {continue;}
    if (!allLines && lastHeader[e.pid] === 'response' && !requestMarker.test(e.msg)) {continue;}
    matches.push(e);
  }
  // The ring buffer drops old lines when full. If the oldest line still in it
  // is newer than the mark, part of the window is gone: say so, because a
  // "0 calls" result over a truncated window proves nothing.
  const truncated = since !== null && oldest !== null && oldest > since;
  return { count: matches.length, matches, parsed, oldest, truncated };
}

// --count N | --min N | --max N against an observed count.
function evalCount(n, { count, min, max }) {
  const num = v => (v === undefined || v === true ? undefined : Number(v));
  const c = num(count);
  const lo = num(min);
  const hi = num(max);
  for (const [k, v] of [['count', c], ['min', lo], ['max', hi]]) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
      return { ok: false, error: `--${k} needs a whole number, got "${v}"` };
    }
  }
  if (c === undefined && lo === undefined && hi === undefined) {
    return { ok: n >= 1, expected: 'at least 1' };
  }
  if (c !== undefined) {return { ok: n === c, expected: `exactly ${c}` };}
  const parts = [];
  if (lo !== undefined) {parts.push(`at least ${lo}`);}
  if (hi !== undefined) {parts.push(`at most ${hi}`);}
  return { ok: (lo === undefined || n >= lo) && (hi === undefined || n <= hi), expected: parts.join(' and ') };
}

// Matched lines are printed as evidence; app debug logs often carry tokens.
function redactLine(s) {
  return String(s)
    .replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/((?:access_?|refresh_?|id_?|session_?)?token|password|passwd|secret|api_?key|authorization)(["']?\s*[:=]\s*["']?)[^\s&"',;]+/gi, '$1$2[redacted]')
    .slice(0, 240);
}

// --- Accessibility-tree audit ---------------------------------------------------------

function attr(s, name) {
  const m = s.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : '';
}

const ANDROID_INTERACTIVE = /(EditText|Button|CheckBox|Switch|RadioButton|Spinner|SeekBar|ToggleButton|CompoundButton)$/;

// Every Android node in document order with the attributes the audit needs.
function androidNodes(xml) {
  const re = /<(?:node|[\w$]+(?:\.[\w$]+)+)((?:[^>"]|"[^"]*")*?)\/?>/g;
  const nodes = [];
  const perClass = {};
  let m;
  while ((m = re.exec(xml))) {
    const s = m[0];
    if (s.startsWith('<hierarchy')) {continue;}
    const cls = attr(s, 'class') || (s.match(/^<([\w$.]+)/) || [])[1] || 'node';
    const b = attr(s, 'bounds').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    perClass[cls] = (perClass[cls] || 0);
    nodes.push({
      cls,
      classIndex: perClass[cls]++,
      text: attr(s, 'text'),
      desc: attr(s, 'content-desc'),
      resId: attr(s, 'resource-id'),
      hint: attr(s, 'hint'),
      clickable: attr(s, 'clickable') === 'true',
      password: attr(s, 'password') === 'true',
      displayed: attr(s, 'displayed') !== 'false',
      bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
    });
  }
  return nodes;
}

// Interactive Android elements a `--selector` cannot reach: no resource-id and
// no content-desc. Each comes with the command that can still drive it.
function auditAndroid(xml) {
  const out = [];
  let interactive = 0;
  for (const n of androidNodes(xml)) {
    const isInteractive = ANDROID_INTERACTIVE.test(n.cls) || n.clickable;
    if (!isInteractive || !n.displayed) {continue;}
    if (n.bounds && (n.bounds.x2 <= n.bounds.x1 || n.bounds.y2 <= n.bounds.y1)) {continue;}
    interactive += 1;
    if (n.resId || n.desc) {continue;}
    const center = n.bounds
      ? { x: Math.round((n.bounds.x1 + n.bounds.x2) / 2), y: Math.round((n.bounds.y1 + n.bounds.y2) / 2) }
      : null;
    const isField = /EditText$/.test(n.cls);
    const drive = isField
      ? `input --class ${n.cls} --index ${n.classIndex}`
      : (n.text ? `tap --text "${n.text}"` : (center ? `tap --x ${center.x} --y ${center.y}` : `tap --class ${n.cls}`));
    out.push({ ...n, center, kind: isField ? 'field' : 'control', drive });
  }
  return { interactive, missing: out };
}

function auditIOS(xml) {
  const re = /<XCUIElementType(\w+)([^>]*?)(\/>|>)/g;
  const types = /^(TextField|SecureTextField|SearchField|TextView|Button|Switch|Slider|Cell|Link|SegmentedControl|Stepper|Picker)$/;
  const perType = {};
  const out = [];
  let interactive = 0;
  let m;
  while ((m = re.exec(xml))) {
    const type = m[1];
    perType[type] = perType[type] || 0;
    const classIndex = perType[type]++;
    if (!types.test(type)) {continue;}
    const s = m[0];
    if (attr(s, 'visible') === 'false') {continue;}
    interactive += 1;
    const name = attr(s, 'name');
    if (name) {continue;}
    const x = +attr(s, 'x'), y = +attr(s, 'y'), w = +attr(s, 'width'), h = +attr(s, 'height');
    const center = { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
    const cls = `XCUIElementType${type}`;
    const isField = /Field|TextView/.test(type);
    out.push({
      cls,
      classIndex,
      text: attr(s, 'label') || attr(s, 'value'),
      center,
      kind: isField ? 'field' : 'control',
      drive: isField ? `input --class ${cls} --index ${classIndex}` : `tap --x ${center.x} --y ${center.y}`,
    });
  }
  return { interactive, missing: out };
}

// --- input targeting --------------------------------------------------------------------

// Which element `input` types into. The typed value is deliberately not part
// of the plan: it is resolved in-process and only ever sent in the Appium
// request body, never on a command line, in a log line or in an error.
function inputTarget({ selector, class: cls, x, y, index, within }) {
  const hasPoint = x !== undefined || y !== undefined;
  const given = [selector !== undefined, cls !== undefined, hasPoint].filter(Boolean).length;
  if (given === 0) {return { error: 'input needs --selector <testID>, --class <className> or --x <n> --y <n>' };}
  if (given > 1) {return { error: '--selector, --class and --x/--y are mutually exclusive' };}
  if (selector !== undefined && typeof selector !== 'string') {return { error: '--selector needs a value' };}
  if (cls !== undefined && typeof cls !== 'string') {return { error: '--class needs a class name, e.g. android.widget.EditText' };}
  const idx = index === undefined ? 0 : Number(index);
  if (!Number.isInteger(idx) || idx < 0) {return { error: `--index needs a whole number, got "${index}"` };}
  if (hasPoint) {
    const nx = Number(x), ny = Number(y);
    if (x === undefined || y === undefined || Number.isNaN(nx) || Number.isNaN(ny)) {
      return { error: '--x and --y go together and must be numbers' };
    }
    return { kind: 'point', x: nx, y: ny, label: `(${nx}, ${ny})` };
  }
  if (cls !== undefined) {return { kind: 'class', cls, index: idx, label: `${cls}[${idx}]` };}
  return { kind: 'selector', selector, index: idx, within, label: selector };
}

// --- performance and memory probes ------------------------------------------------------

function median(values) {
  const xs = (values || []).filter(v => v !== null && v !== '').map(Number).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) {return null;}
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Nearest-rank percentile of a list of numbers.
function percentile(values, p) {
  const xs = values.slice().sort((a, b) => a - b);
  if (!xs.length) {return null;}
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length, Math.max(1, rank)) - 1];
}

// `dumpsys gfxinfo <pkg>`: the frame stats HWUI keeps for the app's views.
// Lines like "Janky frames (legacy):" and "Number Frame deadline missed
// (legacy):" (API 31+) are kept apart from the current ones; anything the
// platform does not print is null.
function parseGfxinfo(text) {
  const s = String(text || '');
  if (/No process found for/i.test(s)) {return { noProcess: true };}
  const num = re => {
    const m = re.exec(s);
    return m ? Number(m[1]) : null;
  };
  const head = /\*\* Graphics info for pid (\d+) \[([^\]]+)\]/.exec(s);
  const janky = /^Janky frames: (\d+) \(([\d.]+)%\)/m.exec(s);
  const out = {
    noProcess: false,
    pid: head ? Number(head[1]) : null,
    pkg: head ? head[2] : null,
    totalFrames: num(/^Total frames rendered: (\d+)/m),
    jankyFrames: janky ? Number(janky[1]) : null,
    jankyPct: janky ? Number(janky[2]) : null,
    p50Ms: num(/^50th percentile: (\d+)ms/m),
    p90Ms: num(/^90th percentile: (\d+)ms/m),
    p95Ms: num(/^95th percentile: (\d+)ms/m),
    p99Ms: num(/^99th percentile: (\d+)ms/m),
    missedVsync: num(/^Number Missed Vsync: (\d+)/m),
    highInputLatency: num(/^Number High input latency: (\d+)/m),
    slowUiThread: num(/^Number Slow UI thread: (\d+)/m),
    slowBitmapUploads: num(/^Number Slow bitmap uploads: (\d+)/m),
    slowIssueDrawCommands: num(/^Number Slow issue draw commands: (\d+)/m),
    frameDeadlineMissed: num(/^Number Frame deadline missed: (\d+)/m),
    gpuP90Ms: num(/^90th gpu percentile: (\d+)ms/m),
    pipeline: (/^Pipeline=(.+)$/m.exec(s) || [])[1] || null,
  };
  // A SurfaceView in the app's buffers means the content is drawn outside
  // HWUI (Flutter, games, video), so gfxinfo undercounts it.
  out.surfaceView = /SurfaceView\[/.test(s);
  // An empty histogram reports its top bucket (4950ms) for every percentile.
  if (out.totalFrames === 0) {
    for (const k of ['p50Ms', 'p90Ms', 'p95Ms', 'p99Ms', 'gpuP90Ms']) {out[k] = null;}
  }
  if (out.totalFrames === null) {out.unparsed = true;}
  return out;
}

// Layer names from `dumpsys SurfaceFlinger --list`. API 34+ prints
// "RequestedLayerState{<name> parentId=..}"; older releases print bare names.
function parseSfLayers(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = /^RequestedLayerState\{(.*?)(?: parentId=| z=|\}$)/.exec(l);
    return m ? m[1] : l;
  }).filter(n => !/^(Display |Output Layer|\d+ Layers?)/.test(n));
}

// The layer that carries the app's frames: a SurfaceView buffer layer
// (Flutter renders there), else the app window's buffer layer.
function pickSfLayer(names, pkg) {
  const mine = names.filter(n => n.includes(pkg) && !/^Background for|ActivityRecord|InputSink|^Bounds for/.test(n));
  return mine.find(n => n.includes('SurfaceView[') && n.includes('(BLAST)'))
    || mine.find(n => n.includes('SurfaceView[') && !n.includes('Background'))
    || mine.find(n => n.includes('(BLAST)'))
    || mine.find(n => /^VRI-|^[0-9a-f]+ .*\/.*#\d+$/.test(n))
    || mine[0] || null;
}

// `dumpsys SurfaceFlinger --latency <layer>`: the refresh period, then up to
// 128 rows of desired-present / actual-present / frame-ready times (ns).
// Frame time is the gap between consecutive presents; gaps over idleMs are
// the screen sitting still, not frames, and are left out. A frame is janky
// when it took longer than 1.5 refresh periods (at least one missed vsync).
function parseSfLatency(text, { idleMs = 500 } = {}) {
  const lines = String(text || '').trim().split('\n').map(l => l.trim()).filter(Boolean);
  const refreshNs = Number(lines.shift());
  const presents = [];
  for (const l of lines) {
    const cols = l.split(/\s+/).map(Number);
    if (cols.length < 3 || cols.some(n => !Number.isFinite(n) || n <= 0 || n > 1e18)) {continue;}
    presents.push(cols[1]);
  }
  presents.sort((a, b) => a - b);
  const frameMs = [];
  for (let i = 1; i < presents.length; i++) {
    const ms = (presents[i] - presents[i - 1]) / 1e6;
    if (ms > 0 && ms <= idleMs) {frameMs.push(ms);}
  }
  const refreshMs = refreshNs > 0 ? refreshNs / 1e6 : 16.67;
  const janky = frameMs.filter(ms => ms > refreshMs * 1.5).length;
  const round = n => (n === null ? null : Math.round(n * 10) / 10);
  return {
    source: 'surfaceflinger',
    refreshMs: round(refreshMs),
    totalFrames: frameMs.length,
    jankyFrames: janky,
    jankyPct: frameMs.length ? Math.round((janky / frameMs.length) * 10000) / 100 : null,
    p50Ms: round(percentile(frameMs, 50)),
    p90Ms: round(percentile(frameMs, 90)),
    p95Ms: round(percentile(frameMs, 95)),
    p99Ms: round(percentile(frameMs, 99)),
  };
}

// Verdict on frame stats: 'insufficient' under minFrames, else 'fail' when
// jank % or the 90th percentile is over its limit, else 'ok'.
function judgePerf(stats, { maxJankPct = 10, maxP90Ms = 32, minFrames = 10 } = {}) {
  if (!stats || stats.noProcess) {return { verdict: 'insufficient', reasons: ['the app is not running'] };}
  const frames = stats.totalFrames || 0;
  if (frames < minFrames) {
    return { verdict: 'insufficient', reasons: [`only ${frames} frame(s) recorded (need ${minFrames})`] };
  }
  const reasons = [];
  if (stats.jankyPct !== null && stats.jankyPct > maxJankPct) {
    reasons.push(`janky frames ${stats.jankyPct}% > ${maxJankPct}%`);
  }
  if (stats.p90Ms !== null && stats.p90Ms > maxP90Ms) {
    reasons.push(`90th percentile ${stats.p90Ms}ms > ${maxP90Ms}ms`);
  }
  return { verdict: reasons.length ? 'fail' : 'ok', reasons };
}

const MEM_SUMMARY_KEYS = {
  'Java Heap': 'javaHeap',
  'Native Heap': 'nativeHeap',
  Code: 'code',
  Stack: 'stack',
  Graphics: 'graphics',
  'Private Other': 'privateOther',
  System: 'system',
};

const MEM_OBJECT_KEYS = {
  Views: 'views',
  ViewRootImpl: 'viewRootImpl',
  AppContexts: 'appContexts',
  Activities: 'activities',
  Assets: 'assets',
  AssetManagers: 'assetManagers',
  'Local Binders': 'localBinders',
  'Proxy Binders': 'proxyBinders',
  'Parcel memory': 'parcelMemory',
  'Parcel count': 'parcelCount',
  'Death Recipients': 'deathRecipients',
  WebViews: 'webViews',
};

// The lines of one indented section of meminfo ("App Summary", "Objects"),
// up to the next section header.
function memSection(lines, title) {
  const start = lines.findIndex(l => l.trim() === title);
  if (start < 0) {return [];}
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t && !t.includes(':') && !/^[-\s]+$/.test(t) && !/^(Pss|Rss|Count)/.test(t) && !/\(KB\)/.test(t)) {break;}
    out.push(lines[i]);
  }
  return out;
}

// `dumpsys meminfo <pkg>`: the App Summary (KB) and Objects counts. Handles
// API 30+ ("TOTAL PSS: .. TOTAL RSS: .. TOTAL SWAP PSS: ..") and the older
// "TOTAL: .. TOTAL SWAP PSS: .." line. On Android a Flutter app's Dart heap
// is not in Java Heap: it lands in Native Heap / Private Other ("Unknown").
function parseMeminfo(text) {
  const s = String(text || '');
  if (/No process found for/i.test(s)) {return { noProcess: true };}
  const lines = s.split('\n');
  const head = /\*\* MEMINFO in pid (\d+) \[([^\]]+)\]/.exec(s);
  const summary = {};
  for (const l of memSection(lines, 'App Summary')) {
    const m = /^\s*([A-Za-z ]+):\s+(\d+)/.exec(l);
    if (m && MEM_SUMMARY_KEYS[m[1].trim()]) {summary[MEM_SUMMARY_KEYS[m[1].trim()]] = Number(m[2]);}
    const pss = /TOTAL PSS:\s+(\d+)/.exec(l) || /^\s*TOTAL:\s+(\d+)/.exec(l);
    if (pss) {summary.totalPss = Number(pss[1]);}
    const rss = /TOTAL RSS:\s+(\d+)/.exec(l);
    if (rss) {summary.totalRss = Number(rss[1]);}
    const swap = /TOTAL SWAP(?: PSS| \(KB\)):\s+(\d+)/.exec(l);
    if (swap) {summary.totalSwapPss = Number(swap[1]);}
  }
  const objects = {};
  for (const l of memSection(lines, 'Objects')) {
    const re = /([A-Za-z][A-Za-z ]*?):\s+(\d+)/g;
    let m;
    while ((m = re.exec(l))) {
      const key = MEM_OBJECT_KEYS[m[1].trim()];
      if (key) {objects[key] = Number(m[2]);}
    }
  }
  // Without an App Summary (very old releases), the TOTAL row of the table.
  if (summary.totalPss === undefined) {
    const t = /^\s*TOTAL\s+(\d+)/m.exec(s);
    if (t) {summary.totalPss = Number(t[1]);}
  }
  const out = { noProcess: false, pid: head ? Number(head[1]) : null, pkg: head ? head[2] : null, summary, objects };
  if (summary.totalPss === undefined) {out.unparsed = true;}
  return out;
}

// The object counts whose growth over a repeated flow means a leaked screen.
const LEAK_OBJECTS = ['activities', 'viewRootImpl', 'appContexts'];

// Deltas from snapshot a to b (KB and counts). Fails when TOTAL PSS grew more
// than maxGrowthMb, more than maxGrowthPct (when set), or an Activity /
// ViewRootImpl / AppContext count grew.
function compareMem(a, b, { maxGrowthMb = 25, maxGrowthPct = null } = {}) {
  const sa = (a && a.summary) || {};
  const sb = (b && b.summary) || {};
  const oa = (a && a.objects) || {};
  const ob = (b && b.objects) || {};
  const keys = [...Object.values(MEM_SUMMARY_KEYS), 'totalPss', 'totalRss', 'totalSwapPss'];
  const summary = keys.filter(k => sa[k] !== undefined && sb[k] !== undefined)
    .map(k => ({ key: k, before: sa[k], after: sb[k], delta: sb[k] - sa[k] }));
  const objects = Object.values(MEM_OBJECT_KEYS).filter(k => oa[k] !== undefined && ob[k] !== undefined)
    .map(k => ({ key: k, before: oa[k], after: ob[k], delta: ob[k] - oa[k] }));
  const reasons = [];
  let growthKb = null;
  let growthPct = null;
  if (sa.totalPss !== undefined && sb.totalPss !== undefined) {
    growthKb = sb.totalPss - sa.totalPss;
    growthPct = sa.totalPss ? Math.round((growthKb / sa.totalPss) * 1000) / 10 : null;
    const mb = growthKb / 1024;
    if (maxGrowthMb !== null && maxGrowthMb !== undefined && mb > maxGrowthMb) {
      reasons.push(`TOTAL PSS grew ${mb.toFixed(1)} MB > ${maxGrowthMb} MB`);
    }
    if (maxGrowthPct !== null && maxGrowthPct !== undefined && growthPct !== null && growthPct > maxGrowthPct) {
      reasons.push(`TOTAL PSS grew ${growthPct}% > ${maxGrowthPct}%`);
    }
  } else {
    reasons.push('TOTAL PSS missing from a snapshot');
  }
  for (const o of objects) {
    if (LEAK_OBJECTS.includes(o.key) && o.delta > 0) {
      reasons.push(`${o.key} grew ${o.before} -> ${o.after} (leaked screen?)`);
    }
  }
  // TOTAL PSS counts swapped pages on recent releases, so a device under
  // memory pressure moves the number without the app allocating anything.
  const notes = [];
  if (sa.totalSwapPss !== undefined && sb.totalSwapPss !== undefined) {
    const swapMb = (sb.totalSwapPss - sa.totalSwapPss) / 1024;
    if (Math.abs(swapMb) > 10) {
      notes.push(`swap changed by ${swapMb > 0 ? '+' : ''}${swapMb.toFixed(1)} MB between the snapshots (device memory pressure); check TOTAL RSS too and re-measure with fewer apps running`);
    }
  }
  return { failed: reasons.length > 0, reasons, notes, growthKb, growthPct, summary, objects };
}

// `am start -W`: Status, LaunchState, TotalTime / WaitTime (ms). A timeout
// prints no TotalTime; a warm delivery to a running activity prints 0.
function parseAmStartW(text) {
  const s = String(text || '');
  const num = re => {
    const m = re.exec(s);
    return m ? Number(m[1]) : null;
  };
  const err = /^(Error[^\n]*)/m.exec(s);
  return {
    status: (/^Status: (\S+)/m.exec(s) || [])[1] || null,
    launchState: (/^LaunchState: (\w+)/m.exec(s) || [])[1] || null,
    activity: (/^Activity: (\S+)/m.exec(s) || [])[1] || null,
    totalTime: num(/^TotalTime: (\d+)/m),
    waitTime: num(/^WaitTime: (\d+)/m),
    thisTime: num(/^ThisTime: (\d+)/m),
    delivered: /delivered to currently running top-most instance/i.test(s),
    error: err ? err[1].trim() : null,
  };
}

// The resumed (foreground) activity's component from `dumpsys activity
// activities`: "topResumedActivity=ActivityRecord{1199 u0 com.x/.Main t2}"
// (API 29+) or "mResumedActivity: ActivityRecord{..}" (older). Null if none.
function parseResumedActivity(text) {
  const m = /(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[=:]\s*ActivityRecord\{\S+ u\d+ (\S+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

// `dumpsys package <pkg>` says DEBUGGABLE in pkgFlags for a debug build.
function isDebuggable(text) {
  return /(?:pkgFlags|flags)=\[[^\]]*\bDEBUGGABLE\b/.test(String(text || ''));
}

// "open-url --url 'https://example.com/p/1?a=b;c'; back" -> [['open-url','--url','https://example.com/p/1?a=b;c'], ['back']].
// Steps split on ';' and words on whitespace, both outside single or double
// quotes; a backslash outside single quotes escapes the next character.
function splitSteps(str) {
  const steps = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const s = String(str || '');
  const endWord = () => {
    if (inWord) {words.push(word);}
    word = '';
    inWord = false;
  };
  const endStep = () => {
    endWord();
    if (words.length) {steps.push(words);}
    words = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) {quote = null;}
      else if (c === '\\' && quote === '"' && i + 1 < s.length) {word += s[++i];}
      else {word += c;}
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < s.length) {
      word += s[++i];
      inWord = true;
    } else if (c === ';') {
      endStep();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) {throw new Error(`unterminated ${quote} quote in steps`);}
  endStep();
  return steps;
}

// Android key names `key --code` accepts besides a number or KEYCODE_*.
const KEY_CODES = { BACK: 4, HOME: 3, ENTER: 66, MENU: 82, TAB: 61, DEL: 67, APP_SWITCH: 187, ESCAPE: 111, SEARCH: 84 };

function keyEventArg(code) {
  const c = String(code || '').trim().toUpperCase();
  if (/^\d+$/.test(c)) {return c;}
  if (KEY_CODES[c] !== undefined) {return String(KEY_CODES[c]);}
  if (/^KEYCODE_[A-Z0-9_]+$/.test(c)) {return c;}
  return null;
}

module.exports = {
  parseArgs,
  shellQuote,
  amStartViewCommand,
  amStartFailed,
  amStartOutcome,
  parseAdbDevices,
  normalizeAvd,
  selectSerial,
  emulatorPort,
  freeEmulatorPort,
  adb,
  avdNameOf,
  resolveSerial,
  HEALTH_SHELL,
  parseHealth,
  parseLogcatLine,
  uidMatches,
  countRequests,
  evalCount,
  redactLine,
  androidNodes,
  auditAndroid,
  auditIOS,
  inputTarget,
  median,
  percentile,
  parseGfxinfo,
  parseSfLayers,
  pickSfLayer,
  parseSfLatency,
  judgePerf,
  parseMeminfo,
  compareMem,
  LEAK_OBJECTS,
  parseAmStartW,
  isDebuggable,
  parseResumedActivity,
  splitSteps,
  keyEventArg,
};
