#!/usr/bin/env node
'use strict';

// Device-driver checks that need no device: argument parsing, adb quoting,
// serial selection, logcat counting, health parsing, the testID audit, and an
// end-to-end run of driver.js against a fake Appium server with adb stubbed
// out, proving a credential never reaches argv, a child process or the output.
//
//   node test/driver.js

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRIVER = path.join(ROOT, 'runtime', 'driver.js');
const device = require(path.join(ROOT, 'runtime', 'device.js'));

let failures = 0;
let checks = 0;

async function check(name, fn) {
  checks += 1;
  try {
    await fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${String(err.message).split('\n')[0]}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) {throw new Error(msg);}
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {throw new Error(`${msg}: expected ${e}, got ${a}`);}
}

// --- fixtures ------------------------------------------------------------------

const ADB_DEVICES = [
  'List of devices attached',
  'emulator-5554\tdevice',
  'emulator-5556\tdevice',
  'ABC123DEVICE\tunauthorized',
  '',
].join('\n');

// Dio LogInterceptor style output, as `logcat -v epoch,uid` prints it. The app
// is uid 10242. One product call is logged twice (request and response), adbd
// echoes the open-url command, and another app logs the same path.
const LOG = [
  '--------- beginning of main',
  '  1000.000 10242  3883  3883 I flutter : *** Request ***',
  '  1000.001 10242  3883  3883 I flutter : uri: https://api.example.com/v2/products/ABC-123?fields=FULL',
  '  1000.002 10242  3883  3883 I flutter : method: GET',
  '  1000.003 10242  3883  3883 I flutter :  authorization: bearer eyJhbGciOi.secret.token',
  '  1000.400 10242  3883  3883 I flutter : *** Response ***',
  '  1000.401 10242  3883  3883 I flutter : uri: https://api.example.com/v2/products/ABC-123?fields=FULL',
  '  1000.500 shell   451   451 I adbd    : adbd service requested \'shell,v2,raw:am start -d \'https://www.example.com/p/ABC-123\'\'',
  '  1001.000 10111  2222  2222 I OtherApp: GET https://api.example.com/v2/products/ABC-123',
  '  1002.000 u0_a242 3883  3883 I flutter : *** Request ***',
  '  1002.001 u0_a242 3883  3883 I flutter : uri: https://api.example.com/v2/recsForPlacements?x=1',
  '  1003.000 10242  3883  3883 I flutter : *** Request ***',
  '  1003.001 10242  3883  3883 I flutter : uri: https://api.example.com/v2/products/ABC-123?fields=FULL',
  '',
].join('\n');

const ANDROID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">
  <android.widget.FrameLayout index="0" class="android.widget.FrameLayout" text="" resource-id="" content-desc="" clickable="false" displayed="true" bounds="[0,0][1080,2400]">
    <android.view.View index="0" class="android.view.View" text="" resource-id="" content-desc="Sign in" clickable="true" displayed="true" bounds="[40,200][1040,300]" />
    <android.widget.EditText index="1" class="android.widget.EditText" text="" hint="Email" resource-id="" content-desc="" clickable="true" password="false" displayed="true" bounds="[40,400][1040,520]" />
    <android.widget.EditText index="2" class="android.widget.EditText" text="" hint="Password" resource-id="" content-desc="" clickable="true" password="true" displayed="true" bounds="[40,560][1040,680]" />
    <android.widget.Button index="3" class="android.widget.Button" text="Continue" resource-id="com.example.app:id/continue" content-desc="" clickable="true" displayed="true" bounds="[40,720][1040,840]" />
    <android.view.View index="4" class="android.view.View" text="" resource-id="" content-desc="" clickable="true" displayed="true" bounds="[900,60][1020,180]" />
    <android.widget.Button index="5" class="android.widget.Button" text="Hidden" resource-id="" content-desc="" clickable="true" displayed="true" bounds="[0,0][0,0]" />
  </android.widget.FrameLayout>
