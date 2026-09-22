'use strict';

// `qc-check env`: list, add, select and remove the environments a project is
// QC'd against, and manage the QC account for each one.
//
// An environment is a name shared by app.flavors (which build to install) and
// backend.baseUrls (which backend that build talks to). Credentials live in
// the generated credentials file, keyed by the same name, or in
// QC_CRED_<ENV>_USERNAME / QC_CRED_<ENV>_PASSWORD.
//
// No value from the credentials file is ever printed: the table shows where
// an account would come from, never what it is.

const fs = require('fs');
const path = require('path');

const u = require('./util');
const creds = require('./credentials-file');

// Mirrors runtime/config.js PROD_LIKE. Duplicated because config.js only
// exposes isProtectedEnv() through its cwd-bound, cached loader, and this CLI
// works on the raw config of an explicit --dir.
const PROD_LIKE = /^(prod|production|live|release)$/i;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// ----------------------------------------------------------------- shared

function isProtected(cfg, name) {
  const listed = (((cfg || {}).backend || {}).protectedEnvs || []).map((n) => String(n).toLowerCase());
  return listed.includes(String(name).toLowerCase()) || PROD_LIKE.test(String(name));
}

// Same union and order as config.environments(): flavors first, then any
// backend-only names.
function environmentsOf(cfg) {
  const flavors = ((cfg || {}).app || {}).flavors || {};
  const urls = ((cfg || {}).backend || {}).baseUrls || {};
  const names = [];
  for (const n of Object.keys(flavors)) if (!names.includes(n)) names.push(n);
  for (const n of Object.keys(urls)) if (!names.includes(n)) names.push(n);
  return names.map((name) => {
    const f = flavors[name] || {};
    return {
      name,
      androidPackage: f.androidPackage || '',
      iosBundleId: f.iosBundleId || '',
      baseUrl: urls[name] || '',
      protected: isProtected(cfg, name),
    };
  });
}

function defaultEnvOf(cfg) {
  return ((cfg.backend || {}).defaultEnv) || ((cfg.app || {}).defaultFlavor) || '';
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => `  ${r.map((c, i) => String(c).padEnd(widths[i])).join('  ')}`.trimEnd());
}

// The environments table used by `env list` and the setup summary. Presence
// only: the credentials column is a status word.
function printEnvTable(host, cfg) {
  const envs = environmentsOf(cfg);
  const file = u.credentialsPathOf(host, cfg);
  if (envs.length === 0) {
    u.info('  no environments configured. Add one with `qc-check env add <name>`.');
    return;
  }
  const def = defaultEnvOf(cfg);
  const rows = [['', 'name', 'package', 'base URL', 'credentials', 'protected']];
  for (const e of envs) {
    rows.push([
      e.name === def ? '*' : ' ',
      e.name,
      e.androidPackage || e.iosBundleId || '-',
      e.baseUrl || '-',
      creds.status(file, e.name),
      e.protected ? 'yes' : 'no',
    ]);
  }
  for (const line of table(rows)) u.info(line);
  const kind = creds.kind(file);
  const rel = path.relative(host, file);
  u.info('');
  u.info(`  * default environment (${def || 'none'})`);
  u.info(
    `  credentials file: ${rel} (${
      kind === 'generated' ? 'managed by qc-check' : kind === 'hand-written' ? 'hand-written, not managed by qc-check' : 'not created yet'
    })`,
  );
  u.info('  credentials: env = QC_CRED_<ENV>_* variables, file = credentials file, missing = none yet');
}

// parseArgs lets `--yes prod` swallow the next word as the flag's value.
// Boolean flags hand that word back to the positionals.
function boolFlag(args, name) {
  const v = args[name];
  if (typeof v === 'string') {
    args._.push(v);
    args[name] = true;
    return true;
  }
  return Boolean(v);
}

function readCfg(host) {
  return u.readConfig(host, { required: true });
}

function ensure(obj, key) {
  if (!obj[key] || typeof obj[key] !== 'object' || Array.isArray(obj[key])) obj[key] = {};
  return obj[key];
}

