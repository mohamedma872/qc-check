'use strict';

// qc-check install: optional. Exposes the same workflow as a slash command
// inside an agent, for people who would rather start QC from their agent
// session than from a shell. The CLI remains the supported path; this just
// puts the workflow where the agent looks for skills.

const fs = require('fs');
const path = require('path');

const {
  PKG_ROOT,
  info,
  fail,
  findHost,
  readConfig,
  copyFile,
  copyDir,
  homedir,
} = require('./util');

const TARGETS = {
  claude: {
    label: 'Claude Code',
    source: 'claude-code',
    dir: (host) => path.join(host, '.claude', 'skills', 'qc-check'),
    entry: 'SKILL.md',
    invoke: '/qc-check ABC-123',
  },
  codex: {
    label: 'OpenAI Codex',
    source: 'codex',
    dir: () => path.join(homedir(), '.codex', 'skills', 'qc-check'),
    entry: 'SKILL.md',
    extras: ['openai.yaml'],
    invoke: 'Use $qc-check for ABC-123',
  },
  generic: {
    label: 'any other agent',
    source: 'generic',
    dir: (host) => path.join(host, 'qc-check-workflow'),
    entry: 'AGENTS.md',
    invoke: 'paste the prompt from AGENTS.md',
  },
};

function help() {
  info(`qc-check install - also expose QC as a slash command in your agent.

Usage
  qc-check install --agent <claude|codex|generic> [--dir <path>]

Optional. \`qc-check run\` already drives your agent from the shell; this is for
starting a run from inside an agent session instead.

  claude    ${TARGETS.claude.label}, installs to .claude/skills/qc-check/
  codex     ${TARGETS.codex.label}, installs to ~/.codex/skills/qc-check/
  generic   ${TARGETS.generic.label}, installs to ./qc-check-workflow/

The workflow itself is one file shared by every agent and by the CLI, so these
never drift apart.`);
}

async function run(args) {
  const key = String(args.agent || '').toLowerCase();
  const target = TARGETS[key];
  if (!target) {
    fail(`--agent must be one of: ${Object.keys(TARGETS).join(', ')}`);
    return;
  }

  const host = findHost(args);
  readConfig(host, { required: true });

  const dir = target.dir(host);
  fs.mkdirSync(dir, { recursive: true });

  copyFile(path.join(PKG_ROOT, 'skill', 'SKILL.md'), path.join(dir, 'WORKFLOW.md'));
  const refs = copyDir(
    path.join(PKG_ROOT, 'skill', 'references'),
    path.join(dir, 'references'),
  );

  const adapterDir = path.join(PKG_ROOT, 'agents', target.source);
  const entry = path.join(adapterDir, target.entry);
  if (!fs.existsSync(entry)) fail(`adapter missing: ${entry}`);
  copyFile(entry, path.join(dir, target.entry));
  for (const extra of target.extras || []) {
    const p = path.join(adapterDir, extra);
    if (fs.existsSync(p)) copyFile(p, path.join(dir, extra));
  }

  info(`installed for ${target.label}`);
  info(`  ${dir}`);
  info(`  ${target.entry}, WORKFLOW.md, ${refs} references`);
  info('');
  info(`Invoke with: ${target.invoke}`);
  if (key === 'codex') info('Restart Codex so the skill list refreshes.');
}

module.exports = { run, help };