</hierarchy>`;

// --- pure logic -------------------------------------------------------------------

async function pureChecks() {
  console.log('\nargument parsing');

  await check('parseArgs reads values, bare flags and an empty string', () => {
    eq(
      device.parseArgs(['--text', 'hello world', '--gone', '--timeout', '500', '--name', '']),
      { text: 'hello world', gone: true, timeout: '500', name: '' },
      'parsed',
    );
  });

  await check('parseArgs treats a flag followed by a flag as true', () => {
    eq(device.parseArgs(['--fix', '--timeout', '9']), { fix: true, timeout: '9' }, 'parsed');
  });

  console.log('\nadb quoting');

  const urls = [
    'https://www.example.com/en/p/ABC-123?utm_source=qc&utm_medium=test',
    "https://www.example.com/search?q=it's&sort=a|b;c",
    'myapp://product/ABC-123?x=$HOME&y=`id`&z=*',
    'https://www.example.com/a b/(c)?d=<e>',
  ];

  await check('shellQuote survives a real /bin/sh unchanged (&, ?, quotes, $, backticks)', () => {
    for (const u of urls) {
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${device.shellQuote(u)}`], { encoding: 'utf8' });
      eq(out, u, 'round trip');
    }
  });

  await check('amStartViewCommand builds VIEW + BROWSABLE with a quoted URL and component', () => {
    const cmd = device.amStartViewCommand(urls[0], 'com.example.app', '.MainActivity');
    assert(cmd.includes('-a android.intent.action.VIEW'), 'action');
    assert(cmd.includes('-c android.intent.category.BROWSABLE'), 'category');
    assert(cmd.includes(`-d '${urls[0]}'`), `quoted url: ${cmd}`);
    assert(cmd.includes("-n 'com.example.app/.MainActivity'"), `component: ${cmd}`);
    // The device shell sees exactly one -d argument.
    const argv = execFileSync('/bin/sh', ['-c', `for a in ${cmd.replace(/^am start -W /, '')}; do echo "[$a]"; done`], { encoding: 'utf8' });
    assert(argv.includes(`[${urls[0]}]`), 'one argument for the URL');
  });

  await check('amStartViewCommand falls back to -p when no activity is configured', () => {
    const cmd = device.amStartViewCommand('https://www.example.com/x', 'com.example.app', '');
    assert(cmd.endsWith("-p 'com.example.app'"), cmd);
  });

  await check('amStartFailed spots an unresolved intent and passes a normal start', () => {
    assert(device.amStartFailed('Starting: Intent { ... }\nError: Activity not started, unable to resolve Intent'), 'error found');
    eq(device.amStartFailed('Starting: Intent { act=android.intent.action.VIEW }\nStatus: ok\nLaunchState: WARM'), null, 'ok output');
    const delivered = 'Starting: Intent { act=android.intent.action.VIEW }\nWarning: Activity not started, intent has been delivered to currently running top-most instance.\nStatus: ok';
    eq(device.amStartFailed(delivered), null, 'delivered to a singleTop activity is a success');
    eq(device.amStartOutcome(delivered), 'delivered to the running activity', 'outcome');
    const front = 'Starting: Intent { act=android.intent.action.VIEW }\nWarning: Activity not started, its current task has been brought to the front';
    eq(device.amStartFailed(front), null, 'task brought to the front is not a failure');
    eq(device.amStartOutcome(front), 'task brought to the front', 'front outcome');
  });

  console.log('\nserial selection');

  const devices = device.parseAdbDevices(ADB_DEVICES);

  await check('parseAdbDevices reads serial and state', () => {
    eq(devices, [
      { serial: 'emulator-5554', state: 'device' },
      { serial: 'emulator-5556', state: 'device' },
      { serial: 'ABC123DEVICE', state: 'unauthorized' },
    ], 'devices');
  });

  const avdOf = { 'emulator-5554': 'Example_Phone_API_35', 'emulator-5556': 'Other_Lane' };

  await check('selectSerial matches the configured avd among several devices', () => {
    eq(device.selectSerial(devices, avdOf, { avd: 'Example_Phone_API_35' }).serial, 'emulator-5554', 'serial');
    eq(device.selectSerial(devices, avdOf, { avd: 'Other Lane' }).serial, 'emulator-5556', 'space/underscore');
  });

  await check('selectSerial never falls back to another device', () => {
    const r = device.selectSerial(devices, avdOf, { avd: 'Missing_AVD' });
    assert(!r.serial && r.notRunning, 'no serial for a missing avd');
    const r2 = device.selectSerial(devices, avdOf, {});
    assert(!r2.serial && /2 devices are attached/.test(r2.error), `unpinned with two devices: ${r2.error}`);
  });

  await check('selectSerial honours udid and reports a device that is not ready', () => {
    eq(device.selectSerial(devices, avdOf, { udid: 'emulator-5556', avd: 'Example_Phone_API_35' }).serial, 'emulator-5556', 'udid wins');
    assert(/unauthorized/.test(device.selectSerial(devices, avdOf, { udid: 'ABC123DEVICE' }).error), 'unauthorized');
  });

  await check('selectSerial picks the only device when nothing is pinned', () => {
    eq(device.selectSerial([{ serial: 'emulator-5554', state: 'device' }], {}, {}).serial, 'emulator-5554', 'single');
  });

  await check('resolveSerial reads avd names with -s and every call names a device', () => {
    const calls = [];
    const exec = (bin, argv) => {
      calls.push([bin, ...argv]);
      if (argv[0] === 'devices') {return ADB_DEVICES;}
      const serial = argv[1];
      return argv.includes('ro.boot.qemu.avd_name') ? `${avdOf[serial] || ''}\n` : '';
    };
    const r = device.resolveSerial({ avd: 'Example_Phone_API_35' }, { exec });
    eq(r.serial, 'emulator-5554', 'serial');
    for (const c of calls.slice(1)) {assert(c[1] === '-s' && c[2], `unpinned adb call: ${c.join(' ')}`);}
    assert(!calls.some(c => c.includes('ABC123DEVICE')), 'a non-emulator is not probed for an avd');
  });

  await check('resolveSerial re-checks the session serial and probes no other device', () => {
    const calls = [];
    const exec = (bin, argv) => {
      calls.push(argv.join(' '));
      if (argv[0] === 'devices') {return ADB_DEVICES;}
      return argv.includes('ro.boot.qemu.avd_name') ? `${avdOf[argv[1]]}\n` : '';
    };
    const r = device.resolveSerial({ avd: 'Example_Phone_API_35' }, { exec, preferred: 'emulator-5554' });
    eq(r.serial, 'emulator-5554', 'serial');
    assert(!calls.some(c => c.includes('emulator-5556')), `touched the other emulator: ${calls.join(' | ')}`);
  });

  await check('emulator ports: parse a serial and find a free one', () => {
    eq(device.emulatorPort('emulator-5556'), 5556, 'port');
    eq(device.emulatorPort('ABC123DEVICE'), null, 'physical');
    eq(device.freeEmulatorPort(devices), 5558, 'free port');
  });

  console.log('\nhealth');

  await check('parseHealth accepts a healthy device', () => {
    const h = device.parseHealth('boot=1\nService package: found\nService activity: found\nload=0.43 0.34 0.27 2/2644 13581\ncpus=4\n');
    assert(h.healthy && !h.overloaded, JSON.stringify(h.problems));
    eq(h.load, [0.43, 0.34, 0.27], 'load');
  });

  await check('parseHealth flags a dead package service, an unfinished boot and overload', () => {
    const h = device.parseHealth('boot=\nService package: not found\nService activity: found\nload=11.2 9.0 8.1 1/1 1\ncpus=4\n');
    assert(!h.healthy, 'unhealthy');
    assert(h.problems.some(p => /package: not found/.test(p)), 'package problem');
    assert(h.problems.some(p => /boot_completed/.test(p)), 'boot problem');
    assert(h.overloaded, 'overloaded');
    assert(/activity: no answer/.test(device.parseHealth('boot=1\nService package: found\n').problems.join()), 'missing answer');
  });

  console.log('\nlogcat request counting');

  await check('parseLogcatLine reads epoch, uid, pid, tag and message', () => {
    const e = device.parseLogcatLine('  1000.001 10242  3883  3883 I flutter : uri: https://api.example.com/x');
    eq([e.ts, e.uid, e.pid, e.tag, e.msg], [1000.001, '10242', '3883', 'flutter', 'uri: https://api.example.com/x'], 'fields');
  });

  await check('countRequests counts request copies only, for the app only, never adbd', () => {
    const r = device.countRequests(LOG, { grep: /products\/ABC-123/, appUid: '10242' });
    eq(r.count, 2, 'two product calls');
    assert(r.matches.every(m => m.tag === 'flutter'), 'only app lines');
  });

  await check('countRequests --all-lines and --all-processes widen the count (adbd still excluded)', () => {
    eq(device.countRequests(LOG, { grep: /products\/ABC-123/, appUid: '10242', allLines: true }).count, 3, 'all lines');
    eq(device.countRequests(LOG, { grep: /products\/ABC-123/ }).count, 3, 'all processes');
  });

  await check('countRequests honours the mark window and the u0_aNNN uid form', () => {
    eq(device.countRequests(LOG, { grep: /products\/ABC-123/, appUid: '10242', since: 1002 }).count, 1, 'after mark');
    eq(device.countRequests(LOG, { grep: /recsForPlacements/, appUid: '10242' }).count, 1, 'u0_a242 is uid 10242');
    eq(device.countRequests(LOG, { grep: /recsForPlacements/, appUid: '10242', since: 1002.5 }).count, 0, 'zero after');
  });

  await check('countRequests reports a rotated buffer as truncated', () => {
    assert(device.countRequests(LOG, { grep: /x/, since: 900 }).truncated, 'mark older than the buffer');
    assert(!device.countRequests(LOG, { grep: /x/, since: 1001 }).truncated, 'mark inside the buffer');
  });

  await check('countRequests understands OkHttp style --> / <-- lines', () => {
    const okhttp = [
      '  10.0 10242 1 1 D OkHttp  : --> GET https://api.example.com/v1/items',
      '  10.5 10242 1 1 D OkHttp  : <-- 200 OK https://api.example.com/v1/items (120ms)',
    ].join('\n');
    eq(device.countRequests(okhttp, { grep: /v1\/items/, appUid: '10242' }).count, 1, 'one call');
  });

  await check('evalCount: --count, --min, --max and the default', () => {
    assert(device.evalCount(0, { count: '0' }).ok, 'count 0');
    assert(!device.evalCount(1, { count: '0' }).ok, 'count 0 with one call');
    assert(device.evalCount(3, { min: '1' }).ok && !device.evalCount(0, { min: '1' }).ok, 'min');
    assert(device.evalCount(2, { max: '2' }).ok && !device.evalCount(3, { max: '2' }).ok, 'max');
    assert(device.evalCount(2, { min: '1', max: '3' }).ok, 'range');
    assert(device.evalCount(1, {}).ok && !device.evalCount(0, {}).ok, 'default at least 1');
    assert(device.evalCount(0, { count: 'x' }).error, 'bad number');
  });

  await check('redactLine hides bearer tokens and password values', () => {
    const r = device.redactLine('authorization: bearer eyJhbGciOi.secret.token password=hunter2&x=1');
    assert(!/eyJhbGciOi|hunter2/.test(r), r);
    assert(/x=1/.test(r), 'keeps the rest');
  });

  console.log('\naudit-ids');

  await check('auditAndroid lists the unnamed fields and controls with a command for each', () => {
    const { interactive, missing } = device.auditAndroid(ANDROID_XML);
    eq(interactive, 5, 'interactive (zero-size skipped)');
    eq(missing.map(m => m.drive), [
      'input --class android.widget.EditText --index 0',
      'input --class android.widget.EditText --index 1',
      'tap --x 960 --y 120',
    ], 'missing');
    assert(missing[1].password && missing[0].hint === 'Email', 'password and hint carried');
  });

  await check('auditIOS lists unnamed fields and buttons', () => {
    const xml = '<XCUIElementTypeApplication name="App"><XCUIElementTypeTextField name="" label="" value="Email" x="10" y="100" width="300" height="40" visible="true"/>' +
      '<XCUIElementTypeButton name="login-button" label="Log in" x="10" y="200" width="300" height="40" visible="true"/>' +
      '<XCUIElementTypeSecureTextField x="10" y="150" width="300" height="40" visible="true"/></XCUIElementTypeApplication>';
    const { interactive, missing } = device.auditIOS(xml);
    eq(interactive, 3, 'interactive');
    eq(missing.map(m => m.drive), [
      'input --class XCUIElementTypeTextField --index 0',
      'input --class XCUIElementTypeSecureTextField --index 0',
    ], 'missing');
  });

  console.log('\ninput targeting');

  await check('inputTarget accepts selector, class + index and x/y', () => {
    eq(device.inputTarget({ selector: '~email' }).kind, 'selector', 'selector');
    const c = device.inputTarget({ class: 'android.widget.EditText', index: '1' });
    eq([c.kind, c.index], ['class', 1], 'class');
    eq(device.inputTarget({ x: '100', y: '200' }), { kind: 'point', x: 100, y: 200, label: '(100, 200)' }, 'point');
  });

  await check('inputTarget rejects missing, mixed and malformed targets', () => {
    assert(device.inputTarget({}).error, 'none');
    assert(device.inputTarget({ selector: '~a', class: 'X' }).error, 'mixed');
    assert(device.inputTarget({ x: '1' }).error, 'x without y');
    assert(device.inputTarget({ class: 'X', index: '-1' }).error, 'negative index');
    assert(device.inputTarget({ class: true }).error, 'class without a value');
  });

  await check('inputTarget never carries the typed value', () => {
    const t = device.inputTarget({ class: 'android.widget.EditText', index: '0', credential: 'password', text: 'S3cret' });
    assert(!JSON.stringify(t).includes('S3cret') && !JSON.stringify(t).includes('password'), JSON.stringify(t));
  });
}