function requireKnown(cfg, name) {
  if (!name) u.fail('name an environment, e.g. `qc-check env use staging`.');
  const names = environmentsOf(cfg).map((e) => e.name);
  if (!names.includes(name)) {
    u.fail(`unknown environment "${name}". Known: ${names.join(', ') || 'none'}. Add it with \`qc-check env add ${name}\`.`);
  }
}

const PROTECTED_WHY =
  'QC writes data (accounts, orders, uploads); pointing it at production is rarely intended.';

// Ask for (or read from the environment) one environment's account, without
// writing it. Returns { action: 'set', username, password } with either field
// possibly undefined (meaning keep the stored one), or { action: 'kept' } or
// { action: 'skipped' }. Nothing it prints contains a value.
async function askCredentials(file, env, { interactive, protectedEnv, ask = true } = {}) {
  if (!interactive) {
    const fromEnv = creds.fromEnvVars(env);
    return fromEnv ? { action: 'set', source: 'env', ...fromEnv } : { action: 'skipped' };
  }

  const have = creds.has(file, env);
  const none = { action: have.block ? 'kept' : 'skipped' };
  if (ask) {
    if (protectedEnv) u.info(`    ${env} is protected: ${PROTECTED_WHY}`);
    const want = await u.confirm(
      `${have.block ? 'Change' : 'Add'} QC credentials for ${env}?`,
      protectedEnv ? false : !have.password,
    );
    if (!want) return none;
  }

  // The current username is not shown as a default: it is half of the
  // account and never goes to the terminal.
  const username = have.username
    ? await u.askWithDefault('  Username (Enter keeps the current one)', '')
    : await u.askWithDefault('  Username', '');
  const password = await u.askSecret(
    have.password ? '    Password (hidden, Enter keeps the current one): ' : '    Password (hidden): ',
  );
  if (!username && !have.username) {
    u.warn(`no username entered, credentials for ${env} not saved`);
    return none;
  }
  if (!password && !have.password) {
    u.warn(`no password entered, credentials for ${env} not saved`);
    return none;
  }
  if (!username && !password) return { action: 'kept' };
  return { action: 'set', source: 'prompt', username: username || undefined, password: password || undefined };
}

// askCredentials, then write. Returns the action taken.
async function promptCredentials(file, env, opts = {}) {
  const r = await askCredentials(file, env, opts);
  if (r.action === 'set') {
    creds.setEnv(file, env, r);
    const names = creds.envVarNames(env);
    u.info(
      r.source === 'env'
        ? `  saved    credentials for ${env} from ${names.user} / ${names.pass}`
        : `    saved credentials for ${env} to ${path.basename(file)} (mode 0600)`,
    );
    return 'saved';
  }
  return r.action;
}

// ---------------------------------------------------------------- commands

function cmdList(host) {
  const cfg = readCfg(host);
  u.heading('Environments');
  printEnvTable(host, cfg);
}

