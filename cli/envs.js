'use strict';

// Environment and run-folder rules shared by run, prompt, status and report,
// so the commands cannot disagree about which environment a run targets or
// where its evidence lives.

const fs = require('fs');
const path = require('path');

const { fail, reportsDirOf, RUNTIME_DIR } = require('./util');

const PROD_LIKE = /^(prod|production|live|release)$/i;

// Flavors and backend URLs share names, so the union is the environment list.
function listEnvs(cfg) {
  const names = [];
  for (const n of Object.keys((cfg.app && cfg.app.flavors) || {})) if (!names.includes(n)) names.push(n);
  for (const n of Object.keys((cfg.backend && cfg.backend.baseUrls) || {})) if (!names.includes(n)) names.push(n);
  return names;
}

function defaultEnv(cfg) {
  return (cfg.backend && cfg.backend.defaultEnv) || (cfg.app && cfg.app.defaultFlavor) || 'default';
}

function isProtected(cfg, name) {
  const listed = ((cfg.backend && cfg.backend.protectedEnvs) || []).map((n) => String(n).toLowerCase());
  return listed.includes(String(name).toLowerCase()) || PROD_LIKE.test(String(name));
}

// The environment for this invocation: --env, else QC_ENV, else the default.
// An unknown name fails here, before anything touches a device.
function resolveEnv(cfg, requested) {
  const name = requested && requested !== true ? String(requested) : process.env.QC_ENV || defaultEnv(cfg);
  const known = listEnvs(cfg);
  if (known.length && !known.includes(name)) {
    fail(
      `unknown environment "${name}". Known: ${known.join(', ')}.\n` +
        '  Add one with `qc-check env add <name>`, or pick one with --env.',
    );
  }
  return name;
}

// Refuse a protected environment unless the caller opted in explicitly.
function guardProtected(cfg, env, args) {
  if (!isProtected(cfg, env)) return;
  if (args['allow-protected'] === true || args['allow-protected'] === 'true') return;
  fail(
    `"${env}" is a protected environment. A QC run logs in and can write data there.\n` +
      `  If that is really what you want, re-run with --allow-protected.\n` +
      '  Protected: names like prod, production, live, release, and backend.protectedEnvs.',
  );
}

// The folder a target's runs live under: the ticket id, FULL-SWEEP for a
// sweep, and <ID>-FIX for a fix loop so it never writes into the QC run whose
// findings it is fixing.
function runKey(target) {
  if (target.mode === 'sweep') return 'FULL-SWEEP';
  if (target.mode === 'fix') return `${target.id}-FIX`;
  return target.id;
}

function safe(segment) {
  return String(segment).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Where a run would resume, without creating anything.
function peekRun(host, cfg, key, env) {
  const root = path.join(reportsDirOf(host, cfg), safe(key), safe(env));
  const pointer = path.join(root, 'current');
  let id = null;
  if (fs.existsSync(pointer)) {
    const c = fs.readFileSync(pointer, 'utf8').trim();
    if (c && fs.existsSync(path.join(root, c))) id = c;
  }
  return { root, id, dir: id ? path.join(root, id) : null };
}

// The host's installed runtime, loaded against the host repo for one
// environment. The runtime reads its config relative to the working
// directory and caches it, so the directory and QC_ENV are set first.
function hostRuntime(host, env) {
  const dir = path.join(host, RUNTIME_DIR);
  if (!fs.existsSync(path.join(dir, 'runs.js'))) {
    fail(`the runtime at ${dir} predates run folders. Run \`qc-check setup\` to update it.`);
  }
  process.chdir(host);
  if (env) process.env.QC_ENV = env;
  // eslint-disable-next-line global-require
  const config = require(path.join(dir, 'config.js'));
  // eslint-disable-next-line global-require
  const runs = require(path.join(dir, 'runs.js'));
  return { config, runs };
}

// A build command for one environment: {flavor} becomes the flavor name.
function buildFor(cfg, platform, env) {
  const raw = (cfg.app && cfg.app.build && cfg.app.build[platform]) || '';
  const flavors = (cfg.app && cfg.app.flavors) || {};
  const flavor = flavors[env] ? env : (cfg.app && cfg.app.defaultFlavor) || env;
  return raw.replace(/\{flavor\}/g, flavor);
}

module.exports = {
  listEnvs,
  defaultEnv,
  isProtected,
  resolveEnv,
  guardProtected,
  runKey,
  peekRun,
  hostRuntime,
  buildFor,
};