// --- end to end against a fake Appium server ---------------------------------------

const SECRET_USER = 'qc-user-7f3a@example.com';
const SECRET_PASS = 'Zq9-unique-Pa55-value';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 4, 0, 0, 0, 4]),
  Buffer.alloc(200, 7),
]);

function fakeAppium() {
  const state = { bodies: [], polls: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      state.bodies.push({ method: req.method, url: req.url, body: raw });
      let value = null;
      if (/\/elements$/.test(req.url)) {
        if (body.using === 'class name' && body.value === 'android.widget.EditText') {
          value = [{ ELEMENT: 'field-0' }, { ELEMENT: 'field-1' }];
        } else if (/text\("Saved"\)/.test(body.value)) {
          state.polls += 1;
          value = state.polls >= 3 ? [{ ELEMENT: 'toast' }] : [];
        } else {
          value = [];
        }
      } else if (/\/element\/active$/.test(req.url)) {
        value = { ELEMENT: 'field-1' };
      } else if (/\/screenshot$/.test(req.url)) {
        value = PNG.toString('base64');
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ value }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

// Preloaded into driver.js: records every child process it starts and answers
// adb itself, so no real device is ever touched.
const HOOK = `
const cp = require('child_process');
const fs = require('fs');
const log = process.env.QC_TEST_SPAWN_LOG;
const record = (bin, argv) => fs.appendFileSync(log, JSON.stringify([bin, ...(argv || [])]) + '\\n');
const png = Buffer.from(process.env.QC_TEST_PNG, 'base64');
const fake = (bin, argv, opts) => {
  record(bin, argv);
  if (bin !== 'adb') { throw Object.assign(new Error('blocked in test: ' + bin), { code: 'ENOENT' }); }
  const a = argv.join(' ');
  let out = '';
  if (a === 'devices') out = 'List of devices attached\\nemulator-5554\\tdevice\\nemulator-5556\\tdevice\\n';
  else if (a.includes('ro.boot.qemu.avd_name')) out = argv[1] === 'emulator-5554' ? 'Example_Phone_API_35\\n' : 'Other_Lane\\n';
  else if (a.includes('screencap')) return png;
  return opts && opts.encoding === 'buffer' ? Buffer.from(out) : out;
};
cp.execFileSync = fake;
cp.spawn = (bin, argv) => { record(bin, argv); throw new Error('spawn blocked in test'); };
cp.execSync = cmd => { record('sh', [cmd]); throw new Error('execSync blocked in test'); };
`;

function makeHost(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-driver-test-'));
  fs.writeFileSync(path.join(dir, 'qc.config.json'), JSON.stringify({
    project: { name: 'Example', reportsDir: 'qc-reports' },
    app: {
      defaultFlavor: 'staging',
      androidActivity: '.MainActivity',
      flavors: { staging: { androidPackage: 'com.example.app', iosBundleId: 'com.example.app' } },
    },
    devices: {
      android: { enabled: true, avd: 'Example_Phone_API_35' },
      ios: { enabled: true, deviceName: 'iPhone', udid: '' },
      appium: { host: '127.0.0.1', port },
    },
    backend: { defaultEnv: 'staging' },
  }, null, 2));
  const hook = path.join(dir, 'hook.js');
  fs.writeFileSync(hook, HOOK);
  const sessionFile = path.join(dir, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify({
    sessionId: 'S1', profile: 'android', platform: 'android', flavor: 'staging',
    host: '127.0.0.1', port, serial: 'emulator-5554',
  }));
  return { dir, hook, sessionFile, spawnLog: path.join(dir, 'spawn.log') };
}

function runDriver(host, args) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {if (/^QC_/.test(k)) {delete env[k];}}
  Object.assign(env, {
    QC_SESSION_FILE: host.sessionFile,
    QC_TEST_SPAWN_LOG: host.spawnLog,
    QC_TEST_PNG: PNG.toString('base64'),
    QC_CRED_STAGING_USERNAME: SECRET_USER,
    QC_CRED_STAGING_PASSWORD: SECRET_PASS,
  });
  const argv = ['-r', host.hook, DRIVER, ...args];
  return new Promise(resolve => {
    execFile(process.execPath, argv, { cwd: host.dir, env, encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ status: err ? (err.code === undefined ? 1 : err.code) : 0, out: `${stdout}${stderr}`, argv });
    });
  });
}

