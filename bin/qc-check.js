#!/usr/bin/env node
'use strict';

// qc-check installer. Copies the runtime and one agent adapter into a host
// application repository, and scaffolds qc.config.json.
//
//   npx qc-check init
//   npx qc-check install --agent claude
//   npx qc-check doctor
//
// Zero dependencies on purpose: this runs before anything is installed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR_NAME = 'qc';

const AGENTS = {
  claude: {
    label: 'Claude Code',
    source: 'claude-code',
    // Project-local skill folder.
    target: (host) => path.join(host, '.claude', 'skills', 'qc-check'),
    entry: 'SKILL.md',
    invoke: '/qc-check ABC-123',
  },
  codex: {
    label: 'OpenAI Codex',
    source: 'codex',
    // Codex reads skills from the user's home directory.
    target: () => path.join(os.homedir(), '.codex', 'skills', 'qc-check'),
    entry: 'SKILL.md',
    extras: ['openai.yaml'],
    invoke: 'Use $qc-check for ABC-123',
  },
  generic: {
    label: 'any tool-using agent',
    source: 'generic',
    target: (host) => path.join(host, 'qc-check-skill'),
    entry: 'AGENTS.md',
    invoke: 'see AGENTS.md for the bootstrap prompt',
  },
};

// ---------------------------------------------------------------- utilities

function die(msg) {
  process.stderr.write(`qc-check: ${msg}\n`);
  process.exit(1);
}

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  // Preserve the executable bit for scripts.
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

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
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

// The host repo is where qc.config.json lives, or --dir, or cwd.
function resolveHost(args) {
  if (args.dir) return path.resolve(String(args.dir));
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'qc.config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function readConfig(host) {
  const p = path.join(host, 'qc.config.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    die(`qc.config.json is not valid JSON: ${err.message}`);
    return null;
  }
}

function appendGitignore(host, lines) {
  const p = path.join(host, '.gitignore');
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const missing = lines.filter((l) => !existing.split(/\r?\n/).includes(l));
  if (missing.length === 0) return [];
  const block = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}\n# qc-check: evidence and credentials stay local\n${missing.join('\n')}\n`;
  fs.writeFileSync(p, existing + block);
  return missing;
}

// -------------------------------------------------------------- subcommands

function cmdInit(args) {
  const host = args.dir ? path.resolve(String(args.dir)) : process.cwd();
  const target = path.join(host, 'qc.config.json');

  if (fs.existsSync(target) && !args.force) {
    info(`qc.config.json already exists at ${target}. Use --force to overwrite.`);
  } else {
    copyFile(path.join(PKG_ROOT, 'qc.config.example.json'), target);
    // The example points at a sibling schema file; in a host repo it should
    // point at the published one instead.
    const cfg = JSON.parse(fs.readFileSync(target, 'utf8'));
    delete cfg.$schema;
    fs.writeFileSync(target, `${JSON.stringify(cfg, null, 2)}\n`);
    info(`wrote ${path.relative(host, target)}`);
  }

  const cfg = readConfig(host) || {};
  const credName = cfg.credentialsFile || 'qc.credentials.js';
  const credTarget = path.join(host, credName);
  const credSource = path.join(PKG_ROOT, 'runtime', 'credentials.example.js');
  if (!fs.existsSync(credTarget) && fs.existsSync(credSource)) {
    copyFile(credSource, credTarget);
    info(`wrote ${credName} (fill it in; it is gitignored)`);
  }

  const added = appendGitignore(host, [
    `${(cfg.project && cfg.project.reportsDir) || 'qc-reports'}/`,
    credName,
  ]);
  if (added.length) info(`added to .gitignore: ${added.join(', ')}`);

  info('');
  info('Next: edit qc.config.json, then `npx qc-check install --agent claude`.');
}

function cmdInstall(args) {
  const agentKey = String(args.agent || '').toLowerCase();
  const agent = AGENTS[agentKey];
  if (!agent) {
    die(`--agent must be one of: ${Object.keys(AGENTS).join(', ')}`);
    return;
  }

  const host = resolveHost(args);
  if (!readConfig(host)) {
    die(`no qc.config.json found at ${host}. Run \`npx qc-check init\` there first.`);
  }

  // 1. Runtime scripts into <host>/qc/
  const runtimeTarget = path.join(host, RUNTIME_DIR_NAME);
  const nRuntime = copyDir(path.join(PKG_ROOT, 'runtime'), runtimeTarget);
  info(`runtime  -> ${path.relative(host, runtimeTarget)}/ (${nRuntime} files)`);

  // 2. Canonical workflow + references + the adapter for this agent.
  const skillTarget = agent.target(host);
  fs.mkdirSync(skillTarget, { recursive: true });

  copyFile(path.join(PKG_ROOT, 'skill', 'SKILL.md'), path.join(skillTarget, 'WORKFLOW.md'));
  const nRefs = copyDir(
    path.join(PKG_ROOT, 'skill', 'references'),
    path.join(skillTarget, 'references'),
  );

  const adapterDir = path.join(PKG_ROOT, 'agents', agent.source);
  const adapterEntry = path.join(adapterDir, agent.entry);
  if (!fs.existsSync(adapterEntry)) die(`adapter missing: ${adapterEntry}`);
  copyFile(adapterEntry, path.join(skillTarget, agent.entry));
  for (const extra of agent.extras || []) {
    const p = path.join(adapterDir, extra);
    if (fs.existsSync(p)) copyFile(p, path.join(skillTarget, extra));
  }

  info(`skill    -> ${skillTarget} (${agent.entry}, WORKFLOW.md, ${nRefs} references)`);
  info('');
  info(`Installed for ${agent.label}. Invoke with: ${agent.invoke}`);
  if (agentKey === 'codex') info('Restart Codex so the skill list refreshes.');
}

