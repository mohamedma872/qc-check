#!/usr/bin/env node
'use strict';

// Shared configuration loader for the QC runtime scripts.
//
// Every project-specific fact lives in `qc.config.json` at the host repo root.
// The scripts hold no app names, package ids, device names or URLs: they ask
// this module. Defaults below exist so a partial config still loads; anything
// that cannot be defaulted (an app package, a flavor) raises an error that
// names the exact config key to fix.

const fs = require('fs');
const path = require('path');
const util = require('util');

const CONFIG_FILE = 'qc.config.json';
const EXAMPLE_FILE = 'qc.config.example.json';

// Built-in defaults. Keys mirror qc.config.json exactly. Empty strings mean
// "not configured": callers either omit the value or fail with a pointer to it.
const DEFAULTS = {
  project: {
    name: 'App',
    reportsDir: 'qc-reports',
    locales: ['en'],
    rtlLocales: [],
  },
  tracker: {
    kind: 'none',
    ticketPattern: '[A-Z]+-[0-9]+',
    site: '',
    projectKey: '',
    tools: { getIssue: '', addComment: '', addLabels: '', uploadAttachment: '' },
    passLabel: 'QC-Agent-Pass',
    blockedLabel: 'BE-Blocking',
  },
  repo: {
    defaultBranch: 'main',
    prCommand: '',
  },
  app: {
    defaultFlavor: 'staging',
    androidActivity: '',
    // On-screen marker that tells the tester which environment the running
    // build points at; empty when the app shows none.
    envBanner: '',
    build: { android: '', ios: '' },
    // Left empty on purpose: a phantom default flavor would silently drive the
    // wrong build. An unknown flavor must fail loudly instead.
    flavors: {},
  },
  devices: {
    // `caps` is a free-form Appium capability block merged last in capsFor(),
    // so an unusual device can be accommodated without a schema change.
    android: { enabled: true, avd: '', udid: '', deviceName: 'Android Phone', caps: {} },
    android_tablet: { enabled: false, avd: '', udid: '', deviceName: 'Android Tablet', caps: {} },
    ios: { enabled: false, deviceName: '', udid: '', caps: {} },
    appium: { host: '127.0.0.1', port: 4723, newCommandTimeout: 900 },
  },
  backend: {
    enabled: false,
    defaultEnv: 'staging',
    baseUrls: {},
    healthPath: '/health',
    auth: {
      path: '',
      method: 'POST',
      usernameField: 'username',
      passwordField: 'password',
      tokenPath: '',
      extraBody: {},
    },
    headers: {},
    smokePath: '',
  },
  codeMap: {
    sourceDir: 'src',
    navigationGlob: '',
    translationsDir: '',
    apiServicesGlob: '',
    mutationsGlob: '',
    queriesGlob: '',
    utilsGlob: '',
    validationGlob: '',
    testCommand: '',
    lintCommand: '',
    typecheckCommand: '',
    testsGitignored: false,
  },
  budget: { currency: 'USD', runCap: 30 },
  credentialsFile: 'qc.credentials.js',
};

// Device profiles are the keys of `devices` minus the Appium server block.
const APPIUM_KEY = 'appium';

let cachedConfig = null;
let cachedConfigPath = null;

// --- helpers -----------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Arrays replace wholesale: a host that lists two locales means two, not two
// plus the default one.
function deepMerge(base, override) {
  if (!isPlainObject(override)) {return override === undefined ? base : override;}
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(override)) {
    const next = override[key];
    if (isPlainObject(next) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], next);
    } else if (next !== undefined) {
      out[key] = Array.isArray(next) ? next.slice() : next;
    }
  }
  return out;
}

function findConfigFile(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(candidate)) {return candidate;}
    const parent = path.dirname(dir);
    if (parent === dir) {return null;}
    dir = parent;
  }
}

function die(lines) {
  for (const line of lines) {console.error(line);}
  process.exit(1);
}

// --- public API --------------------------------------------------------------

// Nearest ancestor of cwd that holds qc.config.json; cwd when there is none.
function findRepoRoot() {
  const file = findConfigFile(process.cwd());
  return file ? path.dirname(file) : path.resolve(process.cwd());
}

