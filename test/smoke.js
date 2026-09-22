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

  check('leak guard passes', () => {
    run([path.join(ROOT, 'test', 'no-private-refs.js')], { cwd: ROOT });
  });
} finally {
  fs.rmSync(host, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

process.stdout.write(`\nsmoke: ${checks - failures}/${checks} passed\n`);
process.exit(failures === 0 ? 0 : 1);
