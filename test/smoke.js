#!/usr/bin/env node
'use strict';

// End-to-end check of the CLI with no device, no agent and no network.
// Builds a throwaway app repository, configures it, and exercises every
// command that does not require hardware.
//
//   node test/smoke.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'qc-check.js');

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks += 1;
  try {
    fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${String(err.message).split('\n')[0]}\n`);
  }
}

function run(args, opts = {}) {
  return execFileSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

// Run and tolerate a non-zero exit, returning both streams.
function runSoft(args, opts = {}) {
  try {
    return { status: 0, out: run(args, opts) };
  } catch (err) {
    return {
      status: err.status === undefined ? 1 : err.status,
      out: `${String(err.stdout || '')}${String(err.stderr || '')}`,
    };
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A minimal but realistic host app repo, so setup has something to detect.
function makeHostRepo() {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-host-'));
  const write = (rel, body) => {
    const p = path.join(host, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  write(
    'package.json',
    JSON.stringify(
      {
        name: 'example-app',
        scripts: {
          test: 'jest',
          lint: 'eslint .',
          'android:staging': 'react-native run-android --variant=stagingDebug',
        },
      },
      null,
      2,
    ),
  );
  write('yarn.lock', '');
  write(
    'android/app/build.gradle',
    `android {
  defaultConfig { applicationId "com.example.app" }
  productFlavors {
    staging { applicationIdSuffix ".staging" }
    production { }
  }
}`,
  );
  write(
    'android/app/src/main/AndroidManifest.xml',
    `<manifest><application><activity android:name=".MainActivity">
      <intent-filter><action android:name="android.intent.action.MAIN"/>
      <category android:name="android.intent.category.LAUNCHER"/></intent-filter>
    </activity></application></manifest>`,
  );
  write('src/navigation/RootNavigator.tsx', 'export default null;\n');
  write('src/translations/en/common.json', '{}');
  write('src/translations/ar/common.json', '{}');
  write('src/api/services/example.ts', 'export {};\n');
  return host;
}

const host = makeHostRepo();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-home-'));
process.stdout.write(`smoke: host repo at ${host}\n\n`);

try {
  check('--help lists the commands', () => {
    const out = run([CLI, '--help']);
    for (const cmd of ['setup', 'doctor', 'run', 'prompt', 'status', 'report', 'install']) {
      assert(out.includes(cmd), `help is missing "${cmd}"`);
    }
  });

  check('every command has its own help', () => {
    for (const cmd of ['setup', 'doctor', 'run', 'prompt', 'status', 'report', 'install']) {
      const r = runSoft([CLI, cmd, '--help']);
      assert(r.status === 0, `${cmd} --help exited ${r.status}`);
      assert(r.out.length > 20, `${cmd} --help printed nothing useful`);
    }
  });

  check('doctor refuses an unconfigured repo and names the fix', () => {
    const r = runSoft([CLI, 'doctor', '--dir', host]);
    assert(r.status !== 0, 'doctor should exit non-zero before setup');
    assert(/qc-check setup/.test(r.out), 'doctor should point at setup');
  });

  check('setup --yes configures the repo without prompting', () => {
    run([CLI, 'setup', '--yes', '--dir', host]);
    assert(fs.existsSync(path.join(host, 'qc.config.json')), 'qc.config.json not written');
    assert(fs.existsSync(path.join(host, 'qc', 'driver.js')), 'runtime not installed');
    const cfg = JSON.parse(fs.readFileSync(path.join(host, 'qc.config.json'), 'utf8'));
    assert(cfg.project && cfg.project.reportsDir, 'project.reportsDir missing');
    assert(cfg.agent && cfg.agent.kind, 'agent.kind missing');
    const ignore = fs.readFileSync(path.join(host, '.gitignore'), 'utf8');
    assert(ignore.includes(cfg.credentialsFile), 'credentials file not gitignored');
    assert(fs.existsSync(path.join(host, cfg.credentialsFile)), 'credentials template not written');
  });

  check('setup detected the project instead of guessing', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(host, 'qc.config.json'), 'utf8'));
    const flavors = JSON.stringify(cfg.app.flavors || {});
    assert(/com\.example\.app/.test(flavors), `android package not detected: ${flavors}`);
    assert(
      (cfg.project.locales || []).includes('ar'),
      `locales not detected: ${JSON.stringify(cfg.project.locales)}`,
    );
    assert(
      (cfg.project.rtlLocales || []).includes('ar'),
      'ar should have been classified right-to-left',
    );
    assert(/jest/.test(cfg.codeMap.testCommand || ''), 'test command not detected');
  });

  check('setup is idempotent and keeps hand edits', () => {
    const p = path.join(host, 'qc.config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.project.name = 'Edited By Hand';
    cfg.budget.runCap = 7;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    run([CLI, 'setup', '--yes', '--dir', host]);
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert(after.project.name === 'Edited By Hand', 'hand-edited name was overwritten');
    assert(after.budget.runCap === 7, 'hand-edited budget was overwritten');
  });

  check('prompt assembles a complete, credential-free prompt', () => {
    const out = run([CLI, 'prompt', 'ABC-123', '--dir', host]);
    assert(out.length > 2000, `prompt looks truncated (${out.length} chars)`);
    assert(/ABC-123/.test(out), 'prompt does not name the target');
    assert(/test.plan/i.test(out), 'prompt is missing the test-plan phase');
    assert(!/CHANGE_ME/.test(out), 'prompt leaked the credentials template');
    assert(!/password\s*[:=]\s*['"]/.test(out), 'prompt looks like it contains a credential');
  });

  check('run --dry-run shows what would be executed', () => {
    const r = runSoft([CLI, 'run', 'ABC-123', '--dir', host, '--dry-run']);
    assert(r.status === 0, `dry run exited ${r.status}: ${r.out.slice(0, 200)}`);
    assert(r.out.length > 20, 'dry run printed nothing');
  });

  check('run rejects a target that is not a valid ticket', () => {
    const r = runSoft([CLI, 'run', 'not a ticket', '--dir', host, '--dry-run']);
    assert(r.status !== 0, 'an invalid ticket should be refused');
  });

  check('status reports an empty repo, then a real run', () => {
    let out = run([CLI, 'status', '--dir', host]);
    assert(/no runs/i.test(out), `expected an empty-state message, got: ${out.slice(0, 120)}`);

    const stateJs = path.join(host, 'qc', 'state.js');
    run([stateJs, 'ABC-123', 'set', 'ticket', 'pass'], { cwd: host });
    out = run([CLI, 'status', 'ABC-123', '--dir', host]);
    assert(/ticket/.test(out), 'status does not show the phase');
  });

  check('report explains itself when there is no report yet', () => {
    const r = runSoft([CLI, 'report', 'ABC-123', '--dir', host]);
    assert(r.status !== 0, 'a missing report should exit non-zero');
    assert(/status|run/i.test(r.out), 'should suggest what to do next');
  });

  check('report prints a finished report from the run folder', () => {
    const dir = run([path.join(host, 'qc', 'runs.js'), 'open', 'ABC-123'], { cwd: host }).trim();
    assert(dir && fs.existsSync(dir), `run folder not created: ${dir}`);
    fs.writeFileSync(path.join(dir, 'report.md'), '# ABC-123\n\n## Overall: PASS\n');
    const out = run([CLI, 'report', 'ABC-123', '--dir', host]);
    assert(/Overall: PASS/.test(out), 'report body not printed');
    const summary = JSON.parse(run([CLI, 'report', 'ABC-123', '--dir', host, '--json']));
    assert(summary.verdict === 'PASS', `summary.json verdict wrong: ${summary.verdict}`);
    assert(summary.ticket === 'ABC-123' && summary.environment, 'summary.json missing identity');
  });

  check('evidence is filed per ticket, environment and run', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(host, 'qc.config.json'), 'utf8'));
    const base = path.join(host, cfg.project.reportsDir);
    const env = cfg.backend.defaultEnv || cfg.app.defaultFlavor;
    const ticketDir = path.join(base, 'ABC-123', env);
    assert(fs.existsSync(ticketDir), `no ${ticketDir}`);
    const runs = fs.readdirSync(ticketDir).filter((f) => f !== 'current');
    assert(runs.length >= 1, 'no run folder');
    const dir = path.join(ticketDir, runs[0]);
    for (const sub of ['screenshots', 'recordings', 'trees', 'api']) {
      assert(fs.existsSync(path.join(dir, sub)), `missing ${sub}/`);
    }
    assert(fs.existsSync(path.join(base, 'index.md')), 'index.md not written');
    assert(fs.existsSync(path.join(base, 'index.json')), 'index.json not written');
  });

  check('artifacts are numbered inside the run', () => {
    const p = run([path.join(host, 'qc', 'runs.js'), 'path', 'screenshots', 'login', 'png'], {
      cwd: host,
    }).trim();
    assert(/screenshots\/001-login\.png$/.test(p), `unexpected artifact path: ${p}`);
  });

  check('a second environment gets its own run folder', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(host, 'qc.config.json'), 'utf8'));
    cfg.app.flavors.uat = { androidPackage: 'com.example.app.uat', iosBundleId: '' };
    cfg.backend.baseUrls.uat = 'https://api.example.com';
    fs.writeFileSync(path.join(host, 'qc.config.json'), JSON.stringify(cfg, null, 2));
    run([path.join(host, 'qc', 'runs.js'), 'open', 'ABC-123', '--env', 'uat'], { cwd: host });
    const base = path.join(host, cfg.project.reportsDir);
    assert(fs.existsSync(path.join(base, 'ABC-123', 'uat')), 'uat run folder missing');
  });

  check('env lists environments and their credential status', () => {
    const out = run([CLI, 'env', '--dir', host]);
    assert(/uat/.test(out), 'uat not listed');
    assert(/credentials/i.test(out), 'no credentials column');
    assert(!/CHANGE_ME.*password|password.*=/.test(out), 'env list looks like it printed a value');
  });

  check('credentials come from QC_CRED_* variables', () => {
    const out = run([CLI, 'env', '--dir', host], {
      env: { ...process.env, QC_CRED_UAT_USERNAME: 'qa', QC_CRED_UAT_PASSWORD: 'pw-should-not-appear' },
    });
    assert(!/pw-should-not-appear/.test(out), 'a credential value reached stdout');
    assert(/env/.test(out), 'env-var credentials not reported');
  });

  check('a form-encoded login sends secret-referenced headers and masks them', () => {
    const cfgPath = path.join(host, 'qc.config.json');
    const original = fs.readFileSync(cfgPath, 'utf8');
    const portFile = path.join(home, 'mock-port');
    const logFile = path.join(home, 'mock-log.json');
    fs.writeFileSync(path.join(host, 'secrets.json'), JSON.stringify({ BASIC: 'Basic c2VjcmV0LWNsaWVudA==' }));
    // A stand-in OAuth server: it only issues a token for a form body carrying
    // the referenced Basic header, then serves one Bearer-protected read.
    const server = require('child_process').spawn(process.execPath, ['-e', `
      const http = require('http'); const fs = require('fs');
      const srv = http.createServer((req, res) => {
        let body = ''; req.on('data', c => { body += c; });
        req.on('end', () => {
          fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ url: req.url, headers: req.headers, body }));
          if (req.url === '/oauth/token') {
            const ok = req.headers['content-type'] === 'application/x-www-form-urlencoded'
              && req.headers.authorization === 'Basic c2VjcmV0LWNsaWVudA=='
              && req.headers['x-client'] === 'from-env'
              && (body === 'grant_type=password&scope=basic&username=qa&password=pw-secret'
                || body === 'grant_type=client_credentials&scope=basic');
            res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
            res.end(JSON.stringify(ok ? { access_token: 'tok-abcdef-123456' } : { error: 'bad login', body }));
          } else {
            const ok = req.headers.authorization === 'Bearer tok-abcdef-123456';
            res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok, seen: req.headers.authorization || null }));
          }
        });
      });
      srv.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(portFile)}, String(srv.address().port)));
    `], { stdio: 'ignore' });
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(portFile) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      assert(fs.existsSync(portFile), 'mock server did not start');
      const port = fs.readFileSync(portFile, 'utf8');
      const cfg = JSON.parse(original);
      cfg.backend = {
        ...cfg.backend,
        enabled: true,
        defaultEnv: 'uat',
        baseUrls: { ...(cfg.backend && cfg.backend.baseUrls), uat: `http://127.0.0.1:${port}` },
        smokePath: '/me',
        auth: {
          path: '/oauth/token',
          bodyEncoding: 'form',
          extraBody: { grant_type: 'password', scope: 'basic' },
          headers: { Authorization: '${file:secrets.json#BASIC}', 'X-Client': '${env:QC_TEST_CLIENT}' },
          tokenPath: 'access_token',
        },
      };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      const env = { ...process.env, QC_ENV: 'uat', QC_TEST_CLIENT: 'from-env', QC_CRED_UAT_USERNAME: 'qa', QC_CRED_UAT_PASSWORD: 'pw-secret' };
      const r = runSoft([path.join(host, 'qc', 'api.js'), '--smoke'], { cwd: host, env });
      assert(r.status === 0, `smoke failed (exit ${r.status}): ${r.out.slice(0, 200)}`);
      assert(/"ok": true/.test(r.out), 'authenticated read did not succeed');
      for (const secret of ['c2VjcmV0LWNsaWVudA==', 'pw-secret', 'tok-abcdef-123456']) {
        assert(!r.out.includes(secret), `a secret reached the output: ${secret.slice(0, 4)}...`);
      }
      cfg.backend.guestAuth = { bodyEncoding: 'form', extraBody: { grant_type: 'client_credentials', scope: 'basic' },
        headers: { Authorization: '${file:secrets.json#BASIC}', 'X-Client': '${env:QC_TEST_CLIENT}' } };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      const guestEnv = { ...env }; delete guestEnv.QC_CRED_UAT_USERNAME; delete guestEnv.QC_CRED_UAT_PASSWORD;
      const g = runSoft([path.join(host, 'qc', 'api.js'), '--guest', '--smoke'], { cwd: host, env: guestEnv });
      assert(g.status === 0 && /"ok": true/.test(g.out), `guest smoke failed (exit ${g.status}): ${g.out.slice(0, 160)}`);
      assert(!g.out.includes('tok-abcdef-123456') && !g.out.includes('c2VjcmV0LWNsaWVudA=='), 'a guest secret reached the output');
      delete env.QC_TEST_CLIENT;
      const missing = runSoft([path.join(host, 'qc', 'api.js'), '--token'], { cwd: host, env });
      assert(missing.status === 1 && /\$\{env:QC_TEST_CLIENT\} did not resolve/.test(missing.out), 'an unresolved reference was not refused');
    } finally {
      server.kill();
      fs.writeFileSync(cfgPath, original);
      fs.rmSync(path.join(host, 'secrets.json'), { force: true });
    }
  });

  check('jira over REST fetches, saves and publishes a ticket without leaking the token', () => {
    const cfgPath = path.join(host, 'qc.config.json');
    const original = fs.readFileSync(cfgPath, 'utf8');
    const portFile = path.join(home, 'jira-port');
    const logFile = path.join(home, 'jira-log.txt');
    const server = require('child_process').spawn(process.execPath, ['-e', `
      const http = require('http'); const fs = require('fs');
      const ok = 'Basic ' + Buffer.from('qa@example.com:jira-secret-token').toString('base64');
      const srv = http.createServer((req, res) => {
        let body = ''; req.on('data', c => { body += c; });
        req.on('end', () => {
          fs.appendFileSync(${JSON.stringify(logFile)}, req.method + ' ' + req.url + ' ' + (req.headers['content-type'] || '') + '\\n');
          const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj ? JSON.stringify(obj) : ''); };
          if (req.headers.authorization !== ok) return send(401, { errorMessages: ['bad auth'] });
          if (req.url === '/rest/api/3/myself') return send(200, { displayName: 'QA Bot' });
          if (req.url.startsWith('/rest/api/3/issue/ABC-123?')) return send(200, { key: 'ABC-123', fields: {
            summary: 'Apply a coupon', status: { name: 'In Progress' }, issuetype: { name: 'Story' },
            description: { type: 'doc', content: [
              { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance Criteria' }] },
              { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Coupon reduces the total' }] }] }] } ] },
            issuelinks: [], subtasks: [], attachment: [] } });
          if (req.url === '/rest/api/2/issue/ABC-123/comment' && req.method === 'POST') return send(201, { id: '42' });
          if (req.url === '/rest/api/3/issue/ABC-123/attachments' && req.method === 'POST') return send(200, [{ id: '7' }]);
          if (req.url === '/rest/api/3/issue/ABC-123' && req.method === 'PUT') return send(204);
          send(404, { errorMessages: ['nope'] });
        });
      });
      srv.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(portFile)}, String(srv.address().port)));
    `], { stdio: 'ignore' });
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(portFile) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      assert(fs.existsSync(portFile), 'mock jira did not start');
      const cfg = JSON.parse(original);
      cfg.tracker = { ...cfg.tracker, kind: 'jira', rest: { enabled: true, baseUrlEnv: 'QC_T_URL', emailEnv: 'QC_T_EMAIL', tokenEnv: 'QC_T_TOKEN' } };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      const runDir = run([path.join(host, 'qc', 'runs.js'), 'open', 'ABC-123'], { cwd: host }).trim().split('\n').pop();
      const env = { ...process.env, QC_RUN_DIR: runDir, QC_T_URL: `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8')}`,
        QC_T_EMAIL: 'qa@example.com', QC_T_TOKEN: 'jira-secret-token' };
      const tr = a => runSoft([path.join(host, 'qc', 'tracker.js'), ...a], { cwd: host, env });
      const all = [];
      const checkOut = tr(['check']); all.push(checkOut.out);
      assert(checkOut.status === 0 && /QA Bot/.test(checkOut.out), `check failed: ${checkOut.out.slice(0, 120)}`);
      const got = tr(['get', 'abc-123', '--save']); all.push(got.out);
      assert(got.status === 0, `get failed: ${got.out.slice(0, 160)}`);
      const saved = fs.readFileSync(path.join(runDir, 'ticket.md'), 'utf8');
      assert(/# ABC-123 - Apply a coupon/.test(saved) && /## Acceptance Criteria/.test(saved) && /- Coupon reduces the total/.test(saved), 'ticket.md is not the converted ticket');
      const report = path.join(home, 'report.md'); fs.writeFileSync(report, 'QC Agent Report - ABC-123');
      const c = tr(['comment', 'ABC-123', '--file', report]); all.push(c.out);
      assert(c.status === 0 && /comment 42/.test(c.out), `comment failed: ${c.out.slice(0, 120)}`);
      const at = tr(['attach', 'ABC-123', report]); all.push(at.out);
      assert(at.status === 0, `attach failed: ${at.out.slice(0, 120)}`);
      const lb = tr(['labels', 'ABC-123', '--add', 'QC-Agent-Pass', '--remove', 'BE-Blocking']); all.push(lb.out);
      assert(lb.status === 0, `labels failed: ${lb.out.slice(0, 120)}`);
      assert(/multipart\/form-data/.test(fs.readFileSync(logFile, 'utf8')), 'attachment was not sent as multipart');
      const bad = runSoft([path.join(host, 'qc', 'tracker.js'), 'check'], { cwd: host, env: { ...env, QC_T_TOKEN: 'wrong-token' } });
      all.push(bad.out);
      assert(bad.status === 2, 'a refused token should exit 2');
      assert(!all.join('\n').includes('jira-secret-token') && !all.join('\n').includes('wrong-token'), 'a token reached the output');
    } finally {
      server.kill();
      fs.writeFileSync(cfgPath, original);
    }
  });

  check('a protected environment is refused without the flag', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(host, 'qc.config.json'), 'utf8'));
    cfg.app.flavors.prod = { androidPackage: 'com.example.app', iosBundleId: '' };
    fs.writeFileSync(path.join(host, 'qc.config.json'), JSON.stringify(cfg, null, 2));
    const refused = runSoft([CLI, 'run', 'ABC-123', '--dir', host, '--env', 'prod', '--dry-run']);
    assert(refused.status !== 0, 'prod should be refused');
    assert(/allow-protected/.test(refused.out), 'the refusal should name the override');
    const allowed = runSoft([
      CLI, 'run', 'ABC-123', '--dir', host, '--env', 'prod', '--dry-run', '--allow-protected',
    ]);
    assert(allowed.status === 0, `--allow-protected should proceed: ${allowed.out.slice(0, 160)}`);
  });

  check('an unknown environment fails with the known list', () => {
    const r = runSoft([CLI, 'run', 'ABC-123', '--dir', host, '--env', 'nope', '--dry-run']);
    assert(r.status !== 0, 'unknown environment should fail');
    assert(/uat/.test(r.out), 'the error should list the known environments');
  });

  check('a real iPhone gets signing capabilities, a simulator does not', () => {
    const p = path.join(host, 'qc.config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const f of Object.values(cfg.app.flavors)) f.iosBundleId = 'com.example.app';
    const configJs = path.join(host, 'qc', 'config.js');
    const caps = () => JSON.parse(run([configJs, '--caps', 'ios'], { cwd: host }));

    cfg.devices.ios = { enabled: true, deviceName: 'iPhone 17', udid: '' };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    const sim = caps();
    assert(!('appium:xcodeOrgId' in sim) && !('appium:xcodeSigningId' in sim), 'simulator caps carry signing');

    cfg.devices.ios = { enabled: true, realDevice: true, deviceName: 'QA iPhone', udid: '', teamId: 'TEAM123456' };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    const noUdid = runSoft([configJs, '--caps', 'ios'], { cwd: host });
    assert(noUdid.status !== 0 && /udid/.test(noUdid.out), 'a real device without a udid should be refused');

    cfg.devices.ios.udid = '00000000-0000000000000000';
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    const real = caps();
    assert(real['appium:udid'] === cfg.devices.ios.udid, 'udid not passed');
    assert(real['appium:xcodeOrgId'] === 'TEAM123456', 'team id not passed');
    assert(real['appium:xcodeSigningId'] === 'Apple Development', 'signing id default missing');

    cfg.devices.ios = { enabled: false, deviceName: '', udid: '' };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  });

  check('the simulator WDA patch embeds only missing testing libraries', () => {
    const { embedTestingFrameworks } = require(path.join(ROOT, 'runtime', 'wda.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-wda-'));
    const plat = path.join(tmp, 'dev', 'Platforms', 'iPhoneSimulator.platform', 'Developer');
    const mk = (rel) => fs.mkdirSync(path.join(plat, rel), { recursive: true });
    const touch = (rel) => { mk(path.dirname(rel)); fs.writeFileSync(path.join(plat, rel), 'x'); };
    mk('Library/Frameworks/Testing.framework');
    mk('Library/Frameworks/_Testing_Foundation.framework');
    mk('Library/PrivateFrameworks/XCTestCore.framework');
    mk('Library/PrivateFrameworks/DVTFoundation.framework');
    touch('usr/lib/lib_TestingInterop.dylib');
    touch('usr/lib/XCTest.swiftmodule');
    const app = path.join(tmp, 'WebDriverAgentRunner-Runner.app');
    fs.mkdirSync(path.join(app, 'Frameworks', 'Testing.framework'), { recursive: true });

    const added = embedTestingFrameworks(app, path.join(tmp, 'dev')).sort();
    assert(
      JSON.stringify(added) ===
        JSON.stringify(['XCTestCore.framework', '_Testing_Foundation.framework', 'lib_TestingInterop.dylib']),
      `unexpected embed set: ${added.join(', ')}`,
    );
    assert(embedTestingFrameworks(app, path.join(tmp, 'dev')).length === 0, 'a second pass should add nothing');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  check('a prepared simulator WDA skips xcodebuild, a real iPhone and an opt-out do not', () => {
    if (process.platform !== 'darwin') return; // wda.js only builds on macOS
    // A fake Xcode, XCUITest driver and cache, so no build or device is needed.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-wda-'));
    const devDir = path.join(tmp, 'Xcode.app', 'Contents', 'Developer');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(
      path.join(devDir, '..', 'version.plist'),
      '<plist><dict><key>ProductBuildVersion</key>\n<string>17Z99</string></dict></plist>',
    );
    const wdaSrc = path.join(tmp, 'appium', 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent');
    fs.mkdirSync(path.join(wdaSrc, 'WebDriverAgent.xcodeproj'), { recursive: true });
    fs.writeFileSync(path.join(wdaSrc, 'package.json'), '{"version":"9.9.9"}');
    const cache = path.join(tmp, 'cache');
    const env = { ...process.env, DEVELOPER_DIR: devDir, APPIUM_HOME: path.join(tmp, 'appium'), QC_WDA_CACHE: cache };

    const configJs = path.join(host, 'qc', 'config.js');
    const p = path.join(host, 'qc.config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const f of Object.values(cfg.app.flavors)) f.iosBundleId = 'com.example.app';
    const caps = () => JSON.parse(run([configJs, '--caps', 'ios'], { cwd: host, env }));
    const save = () => fs.writeFileSync(p, JSON.stringify(cfg, null, 2));

    cfg.devices.ios = { enabled: true, deviceName: 'iPhone 17', udid: '' };
    save();
    assert(!('appium:usePreinstalledWDA' in caps()), 'without a ready runner Appium keeps its default launch');

    const built = path.join(cache, '9.9.9-xcode17Z99');
    const app = path.join(built, 'Build', 'Products', 'Debug-iphonesimulator', 'WebDriverAgentRunner-Runner.app');
    fs.mkdirSync(app, { recursive: true });
    assert(!('appium:usePreinstalledWDA' in caps()), 'a half-built runner (no ready marker) must not be used');
    fs.writeFileSync(path.join(built, '.qc-ready'), 'now');
    const sim = caps();
    assert(sim['appium:usePreinstalledWDA'] === true, 'a ready runner should switch to usePreinstalledWDA');
    assert(sim['appium:prebuiltWDAPath'] === app, `wrong prebuiltWDAPath: ${sim['appium:prebuiltWDAPath']}`);

    cfg.devices.ios = { enabled: true, deviceName: 'iPhone 17', udid: '', caps: { 'appium:usePreinstalledWDA': null, 'appium:prebuiltWDAPath': null } };
    save();
    const optOut = caps();
    assert(!('appium:usePreinstalledWDA' in optOut) && !('appium:prebuiltWDAPath' in optOut), 'null caps should opt out');

    cfg.devices.ios = { enabled: true, realDevice: true, deviceName: 'QA iPhone', udid: '00000000-0000000000000000', teamId: 'TEAM123456' };
    save();
    assert(!('appium:usePreinstalledWDA' in caps()), 'a real iPhone needs its own signed WDA, not the simulator build');

    cfg.devices.ios = { enabled: false, deviceName: '', udid: '' };
    save();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  check('each repo gets its own session file and helper ports', () => {
    const configJs = path.join(host, 'qc', 'config.js');
    const mine = run([configJs, '--session-file'], { cwd: host }).trim();
    const other = run([configJs, '--session-file'], { cwd: home }).trim();
    assert(/qc-session-.+\.json$/.test(mine), `unexpected session path: ${mine}`);
    assert(mine !== other, 'two repos share one session file');
    const pinned = run([configJs, '--session-file'], {
      cwd: host,
      env: { ...process.env, QC_SESSION_FILE: '/tmp/qc-session-pinned.json' },
    }).trim();
    assert(pinned === '/tmp/qc-session-pinned.json', 'QC_SESSION_FILE no longer wins');
    const caps = JSON.parse(run([configJs, '--caps', 'android'], { cwd: host }));
    const port = caps['appium:systemPort'];
    assert(port >= 8200 && port < 8300, `systemPort not derived: ${port}`);
  });

  check('install --agent wires up a slash command', () => {
    run([CLI, 'install', '--agent', 'claude', '--dir', host]);
    const dir = path.join(host, '.claude', 'skills', 'qc-check');
    assert(fs.existsSync(path.join(dir, 'WORKFLOW.md')), 'workflow not installed');
    assert(fs.existsSync(path.join(dir, 'references')), 'references not installed');

    run([CLI, 'install', '--agent', 'codex', '--dir', host], {
      env: { ...process.env, HOME: home },
    });
    assert(
      fs.existsSync(path.join(home, '.codex', 'skills', 'qc-check', 'WORKFLOW.md')),
      'codex workflow not installed',
    );
  });

  check('install rejects an unknown agent', () => {
    const r = runSoft([CLI, 'install', '--agent', 'nonsense', '--dir', host]);
    assert(r.status !== 0, 'unknown agent should fail');
  });

  check('unknown command fails clearly', () => {
    const r = runSoft([CLI, 'nonsense']);
    assert(r.status !== 0, 'unknown command should exit non-zero');
    assert(/unknown command/i.test(r.out), 'should say the command is unknown');
  });

  check('every shipped script parses', () => {
    const dirs = ['cli', 'bin', 'runtime', 'test'];
    for (const d of dirs) {
      for (const f of fs.readdirSync(path.join(ROOT, d))) {
        if (f.endsWith('.js')) run(['--check', path.join(ROOT, d, f)]);
      }
    }
  });

  check('a clone runs with no install step', () => {
    const wrapper = path.join(ROOT, 'qc-check');
    assert(fs.existsSync(wrapper), 'the ./qc-check wrapper is missing');
    assert(fs.statSync(wrapper).mode & 0o111, 'the ./qc-check wrapper is not executable');
    const out = execFileSync(wrapper, ['--version'], { encoding: 'utf8' }).trim();
    assert(/^\d+\.\d+\.\d+$/.test(out), `wrapper printed "${out}"`);
  });

  check('the installer is valid POSIX sh and self-documents', () => {
    const script = path.join(ROOT, 'install.sh');
    assert(fs.existsSync(script), 'install.sh is missing');
    execFileSync('sh', ['-n', script]); // parse without executing
    const help = execFileSync('sh', [script, '--help'], { encoding: 'utf8' });
    for (const flag of ['--prefix', '--ref', '--update', '--uninstall']) {
      assert(help.includes(flag), `install.sh --help does not mention ${flag}`);
    }
    // Ignore comments: the script says it does not use sudo, which is the point.
    const src = fs.readFileSync(script, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    assert(!/(^|[;&|\s])sudo\s/.test(src), 'the installer must never invoke sudo');
    assert(!/npm (install|i) /.test(src), 'the installer must not depend on npm');
  });

  check('installer rejects an unknown option', () => {
    let failed = false;
    try {
      execFileSync('sh', [path.join(ROOT, 'install.sh'), '--nonsense'], { stdio: 'pipe' });
    } catch (_) {
      failed = true;
    }
    assert(failed, 'an unknown option should be refused');
  });

  check('leak guard passes', () => {
    run([path.join(ROOT, 'test', 'no-private-refs.js')], { cwd: ROOT });
  });
} finally {
  fs.rmSync(host, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

process.stdout.write(`\nsmoke: ${checks - failures}/${checks} passed\n`);
process.exit(failures === 0 ? 0 : 1);