function spawned(host) {
  try {
    return fs.readFileSync(host.spawnLog, 'utf8');
  } catch {
    return '';
  }
}

async function endToEnd() {
  console.log('\ndriver.js against a fake Appium server (adb stubbed)');
  const { server, state, port } = await fakeAppium();
  const host = makeHost(port);
  const noSecret = (text, where) => {
    assert(!text.includes(SECRET_PASS) && !text.includes(SECRET_USER), `credential leaked into ${where}`);
  };

  try {
    await check('input --class --index --credential types the value via the request body only', async () => {
      const r = await runDriver(host, ['input', '--class', 'android.widget.EditText', '--index', '1', '--credential', 'password']);
      assert(r.status === 0, `exit ${r.status}: ${r.out}`);
      assert(/OK: typed credential "password" \(\d+ characters\) into "android.widget.EditText\[1\]"/.test(r.out), r.out);
      const typed = state.bodies.find(b => /\/element\/field-1\/value$/.test(b.url));
      assert(typed && typed.body.includes(SECRET_PASS), 'the value reached Appium for field-1');
      noSecret(r.out, 'stdout/stderr');
      noSecret(r.argv.join(' '), 'argv');
      noSecret(spawned(host), 'a child process');
    });

    await check('input --x --y --credential taps, then types into the focused field', async () => {
      state.bodies.length = 0;
      const r = await runDriver(host, ['input', '--x', '540', '--y', '620', '--credential', 'username']);
      assert(r.status === 0, `exit ${r.status}: ${r.out}`);
      assert(state.bodies.some(b => /\/actions$/.test(b.url)), 'tapped');
      const typed = state.bodies.find(b => /\/element\/field-1\/value$/.test(b.url));
      assert(typed && typed.body.includes(SECRET_USER), 'typed into the active element');
      noSecret(r.out, 'stdout/stderr');
      noSecret(spawned(host), 'a child process');
    });

    await check('input errors name the target, never the credential', async () => {
      const r = await runDriver(host, ['input', '--class', 'android.widget.EditText', '--index', '5', '--credential', 'password']);
      assert(r.status !== 0 && /out of range/.test(r.out), r.out);
      noSecret(r.out, 'the error');
      const r2 = await runDriver(host, ['input', '--class', 'X', '--x', '1', '--y', '2', '--credential', 'password']);
      assert(r2.status !== 0 && /mutually exclusive/.test(r2.out), r2.out);
    });

    await check('wait-for polls until the element appears, then captures with adb screencap on the pinned serial', async () => {
      state.polls = 0;
      const r = await runDriver(host, ['wait-for', '--text', 'Saved', '--timeout', '5000', '--interval', '20', '--screenshot', 'tc1-toast']);
      assert(r.status === 0, `exit ${r.status}: ${r.out}`);
      assert(/OK: screenshot saved: .*tc1-toast.*\(adb screencap/.test(r.out), r.out);
      assert(/OK: "Saved" appeared after/.test(r.out), r.out);
      const cap = spawned(host).split('\n').filter(l => l.includes('screencap'));
      assert(cap.length && cap.every(l => l.startsWith('["adb","-s","emulator-5554"')), `capture not pinned: ${cap}`);
    });

    await check('wait-for --gone and a timeout report ASSERT FAILED', async () => {
      state.polls = 0;
      const r = await runDriver(host, ['wait-for', '--text', 'Nope', '--timeout', '200', '--interval', '20']);
      assert(r.status === 1 && /ASSERT FAILED - "Nope" did not appear/.test(r.out), r.out);
      const g = await runDriver(host, ['wait-for', '--text', 'Nope', '--gone', '--timeout', '500']);
      assert(g.status === 0 && /is gone/.test(g.out), g.out);
    });

    await check('every adb call the driver makes names a device', async () => {
      const calls = spawned(host).split('\n').filter(Boolean).map(l => JSON.parse(l));
      const adbCalls = calls.filter(c => c[0] === 'adb' && c[1] !== 'devices');
      assert(adbCalls.length, 'some adb calls were made');
      assert(adbCalls.every(c => c[1] === '-s' && c[2] === 'emulator-5554'), JSON.stringify(adbCalls));
    });

    await check('assert-request and log-mark say WARN and exit 2 on iOS', async () => {
      const r = await runDriver(host, ['assert-request', '--grep', 'x', '--count', '0', '--platform', 'ios']);
      assert(r.status === 2 && /^WARN: .*not supported on iOS/m.test(r.out), `${r.status}: ${r.out}`);
      const m = await runDriver(host, ['log-mark', '--platform', 'ios']);
      assert(m.status === 2 && /WARN:/.test(m.out), m.out);
    });

    await check('open-url without --url prints usage and fails', async () => {
      const r = await runDriver(host, ['open-url']);
      assert(r.status === 1 && /Usage: open-url --url/.test(r.out), r.out);
    });

    await check('--help lists the new commands', async () => {
      const r = await runDriver(host, ['--help']);
      for (const c of ['open-url', 'log-mark', 'assert-request', 'wait-for', 'audit-ids', 'health', '--class']) {
        assert(r.out.includes(c), `help is missing ${c}`);
      }
    });
  } finally {
    server.close();
    fs.rmSync(host.dir, { recursive: true, force: true });
  }
}

(async () => {
  await pureChecks();
  await endToEnd();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();
