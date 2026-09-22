#!/usr/bin/env node
'use strict';

// End-to-end check of the installer and the runtime, with no device and no
// network. Creates a throwaway host repo, runs init / install / doctor, then
// exercises the state and cost scripts.
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
    process.stdout.write(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}\n`);
  }
}

function run(args, opts = {}) {
  return execFileSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const host = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-host-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-home-'));
process.stdout.write(`smoke: host repo at ${host}\n\n`);

try {
  check('--help exits 0', () => {
    const out = run([CLI, '--help']);
    assert(out.includes('qc-check'), 'help text missing');
  });

  check('init scaffolds config, credentials and gitignore', () => {
    run([CLI, 'init', '--dir', host]);
    assert(fs.existsSync(path.join(host, 'qc.config.json')), 'qc.config.json not written');
    const cfg = JSON.parse(fs.readFileSync(path.join(host, 'qc.config.json'), 'utf8'));
    assert(cfg.project && cfg.project.reportsDir, 'config missing project.reportsDir');
    const ignore = fs.readFileSync(path.join(host, '.gitignore'), 'utf8');
    assert(ignore.includes('qc-reports/'), 'reports dir not gitignored');
    assert(ignore.includes(cfg.credentialsFile), 'credentials file not gitignored');
  });

  check('doctor reports what is still missing', () => {
    let code = 0;
    try {
      run([CLI, 'doctor', '--dir', host]);
    } catch (err) {
      code = err.status;
    }
    assert(code !== 0, 'doctor should exit non-zero before install');
  });

  for (const agent of ['claude', 'generic']) {
    check(`install --agent ${agent}`, () => {
      run([CLI, 'install', '--agent', agent, '--dir', host]);
      assert(fs.existsSync(path.join(host, 'qc', 'driver.js')), 'runtime not copied');
      assert(fs.existsSync(path.join(host, 'qc', 'config.js')), 'config loader not copied');
      const skillDir =
        agent === 'claude'
          ? path.join(host, '.claude', 'skills', 'qc-check')
          : path.join(host, 'qc-check-skill');
      assert(fs.existsSync(path.join(skillDir, 'WORKFLOW.md')), 'canonical workflow not copied');
      assert(fs.existsSync(path.join(skillDir, 'references')), 'references not copied');
    });
  }

  check('install --agent codex targets the home skills folder', () => {
    run([CLI, 'install', '--agent', 'codex', '--dir', host], {
      env: { ...process.env, HOME: home },
    });
    const dir = path.join(home, '.codex', 'skills', 'qc-check');
    assert(fs.existsSync(path.join(dir, 'WORKFLOW.md')), 'codex workflow not installed');
  });

  check('install --agent nonsense is rejected', () => {
    let code = 0;
    try {
      run([CLI, 'install', '--agent', 'nonsense', '--dir', host]);
    } catch (err) {
      code = err.status;
    }
    assert(code !== 0, 'unknown agent should fail');
  });

  check('doctor passes once configured', () => {
    // The scaffolded credentials template counts as present.
    run([CLI, 'doctor', '--dir', host]);
  });

  check('every runtime script parses', () => {
    for (const f of fs.readdirSync(path.join(host, 'qc'))) {
      if (f.endsWith('.js')) run(['--check', path.join(host, 'qc', f)]);
    }
  });

  check('state.js tracks phases and gates the device pass', () => {
    const state = path.join(host, 'qc', 'state.js');
    if (!fs.existsSync(state)) throw new Error('state.js not installed');
    run([state, 'ABC-123', 'set', 'ticket', 'pass'], { cwd: host });
    const out = run([state, 'ABC-123', 'get'], { cwd: host });
    assert(/ticket/.test(out), 'phase not recorded');
    const reports = path.join(host, 'qc-reports');
    assert(fs.existsSync(reports), 'reports dir not created');
  });

  check('no-private-refs guard passes', () => {
    run([path.join(ROOT, 'test', 'no-private-refs.js')], { cwd: ROOT });
  });
} finally {
  fs.rmSync(host, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

process.stdout.write(`\nsmoke: ${checks - failures}/${checks} passed\n`);
process.exit(failures === 0 ? 0 : 1);