async function cmdAdd(host, name, args, interactive) {
  if (!name) u.fail('usage: qc-check env add <name>');
  if (!NAME_RE.test(name)) u.fail(`"${name}" is not a valid environment name (letters, digits, - and _).`);
  const cfg = readCfg(host);
  if (environmentsOf(cfg).some((e) => e.name === name)) {
    u.fail(`environment "${name}" already exists. Use \`qc-check env credentials ${name}\` or edit ${u.CONFIG_FILE}.`);
  }
  const protectedEnv = isProtected(cfg, name);
  const file = u.credentialsPathOf(host, cfg);

  let androidPackage = typeof args['android-package'] === 'string' ? args['android-package'] : '';
  let iosBundleId = typeof args['ios-bundle'] === 'string' ? args['ios-bundle'] : '';
  let url = typeof args.url === 'string' ? args.url : '';

  u.heading(`Add environment ${name}`);
  if (protectedEnv) u.info(`  ${name} is protected: runs need --allow-protected. ${PROTECTED_WHY}`);
  if (interactive) {
    androidPackage = await u.askWithDefault('Android package', androidPackage);
    iosBundleId = await u.askWithDefault('iOS bundle id', iosBundleId);
    url = await u.askWithDefault('Backend base URL', url);
  }

  const app = ensure(cfg, 'app');
  ensure(app, 'flavors')[name] = { androidPackage, iosBundleId };
  const backend = ensure(cfg, 'backend');
  ensure(backend, 'baseUrls')[name] = url;
  u.writeConfig(host, cfg);
  u.info(`  wrote    ${u.CONFIG_FILE} (app.flavors.${name}, backend.baseUrls.${name})`);

  const kind = creds.kind(file);
  if (kind === 'hand-written') {
    u.info(`  kept     ${path.relative(host, file)} (hand-written, not managed by qc-check); add ${name} to it by hand`);
  } else {
    const r = await promptCredentials(file, name, { interactive, protectedEnv });
    if (r === 'skipped') {
      const n = creds.envVarNames(name);
      u.info(`  no credentials for ${name}. Add them with \`qc-check env credentials ${name}\` or export ${n.user} and ${n.pass}.`);
    }
  }
  u.info('');
  printEnvTable(host, cfg);
}

function cmdUse(host, name) {
  const cfg = readCfg(host);
  requireKnown(cfg, name);
  const backend = ensure(cfg, 'backend');
  const app = ensure(cfg, 'app');
  backend.defaultEnv = name;
  // A default flavor that does not exist breaks every device run, so the
  // flavor only follows when there is a build of that name.
  if ((app.flavors || {})[name]) app.defaultFlavor = name;
  else u.warn(`no app flavor named "${name}"; app.defaultFlavor stays "${app.defaultFlavor}"`);
  u.writeConfig(host, cfg);
  u.info(`default environment is now ${name} (backend.defaultEnv${app.defaultFlavor === name ? ', app.defaultFlavor' : ''})`);
  if (isProtected(cfg, name)) u.warn(`${name} is protected: runs against it still need --allow-protected. ${PROTECTED_WHY}`);
}

async function cmdCredentials(host, name, args, interactive) {
  const cfg = readCfg(host);
  requireKnown(cfg, name);
  const file = u.credentialsPathOf(host, cfg);
  const rel = path.relative(host, file);
  const names = creds.envVarNames(name);

  if (creds.kind(file) === 'hand-written') {
    u.fail(new creds.HandWrittenError(rel).message.replace('<env>', name));
  }

  if (boolFlag(args, 'remove')) {
    const removed = creds.removeEnv(file, name);
    u.info(removed ? `removed credentials for ${name} from ${rel}` : `no credentials for ${name} in ${rel}, nothing to remove`);
    if (creds.fromEnvVars(name)) u.info(`note: ${names.user} / ${names.pass} are still set in this shell and win over the file`);
    return;
  }

  if (!interactive) {
    if (!creds.fromEnvVars(name)) {
      u.fail(
        `not interactive and no credentials in the environment for "${name}".\n` +
          `  Export ${names.user} and ${names.pass}, then re-run, or run this in a terminal.`,
      );
    }
    await promptCredentials(file, name, { interactive: false });
    return;
  }

  if (isProtected(cfg, name)) u.info(`  ${name} is protected: ${PROTECTED_WHY}`);
  const r = await promptCredentials(file, name, { interactive: true, ask: false });
  if (r !== 'saved') u.info(`  credentials for ${name} unchanged`);
}