// Deep-merged config (defaults <- qc.config.json), cached per config file.
// Exits with an actionable message when the host repo has no config.
function loadConfig() {
  const file = findConfigFile(process.cwd());
  if (!file) {
    die([
      `QC config not found: no ${CONFIG_FILE} in ${process.cwd()} or any parent directory.`,
      '',
      'Fix it with one of:',
      '  npx qc-check init            create qc.config.json in this repo',
      `  cp ${EXAMPLE_FILE} ${CONFIG_FILE}   start from the shipped example`,
      '',
      'Run the QC scripts from inside the repo that holds the config.',
    ]);
  }
  if (cachedConfig && cachedConfigPath === file) {return cachedConfig;}

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    die([`Cannot read ${file}: ${err.message}`]);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die([
      `${file} is not valid JSON: ${err.message}`,
      `Compare it against ${EXAMPLE_FILE}.`,
    ]);
  }
  if (!isPlainObject(parsed)) {
    die([`${file} must contain a JSON object.`]);
  }

  const merged = deepMerge(DEFAULTS, parsed);
  // Environment overrides are applied once, here, so every caller sees them
  // without repeating the lookup.
  if (process.env.QC_ENV) {merged.backend.defaultEnv = process.env.QC_ENV;}
  if (process.env.QC_FLAVOR) {merged.app.defaultFlavor = process.env.QC_FLAVOR;}

  Object.defineProperty(merged, 'configPath', {
    value: file,
    enumerable: false,
  });
  Object.defineProperty(merged, 'repoRoot', {
    value: path.dirname(file),
    enumerable: false,
  });

  cachedConfig = merged;
  cachedConfigPath = file;
  return merged;
}

// Absolute path of the evidence directory, created if missing.
function reportsDir() {
  const cfg = loadConfig();
  const dir = path.resolve(cfg.repoRoot, cfg.project.reportsDir || 'qc-reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function deviceProfiles() {
  const cfg = loadConfig();
  return Object.keys(cfg.devices).filter(k => k !== APPIUM_KEY);
}

// Escape hatch: devices.<profile>.caps is merged last, so a host with an
// unusual device can set or replace any capability without a schema change.
// A null value removes a capability, which is safer than sending null - no
// Appium capability accepts null as a real value.
function withOverrides(caps, overrides) {
  if (!isPlainObject(overrides)) {return caps;}
  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    if (value === null) {
      delete caps[key];
    } else {
      caps[key] = value;
    }
  }
  return caps;
}

