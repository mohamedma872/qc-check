'use strict';

// `qc-check run pr <n>` and `qc-check prompt pr <n>`: turn a pull request
// number into a target. The PR is read by the runtime's pr.js (the host's
// installed copy when it has one, else the packaged one), in a child process
// so its exits and credential handling stay its own.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { PKG_ROOT, RUNTIME_DIR, fail } = require('./util');

function prScript(host) {
  const installed = path.join(host, RUNTIME_DIR, 'pr.js');
  return fs.existsSync(installed) ? installed : path.join(PKG_ROOT, 'runtime', 'pr.js');
}

// Fills in id, label and the PR facts on a { mode: 'pr', pr } target.
function resolvePrTarget(host, target) {
  if (!/^\d+$/.test(String(target.pr || ''))) {
    fail('"pr" needs a pull request number, for example `qc-check run pr 42`.');
  }
  const res = spawnSync(process.execPath, [prScript(host), 'id', String(target.pr), '--json'], {
    cwd: host,
    encoding: 'utf8',
  });
  let data = null;
  try {
    data = JSON.parse(res.stdout || '');
  } catch (_) {
    data = null;
  }
  if (!data || !data.id) {
    const why = (data && data.reason) || String(res.stderr || res.stdout || '').trim() || `exit ${res.status}`;
    fail(`could not read pull request #${target.pr}: ${why}`);
  }
  const pr = data.pr;
  // stderr, so `qc-check prompt pr <n> > file` still holds only the prompt.
  process.stderr.write(
    `qc-check: PR #${pr.number} "${pr.title}" (${pr.sourceBranch} -> ${pr.targetBranch}), ticket id ${data.id}` +
      (data.source === 'pseudo' ? ' (no ticket key found: pseudo-id)' : ` (from the PR ${data.source})`) +
      '\n',
  );
  return {
    mode: 'pr',
    id: data.id,
    idSource: data.source,
    label: `${data.id} (PR #${pr.number})`,
    pr,
  };
}

module.exports = { resolvePrTarget, prScript };
