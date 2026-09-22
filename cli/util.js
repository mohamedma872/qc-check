'use strict';

// Shared helpers for every qc-check subcommand.
// No dependencies: this runs before anything is installed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = 'qc.config.json';
const RUNTIME_DIR = 'qc';

// ------------------------------------------------------------------ output

function info(msg = '') {
  process.stdout.write(`${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`WARN: ${msg}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`qc-check: ${msg}\n`);
  process.exit(code);
}

function heading(msg) {
  info('');
  info(msg);
  info('-'.repeat(msg.length));
}

// ------------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      if (inline !== undefined) {
        out[key] = inline;
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ------------------------------------------------------------- host repo

// The host repo is --dir, or the nearest ancestor holding qc.config.json,
// or the git root, or cwd.
function findHost(args = {}) {
  if (args.dir) return path.resolve(String(args.dir));

  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (root) return root;
  } catch (_) {
    /* not a git repo */
  }

  return process.cwd();
}

function configPath(host) {
  return path.join(host, CONFIG_FILE);
}

function readConfig(host, { required = false } = {}) {
  const p = configPath(host);
  if (!fs.existsSync(p)) {
    if (required) {
      fail(`no ${CONFIG_FILE} found at ${host}.\n  Run \`qc-check setup\` to create one.`);
    }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    fail(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
    return null;
  }
}

function writeConfig(host, cfg) {
  fs.writeFileSync(configPath(host), `${JSON.stringify(cfg, null, 2)}\n`);
}

function reportsDirOf(host, cfg) {
  const rel = (cfg && cfg.project && cfg.project.reportsDir) || 'qc-reports';
  return path.join(host, rel);
}

function credentialsPathOf(host, cfg) {
  return path.join(host, (cfg && cfg.credentialsFile) || 'qc.credentials.js');
}

// ------------------------------------------------------------------ files

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  try {
    const mode = fs.statSync(from).mode;
    if (mode & 0o111) fs.chmodSync(to, mode);
  } catch (_) {
    /* best effort */
  }
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) n += copyDir(src, dst);
    else {
      copyFile(src, dst);
      n += 1;
    }
  }
  return n;
}

function appendGitignore(host, lines) {
  const p = path.join(host, '.gitignore');
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const have = existing.split(/\r?\n/);
  const missing = lines.filter((l) => !have.includes(l));
  if (missing.length === 0) return [];
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(
    p,
    `${existing}${sep}\n# qc-check: evidence and credentials stay local\n${missing.join('\n')}\n`,
  );
  return missing;
}

// ------------------------------------------------------------- interaction

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Ask a question and resolve to the trimmed answer, or fallback when the
// session is not interactive.
function ask(question, fallback = '') {
  if (!isInteractive()) return Promise.resolve(fallback);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer).trim());
    });
  });
}

async function askWithDefault(label, def) {
  const shown = def ? ` [${def}]` : '';
  const answer = await ask(`  ${label}${shown}: `, '');
  return answer === '' ? def : answer;
}

async function confirm(label, def = true) {
  const hint = def ? 'Y/n' : 'y/N';
  const answer = await ask(`  ${label} (${hint}): `, '');
  if (answer === '') return def;
  return /^y(es)?$/i.test(answer);
}

// ------------------------------------------------------------------ tools

// Is a command available on PATH?
function which(cmd) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.status !== 0) return null;
  return String(res.stdout || '').split('\n')[0].trim() || null;
}

// Run a command and capture output without throwing.
function tryExec(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
  };
}

function listAvds() {
  if (!which('emulator')) return [];
  const res = tryExec('emulator', ['-list-avds']);
  if (!res.ok) return [];
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function listIosSimulators() {
  if (process.platform !== 'darwin' || !which('xcrun')) return [];
  const res = tryExec('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
  if (!res.ok) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    const out = [];
    for (const runtime of Object.keys(parsed.devices || {})) {
      for (const d of parsed.devices[runtime] || []) {
        if (d.isAvailable !== false && d.name) out.push({ name: d.name, udid: d.udid });
      }
    }
    return out;
  } catch (_) {
    return [];
  }
}

function appiumReachable(host, port) {
  const res = tryExec('curl', ['-s', '-m', '2', `http://${host}:${port}/status`]);
  return res.ok && res.stdout.includes('"value"');
}

// ------------------------------------------------------------------ misc

function deepMerge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === 'object' && base && typeof base === 'object' && !Array.isArray(base)) {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
  } catch (_) {
    return '0.0.0';
  }
}

module.exports = {
  PKG_ROOT,
  CONFIG_FILE,
  RUNTIME_DIR,
  info,
  warn,
  fail,
  heading,
  parseArgs,
  findHost,
  configPath,
  readConfig,
  writeConfig,
  reportsDirOf,
  credentialsPathOf,
  copyFile,
  copyDir,
  appendGitignore,
  isInteractive,
  ask,
  askWithDefault,
  confirm,
  which,
  tryExec,
  listAvds,
  listIosSimulators,
  appiumReachable,
  deepMerge,
  pkgVersion,
  homedir: os.homedir,
};