// Appium capabilities for a device profile and an app flavor.
// Empty udid/avd keys are omitted entirely: Appium treats an empty string as a
// real (and unmatchable) device id.
function capsFor(profile, flavor) {
  const cfg = loadConfig();
  const known = deviceProfiles();
  if (!profile || profile === APPIUM_KEY || !cfg.devices[profile]) {
    throw new Error(
      `Unknown device profile "${profile}". Known profiles: ${known.join(', ')} ` +
        `(devices.* in ${CONFIG_FILE}).`,
    );
  }
  const device = cfg.devices[profile];
  if (!device.enabled) {
    throw new Error(
      `Device profile "${profile}" is disabled. Set devices.${profile}.enabled to true ` +
        `in ${CONFIG_FILE} to QC on it.`,
    );
  }

  const flavorName = flavor || cfg.app.defaultFlavor;
  const flavorCfg = cfg.app.flavors[flavorName];
  if (!flavorCfg) {
    const available = Object.keys(cfg.app.flavors).join(', ') || 'none defined';
    throw new Error(
      `Unknown app flavor "${flavorName}". Add app.flavors.${flavorName} to ${CONFIG_FILE} ` +
        `(defined flavors: ${available}).`,
    );
  }

  const appium = cfg.devices[APPIUM_KEY] || {};
  const timeout = appium.newCommandTimeout || DEFAULTS.devices.appium.newCommandTimeout;
  const isIOS = profile === 'ios';

  if (isIOS) {
    if (!flavorCfg.iosBundleId) {
      throw new Error(
        `app.flavors.${flavorName}.iosBundleId is missing in ${CONFIG_FILE} ` +
          '(required to drive an iOS simulator).',
      );
    }
    const caps = {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:bundleId': flavorCfg.iosBundleId,
      'appium:noReset': true,
      'appium:fullReset': false,
      // QC interleaves device commands with code inspection; a short idle
      // timeout kills the session mid-pass and loses the recording.
      'appium:newCommandTimeout': timeout,
      'appium:waitForQuiescence': false,
    };
    if (device.deviceName) {caps['appium:deviceName'] = device.deviceName;}
    if (device.udid) {caps['appium:udid'] = device.udid;}
    return withOverrides(caps, device.caps);
  }

  if (!flavorCfg.androidPackage) {
    throw new Error(
      `app.flavors.${flavorName}.androidPackage is missing in ${CONFIG_FILE} ` +
        '(required to drive an Android device).',
    );
  }
  const caps = {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:appPackage': flavorCfg.androidPackage,
    'appium:noReset': true,
    'appium:fullReset': false,
    'appium:autoGrantPermissions': true,
    'appium:newCommandTimeout': timeout,
  };
  // Per-flavor activity wins; with neither set Appium launches the package's
  // own launcher activity, which is right for most apps.
  const activity = flavorCfg.androidActivity || cfg.app.androidActivity;
  if (activity) {caps['appium:appActivity'] = activity;}
  if (device.deviceName) {caps['appium:deviceName'] = device.deviceName;}
  // `appium:avd` boots the emulator when it is not already running.
  if (device.avd) {caps['appium:avd'] = device.avd;}
  if (device.udid) {caps['appium:udid'] = device.udid;}
  return withOverrides(caps, device.caps);
}

// True when `id` matches tracker.ticketPattern end to end.
function validateTicket(id) {
  if (typeof id !== 'string' || !id.trim()) {return false;}
  const cfg = loadConfig();
  const pattern = cfg.tracker.ticketPattern || DEFAULTS.tracker.ticketPattern;
  let re;
  try {
    re = new RegExp(`^(?:${pattern})$`);
  } catch (err) {
    throw new Error(
      `tracker.ticketPattern in ${CONFIG_FILE} is not a valid regular expression: ${err.message}`,
    );
  }
  return re.test(id.trim());
}