function cmdDoctor(args) {
  const host = resolveHost(args);
  const cfg = readConfig(host);
  const problems = [];
  const notes = [];

  info(`host repo: ${host}`);

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) problems.push(`Node ${process.versions.node} is too old; 18 or newer is required.`);
  else notes.push(`node ${process.versions.node}`);

  if (!cfg) {
    problems.push('qc.config.json is missing. Run `npx qc-check init`.');
  } else {
    notes.push('qc.config.json parses');
    const reports = (cfg.project && cfg.project.reportsDir) || 'qc-reports';
    notes.push(`reports dir: ${reports}`);

    const enabled = Object.entries((cfg.devices) || {})
      .filter(([k, v]) => k !== 'appium' && v && v.enabled)
      .map(([k]) => k);
    if (enabled.length === 0) problems.push('no device profile is enabled under devices.*');
    else notes.push(`device profiles: ${enabled.join(', ')}`);

    const flavor = (cfg.app && cfg.app.defaultFlavor) || '';
    if (flavor && !(cfg.app.flavors || {})[flavor]) {
      problems.push(`app.defaultFlavor "${flavor}" has no entry in app.flavors`);
    }

    if (cfg.backend && cfg.backend.enabled) {
      const env = cfg.backend.defaultEnv;
      const url = (cfg.backend.baseUrls || {})[env];
      if (!url) problems.push(`backend.baseUrls has no URL for defaultEnv "${env}"`);
      else notes.push(`backend ${env}: ${url}`);
    } else {
      notes.push('backend checks disabled');
    }

    if (!cfg.tracker || cfg.tracker.kind === 'none') {
      notes.push('tracker: none (publish phase is skipped, report stays on disk)');
    } else {
      notes.push(`tracker: ${cfg.tracker.kind}`);
      const unset = Object.entries(cfg.tracker.tools || {})
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (unset.length) notes.push(`tracker tools not wired: ${unset.join(', ')}`);
    }

    // Presence only. The file is never read.
    const credName = cfg.credentialsFile || 'qc.credentials.js';
    if (fs.existsSync(path.join(host, credName))) notes.push(`credentials file present: ${credName}`);
    else problems.push(`credentials file missing: ${credName} (copy runtime/credentials.example.js)`);
  }

  if (!fs.existsSync(path.join(host, RUNTIME_DIR_NAME, 'driver.js'))) {
    problems.push(`runtime not installed. Run \`npx qc-check install --agent <agent>\`.`);
  } else {
    notes.push(`runtime installed at ${RUNTIME_DIR_NAME}/`);
  }

  info('');
  for (const n of notes) info(`  ok    ${n}`);
  for (const p of problems) info(`  FIX   ${p}`);
  info('');
  info(problems.length === 0 ? 'ready.' : `${problems.length} thing(s) to fix.`);
  process.exit(problems.length === 0 ? 0 : 1);
}

function usage() {
  info(`qc-check - install the agent-agnostic mobile QC skill into an app repo.

Usage
  npx qc-check init [--dir <path>] [--force]
      Write qc.config.json and the credentials template, and gitignore them.

  npx qc-check install --agent <claude|codex|generic> [--dir <path>]
      Copy the runtime into <repo>/${RUNTIME_DIR_NAME}/ and the skill into the
      agent's skill folder.

  npx qc-check doctor [--dir <path>]
      Check the configuration and report what is missing. Exits non-zero when
      something needs fixing.

Agents
  claude    ${AGENTS.claude.label} - installs to .claude/skills/qc-check/
  codex     ${AGENTS.codex.label} - installs to ~/.codex/skills/qc-check/
  generic   ${AGENTS.generic.label} - installs to ./qc-check-skill/

The workflow itself is one file (skill/SKILL.md) shared by every agent. The
adapters only map tool names.`);
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (args.version || cmd === 'version') {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    info(pkg.version);
    return;
  }
  if (!cmd || args.help || cmd === 'help') return usage();

  if (cmd === 'init') return cmdInit(args);
  if (cmd === 'install') return cmdInstall(args);
  if (cmd === 'doctor') return cmdDoctor(args);

  die(`unknown command "${cmd}". Run \`qc-check --help\`.`);
}

main();