async function cmdRemove(host, name, args, interactive) {
  const yes = boolFlag(args, 'yes');
  const cfg = readCfg(host);
  requireKnown(cfg, name);
  const app = ensure(cfg, 'app');
  const backend = ensure(cfg, 'backend');
  const isDefault = app.defaultFlavor === name || backend.defaultEnv === name;
  const newDefault = typeof args.default === 'string' ? args.default : '';

  if (isDefault) {
    if (!yes || !newDefault) {
      u.fail(
        `"${name}" is the current default. Pick another first:\n` +
          `  qc-check env remove ${name} --yes --default <other>`,
      );
    }
    if (newDefault === name) u.fail('the new default must be a different environment');
    requireKnown(cfg, newDefault);
  }

  if (!yes) {
    if (!interactive) u.fail(`not interactive: re-run with --yes to remove "${name}"`);
    const ok = await u.confirm(`Remove environment ${name} (flavor, base URL and its credentials)?`, false);
    if (!ok) {
      u.info('  nothing changed.');
      return;
    }
  }

  if (app.flavors) delete app.flavors[name];
  if (backend.baseUrls) delete backend.baseUrls[name];
  if (Array.isArray(backend.protectedEnvs)) backend.protectedEnvs = backend.protectedEnvs.filter((n) => n !== name);
  if (isDefault) {
    backend.defaultEnv = newDefault;
    if ((app.flavors || {})[newDefault]) app.defaultFlavor = newDefault;
  }
  u.writeConfig(host, cfg);
  u.info(`removed  ${name} from ${u.CONFIG_FILE}${isDefault ? `; default is now ${newDefault}` : ''}`);

  const file = u.credentialsPathOf(host, cfg);
  const rel = path.relative(host, file);
  const kind = creds.kind(file);
  if (kind === 'generated') {
    if (creds.removeEnv(file, name)) u.info(`removed  credentials for ${name} from ${rel}`);
  } else if (kind === 'hand-written') {
    u.info(`kept     ${rel} (hand-written, not managed by qc-check); remove "${name}" from it by hand`);
  }
}

// -------------------------------------------------------------------- main

function help() {
  u.info(`qc-check env - the environments this repo is QC'd against, and their QC accounts.

Usage
  qc-check env [list]                       show every environment
  qc-check env add <name>                   add one (asks for package, bundle id, URL, account)
  qc-check env use <name>                   make it the default
  qc-check env credentials <name>           set or replace its QC account (hidden password)
  qc-check env credentials <name> --remove  delete its QC account
  qc-check env remove <name>                remove it, with its URL and account

Options
  --dir <path>              act on this repository instead of the current one
  --android-package <id>    env add, non-interactive
  --ios-bundle <id>         env add, non-interactive
  --url <base url>          env add, non-interactive
  --yes                     env remove: skip the confirmation
  --default <name>          env remove: the new default when removing the current one

Credentials
  Stored in the generated credentials file (mode 0600, gitignored), or taken
  from QC_CRED_<ENV>_USERNAME and QC_CRED_<ENV>_PASSWORD, which win. Without a
  terminal the commands read only those variables. A hand-written credentials
  file is never modified. Values are never printed.

Examples
  qc-check env
  qc-check env add staging --android-package com.example.app.staging --url https://api.staging.example.com
  QC_CRED_STAGING_USERNAME=... QC_CRED_STAGING_PASSWORD=... qc-check env credentials staging
  qc-check env use staging`);
}

async function run(args = {}) {
  const host = u.findHost(args);
  if (!fs.existsSync(host)) u.fail(`no such directory: ${host}`);
  const yes = boolFlag(args, 'yes');
  boolFlag(args, 'remove');
  args.yes = yes;
  const interactive = u.isInteractive() && !yes;
  const [sub = 'list', name] = args._;

  try {
    switch (sub) {
      case 'list':
      case 'ls':
        return cmdList(host);
      case 'add':
        return await cmdAdd(host, name, args, interactive);
      case 'use':
        return cmdUse(host, name);
      case 'credentials':
      case 'creds':
        return await cmdCredentials(host, name, args, interactive);
      case 'remove':
      case 'rm':
        return await cmdRemove(host, name, args, interactive);
      default:
        return u.fail(`unknown env command "${sub}". Run \`qc-check env --help\`.`);
    }
  } catch (err) {
    // Errors from credentials-file.js name paths only, never values.
    return u.fail(err && err.message ? err.message : String(err));
  }
}

module.exports = {
  run,
  help,
  printEnvTable,
  environmentsOf,
  isProtected,
  askCredentials,
  promptCredentials,
  PROTECTED_WHY,
  NAME_RE,
};