// Spend ceiling for one run, in budget.currency. QC_BUDGET wins.
function budgetCap() {
  const cfg = loadConfig();
  const raw = process.env.QC_BUDGET !== undefined && process.env.QC_BUDGET !== ''
    ? process.env.QC_BUDGET
    : cfg.budget.runCap;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid run budget "${raw}". Set a positive number in budget.runCap ` +
        `(${CONFIG_FILE}) or in the QC_BUDGET environment variable.`,
    );
  }
  return value;
}

// Credential values must never reach stdout, stderr, a file or a report, so
// the returned object stringifies and inspects as a redaction marker. Property
// access still works for the code that needs the values.
function redactInPlace(obj, seen) {
  if (!isPlainObject(obj) && !Array.isArray(obj)) {return obj;}
  const visited = seen || new Set();
  if (visited.has(obj)) {return obj;}
  visited.add(obj);
  for (const key of Object.keys(obj)) {redactInPlace(obj[key], visited);}
  const marker = () => '[credentials redacted]';
  try {
    Object.defineProperty(obj, 'toJSON', { value: marker, enumerable: false, configurable: true });
    Object.defineProperty(obj, util.inspect.custom, {
      value: marker,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen credentials object cannot carry the guard; callers stay
    // responsible for not printing it.
  }
  return obj;
}

function credentialsPath() {
  const cfg = loadConfig();
  const file = cfg.credentialsFile || DEFAULTS.credentialsFile;
  return path.resolve(cfg.repoRoot, file);
}

function loadCredentials() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `Credentials file not found: ${file}\n` +
        `  The path comes from "credentialsFile" in ${CONFIG_FILE}. Create it with either:\n` +
        '    npx qc-check init                                  (copies the template for you)\n' +
        `    cp runtime/credentials.example.js ${file}\n` +
        '  Then fill in the QC test account and keep the file out of version control.',
    );
  }
  let creds;
  try {
    // eslint-disable-next-line global-require
    creds = require(file);
  } catch (err) {
    // The message may quote the offending source line, so report the path only.
    throw new Error(`Credentials file ${file} could not be loaded (syntax or export error).`);
  }
  if (!isPlainObject(creds)) {
    throw new Error(`Credentials file ${file} must export an object.`);
  }
  return redactInPlace(creds);
}

module.exports = {
  loadConfig,
  findRepoRoot,
  reportsDir,
  capsFor,
  validateTicket,
  budgetCap,
  loadCredentials,
  // Extras used by the sibling runtime scripts.
  deviceProfiles,
  credentialsPath,
  CONFIG_FILE,
};

// --- CLI ---------------------------------------------------------------------
// Handy for shell scripts and for checking what a repo resolves to. It never
// prints credential values.

function printHelp() {
  console.log(`
QC config loader

Usage: node config.js [option]

Options:
  --json           print the resolved configuration as JSON
  --repo-root      print the host repo root (nearest parent with ${CONFIG_FILE})
  --reports-dir    print the absolute evidence directory, creating it if missing
  --appium-host    print the Appium host
  --appium-port    print the Appium port
  --caps <profile> [--flavor <name>]   print the Appium capabilities for a profile
  --help           show this help

Environment:
  QC_ENV       overrides backend.defaultEnv
  QC_FLAVOR    overrides app.defaultFlavor
  QC_BUDGET    overrides budget.runCap
  QC_EVAL      marks a headless eval run

With no option it prints a summary. Credential values are never printed.
`);
}

function runCli(argv) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    printHelp();
    return 0;
  }
  const cfg = loadConfig();
  const flag = argv[0];

  if (flag === '--json') {
    console.log(JSON.stringify(cfg, null, 2));
    return 0;
  }
  if (flag === '--repo-root') {
    console.log(cfg.repoRoot);
    return 0;
  }
  if (flag === '--reports-dir') {
    console.log(reportsDir());
    return 0;
  }
  if (flag === '--appium-host') {
    console.log(cfg.devices.appium.host || DEFAULTS.devices.appium.host);
    return 0;
  }
  if (flag === '--appium-port') {
    console.log(String(cfg.devices.appium.port || DEFAULTS.devices.appium.port));
    return 0;
  }
  if (flag === '--caps') {
    const profile = argv[1];
    const flavorIdx = argv.indexOf('--flavor');
    const flavor = flavorIdx >= 0 ? argv[flavorIdx + 1] : undefined;
    console.log(JSON.stringify(capsFor(profile, flavor), null, 2));
    return 0;
  }
  if (flag) {
    console.error(`Unknown option: ${flag}`);
    printHelp();
    return 1;
  }

  const enabled = deviceProfiles().filter(p => cfg.devices[p].enabled);
  console.log(`config:      ${cfg.configPath}`);
  console.log(`repo root:   ${cfg.repoRoot}`);
  console.log(`reports dir: ${reportsDir()}`);
  console.log(`project:     ${cfg.project.name}`);
  console.log(`locales:     ${cfg.project.locales.join(', ') || 'none'}`);
  console.log(`flavors:     ${Object.keys(cfg.app.flavors).join(', ') || 'none'} (default: ${cfg.app.defaultFlavor})`);
  console.log(`devices:     ${enabled.join(', ') || 'none enabled'}`);
  console.log(`appium:      ${cfg.devices.appium.host}:${cfg.devices.appium.port}`);
  console.log(`backend:     ${cfg.backend.enabled ? cfg.backend.defaultEnv : 'disabled'}`);
  console.log(`budget cap:  ${budgetCap()} ${cfg.budget.currency}`);
  console.log(`credentials: ${credentialsPath()} (${fs.existsSync(credentialsPath()) ? 'present' : 'missing'})`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(runCli(process.argv.slice(2)));
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(1);
  }
}
