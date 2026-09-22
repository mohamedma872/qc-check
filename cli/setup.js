'use strict';

// `qc-check setup`: detect the host app, ask only about what cannot be
// detected, and write qc.config.json plus the runtime the agent drives.
//
// Detection is best effort by design. A wrong guess is worse than a blank,
// so anything uncertain is left empty and listed as a TODO at the end.

const fs = require('fs');
const path = require('path');

const u = require('./util');
const credFile = require('./credentials-file');

// Locales that render right to left, used to seed project.rtlLocales.
const RTL_LOCALES = ['ar', 'he', 'fa', 'ur'];

// Schema defaults, with every project-specific value blank. Detection and
// answers are merged over this, so an undetected key stays honestly empty.
function baseConfig() {
  return {
    project: { name: '', reportsDir: 'qc-reports', locales: ['en'], rtlLocales: [] },
    tracker: {
      kind: 'none',
      ticketPattern: '[A-Z]+-[0-9]+',
      site: '',
      projectKey: '',
      tools: { getIssue: '', addComment: '', addLabels: '', uploadAttachment: '' },
      passLabel: 'QC-Agent-Pass',
      blockedLabel: 'BE-Blocking',
    },
    agent: { kind: 'none', command: '', extraArgs: [], headless: false, timeoutMinutes: 180 },
    repo: { defaultBranch: 'main', prCommand: '' },
    app: {
      defaultFlavor: 'staging',
      androidActivity: '',
      envBanner: '',
      build: { android: '', ios: '' },
      flavors: {},
    },
    devices: {
      android: { enabled: true, avd: '', udid: '', deviceName: 'Android Phone' },
      android_tablet: { enabled: false, avd: '', udid: '', deviceName: 'Android Tablet' },
      ios: { enabled: false, deviceName: '', udid: '' },
      appium: { host: '127.0.0.1', port: 4723, newCommandTimeout: 900 },
    },
    backend: {
      enabled: true,
      defaultEnv: 'staging',
      baseUrls: {},
      healthPath: '',
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
      sourceDir: '',
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
}

// ------------------------------------------------------------------ helpers

function isPlain(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function exists(host, rel) {
  return fs.existsSync(path.join(host, rel));
}

function isDir(host, rel) {
  try {
    return fs.statSync(path.join(host, rel)).isDirectory();
  } catch (_) {
    return false;
  }
}

function readText(host, rel) {
  try {
    return fs.readFileSync(path.join(host, rel), 'utf8');
  } catch (_) {
    return '';
  }
}

function readJson(host, rel) {
  const raw = readText(host, rel);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function firstExisting(host, candidates) {
  return candidates.find((c) => exists(host, c)) || '';
}

function firstDir(host, candidates) {
  return candidates.find((c) => isDir(host, c)) || '';
}

// Body of the {...} that starts at openIdx, and the index of its closer.
function balanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

// Reorder keys to match a template object, so re-running setup produces a
// diff of values only, never of key order.
function orderLike(template, obj) {
  if (!isPlain(template) || !isPlain(obj)) return obj;
  const out = {};
  for (const k of Object.keys(template)) if (k in obj) out[k] = orderLike(template[k], obj[k]);
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

function orderTemplate() {
  const p = path.join(u.PKG_ROOT, 'qc.config.example.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return baseConfig();
  }
}

// ---------------------------------------------------------------- detection

function detectStack(host) {
  const hasPkg = exists(host, 'package.json');
  const hasAndroid = isDir(host, 'android');
  const hasIos = isDir(host, 'ios');

  if (exists(host, 'pubspec.yaml')) return { kind: 'flutter', hasAndroid, hasIos };

  if (hasPkg) {
    const pkg = readJson(host, 'package.json') || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps['react-native'] || deps.expo || hasAndroid || hasIos) {
      return { kind: 'react-native', hasAndroid, hasIos };
    }
  }

  if (exists(host, 'settings.gradle') || exists(host, 'settings.gradle.kts')) {
    return { kind: 'android', hasAndroid: true, hasIos: false };
  }

  const xcode = findXcodeProjects(host);
  if (xcode.length) return { kind: 'ios', hasAndroid: false, hasIos: true };

  return { kind: 'unknown', hasAndroid, hasIos };
}

function findXcodeProjects(host) {
  const out = [];
  for (const dir of ['.', 'ios', 'macos']) {
    const abs = path.join(host, dir);
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.endsWith('.xcodeproj')) {
        const pbx = path.join(abs, e.name, 'project.pbxproj');
        if (fs.existsSync(pbx)) out.push(pbx);
      }
    }
  }
  return out;
}

// Flavor blocks inside a productFlavors { ... } body, Groovy or Kotlin DSL.
function parseFlavorBlocks(body) {
  const out = {};
  const re = /(?:create\s*\(\s*["']([A-Za-z0-9_]+)["']\s*\)|([A-Za-z_][A-Za-z0-9_]*))\s*\{/g;
  let from = 0;
  for (;;) {
    re.lastIndex = from;
    const m = re.exec(body);
    if (!m) break;
    const name = m[1] || m[2];
    const openIdx = m.index + m[0].length - 1;
    const blk = balanced(body, openIdx);
    if (!blk) break;
    const suffix = (blk.body.match(/applicationIdSuffix\s*=?\s*["']([^"']+)["']/) || [])[1] || '';
    const appId = (blk.body.match(/\bapplicationId\s*=?\s*["']([^"']+)["']/) || [])[1] || '';
    out[name] = { suffix, applicationId: appId };
    from = blk.end + 1;
  }
  return out;
}

function detectAndroid(host) {
  const gradleRel = firstExisting(host, [
    'android/app/build.gradle',
    'android/app/build.gradle.kts',
    'app/build.gradle',
    'app/build.gradle.kts',
  ]);
  const out = { gradleFile: gradleRel, applicationId: '', flavors: {}, activity: '' };

  if (gradleRel) {
    let text = readText(host, gradleRel);
    const fm = text.match(/\bproductFlavors\s*\{/);
    if (fm) {
      const blk = balanced(text, fm.index + fm[0].length - 1);
      if (blk) {
        out.flavors = parseFlavorBlocks(blk.body);
        // The base applicationId lives outside the flavor overrides.
        text = text.slice(0, fm.index) + text.slice(blk.end + 1);
      }
    }
    out.applicationId = (text.match(/\bapplicationId\s*=?\s*["']([^"']+)["']/) || [])[1] || '';
  }

  const manifestRel = firstExisting(host, [
    'android/app/src/main/AndroidManifest.xml',
    'app/src/main/AndroidManifest.xml',
  ]);
  if (manifestRel) {
    const xml = readText(host, manifestRel);
    const manifestPkg = (xml.match(/<manifest[^>]*\bpackage\s*=\s*"([^"]+)"/) || [])[1] || '';
    // Self-closing activities, and full ones whose body holds the filters.
    const blocks = xml.match(/<activity\b[^>]*\/>|<activity\b[\s\S]*?<\/activity>/g) || [];
    const launcher = blocks.find((b) => b.includes('android.intent.category.LAUNCHER'));
    if (launcher) {
      const name = (launcher.match(/android:name\s*=\s*"([^"]+)"/) || [])[1] || '';
      const base = out.applicationId || manifestPkg;
      if (name.startsWith('.')) out.activity = base ? base + name : name;
      else if (!name.includes('.')) out.activity = base ? `${base}.${name}` : name;
      else out.activity = name;
    }
  }

  return out;
}

function detectIosBundleIds(host) {
  const ids = new Set();
  for (const pbx of findXcodeProjects(host)) {
    let text = '';
    try {
      text = fs.readFileSync(pbx, 'utf8');
    } catch (_) {
      continue;
    }
    const re = /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";\n]+)"?\s*;/g;
    let m = re.exec(text);
    while (m) {
      const id = m[1].trim().replace(/^"|"$/g, '');
      // Build-setting references and test targets are not the app.
      if (id && !id.includes('$(') && !/(UI)?Tests?$/i.test(id)) ids.add(id);
      m = re.exec(text);
    }
  }
  return [...ids];
}

function detectPackageManager(host) {
  if (exists(host, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(host, 'yarn.lock')) return 'yarn';
  if (exists(host, 'package-lock.json')) return 'npm';
  return 'npm';
}

function scriptCommand(pm, script) {
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
}

// Pick the script whose name best matches the flavor, e.g. android:staging.
function pickScript(scripts, prefixRe, flavor) {
  const names = Object.keys(scripts).filter((n) => prefixRe.test(n));
  if (names.length === 0) return '';
  const f = String(flavor || '').toLowerCase();
  if (f) {
    const hit = names.find((n) => n.toLowerCase().includes(f));
    if (hit) return hit;
  }
  const exact = names.find((n) => /^(android|ios)$/.test(n));
  return exact || names[0];
}

function detectCommands(host, stack, flavor) {
  const out = { android: '', ios: '', test: '', lint: '', typecheck: '' };

  if (stack.kind === 'flutter') {
    out.test = 'flutter test';
    out.lint = 'flutter analyze';
    return out;
  }

  const pkg = readJson(host, 'package.json');
  if (!pkg) return out;
  const scripts = pkg.scripts || {};
  const pm = detectPackageManager(host);

  const a = pickScript(scripts, /^android/i, flavor);
  const i = pickScript(scripts, /^ios/i, flavor);
  if (a) out.android = scriptCommand(pm, a);
  if (i) out.ios = scriptCommand(pm, i);

  // QC appends a file pattern to the test command, so when the test script is
  // a thin wrapper around a runner, name the runner: `npm test -- pattern` is
  // a trap, `npx jest pattern` is not.
  const runner = (String(scripts.test || '').match(/\b(jest|vitest)\b/) || [])[1];
  if (runner) out.test = pm === 'npm' ? `npx ${runner}` : `${pm} ${runner}`;
  else if (scripts.test) out.test = scriptCommand(pm, 'test');
  if (scripts.lint) out.lint = scriptCommand(pm, 'lint');

  const tc = ['typecheck', 'type-check', 'tsc'].find((n) => scripts[n]);
  if (tc) out.typecheck = scriptCommand(pm, tc);
  else if (exists(host, 'tsconfig.json')) out.typecheck = 'npx tsc --noEmit --skipLibCheck';

  return out;
}

function detectCodeMap(host, stack) {
  const sourceDir = firstDir(host, stack.kind === 'flutter' ? ['lib', 'src'] : ['src', 'app', 'lib']);
  const map = {
    sourceDir,
    navigationGlob: '',
    translationsDir: '',
    apiServicesGlob: '',
    mutationsGlob: '',
    queriesGlob: '',
    utilsGlob: '',
    validationGlob: '',
  };
  const s = sourceDir;
  const under = (names) => (s ? names.map((n) => `${s}/${n}`) : names);

  const nav = firstDir(host, under(['navigation', 'navigators', 'routes', 'router']));
  if (nav) map.navigationGlob = `${nav}/*.tsx`;

  map.translationsDir = firstDir(
    host,
    [...under(['translations', 'locales', 'i18n', 'lang', 'l10n']), 'assets/translations', 'assets/i18n'],
  );

  const api = firstDir(host, under(['api/services', 'services/api', 'api', 'services']));
  if (api) map.apiServicesGlob = `${api}/**`;

  const mutations = firstDir(host, under(['hooks/mutations', 'mutations']));
  if (mutations) map.mutationsGlob = `${mutations}/**`;

  const queries = firstDir(host, under(['hooks/queries', 'queries']));
  if (queries) map.queriesGlob = `${queries}/**`;

  const utils = firstDir(host, under(['utils', 'util', 'helpers']));
  if (utils) map.utilsGlob = `${utils}/**`;

  const validation = firstDir(host, under(['validation', 'validations', 'schemas', 'validators']));
  if (validation) map.validationGlob = `${validation}/**`;

  return map;
}

function detectLocales(host, translationsDir) {
  if (!translationsDir || !isDir(host, translationsDir)) return { locales: [], rtlLocales: [] };
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(host, translationsDir), { withFileTypes: true });
  } catch (_) {
    return { locales: [], rtlLocales: [] };
  }
  const codes = new Set();
  for (const e of entries) {
    const name = e.isDirectory() ? e.name : e.name.replace(/\.(json|arb|ya?ml|js|ts)$/i, '');
    if (/^[a-z]{2}([-_][A-Za-z0-9]{2,4})?$/.test(name)) codes.add(name);
  }
  const locales = [...codes].sort();
  return { locales, rtlLocales: locales.filter((l) => RTL_LOCALES.includes(l.slice(0, 2))) };
}

function detectTestsGitignored(host, sourceDir) {
  const candidates = [
    sourceDir ? `${sourceDir}/__tests__` : '',
    '__tests__',
    'test',
    'tests',
  ].filter(Boolean);
  const probeDir = candidates.find((c) => isDir(host, c)) || candidates[0];
  const probe = path.join(probeDir, 'qc-probe.test.js');
  const res = u.tryExec('git', ['check-ignore', '-q', probe], { cwd: host });
  return res.status === 0;
}

function detectDefaultBranch(host) {
  const head = u.tryExec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: host });
  if (head.ok && head.stdout) return head.stdout.replace(/^origin\//, '');
  const cur = u.tryExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: host });
  if (cur.ok && cur.stdout && cur.stdout !== 'HEAD') return cur.stdout;
  return '';
}

function detectProjectName(host, stack) {
  if (stack.kind === 'flutter') {
    const name = (readText(host, 'pubspec.yaml').match(/^name:\s*(\S+)/m) || [])[1];
    if (name) return name;
  }
  const pkg = readJson(host, 'package.json');
  if (pkg && pkg.name) return String(pkg.name).replace(/^@[^/]+\//, '');
  return path.basename(host);
}

// A flavor named like a test environment is a better QC default than the
// production one, which nobody should be driving with a test account.
function preferredFlavor(names) {
  // Earliest shared environment first: QC on a feature targets the build the
  // team integrates on, not the one customers accept or the one they use.
  const wanted = ['staging', 'stage', 'sprint', 'dev', 'develop', 'development', 'qa', 'test', 'uat', 'debug'];
  for (const w of wanted) {
    const hit = names.find((n) => n.toLowerCase() === w);
    if (hit) return hit;
  }
  for (const w of wanted) {
    const hit = names.find((n) => n.toLowerCase().includes(w));
    if (hit) return hit;
  }
  return names[0] || '';
}

function buildFlavorMap(android, iosBundleIds) {
  const out = {};
  const names = Object.keys(android.flavors);
  if (names.length === 0) {
    if (!android.applicationId) return out;
    out.default = { androidPackage: android.applicationId, iosBundleId: '' };
  } else {
    for (const name of names) {
      const f = android.flavors[name];
      const pkgId = f.applicationId || (android.applicationId ? android.applicationId + f.suffix : '');
      out[name] = { androidPackage: pkgId, iosBundleId: '' };
    }
  }
  // Match an iOS bundle id to a flavor only when it is unambiguous.
  for (const name of Object.keys(out)) {
    const pkgId = out[name].androidPackage;
    if (pkgId && iosBundleIds.includes(pkgId)) out[name].iosBundleId = pkgId;
  }
  if (Object.keys(out).length === 1 && iosBundleIds.length === 1) {
    const only = Object.keys(out)[0];
    if (!out[only].iosBundleId) out[only].iosBundleId = iosBundleIds[0];
  }
  return out;
}

function detect(host) {
  const stack = detectStack(host);
  const android = detectAndroid(host);
  const iosBundleIds = detectIosBundleIds(host);
  const flavors = buildFlavorMap(android, iosBundleIds);
  const flavorNames = Object.keys(flavors);
  const defaultFlavor = preferredFlavor(flavorNames);
  const codeMap = detectCodeMap(host, stack);
  const locales = detectLocales(host, codeMap.translationsDir);
  const commands = detectCommands(host, stack, defaultFlavor);

  return {
    stack,
    android,
    iosBundleIds,
    flavors,
    defaultFlavor,
    codeMap,
    locales,
    commands,
    packageManager: exists(host, 'package.json') ? detectPackageManager(host) : '',
    projectName: detectProjectName(host, stack),
    defaultBranch: detectDefaultBranch(host),
    testsGitignored: detectTestsGitignored(host, codeMap.sourceDir),
    avds: u.listAvds(),
    simulators: u.listIosSimulators(),
    claude: Boolean(u.which('claude')),
    codex: Boolean(u.which('codex')),
  };
}

// Turn detections into a config fragment. Only non-empty values are set, so
// nothing detected means nothing overwritten.
function detectedConfig(d) {
  const cfg = { project: {}, agent: {}, repo: {}, app: { build: {} }, devices: { android: {}, ios: {} }, backend: {}, codeMap: {} };

  if (d.projectName) cfg.project.name = d.projectName;
  if (d.locales.locales.length) {
    cfg.project.locales = d.locales.locales;
    cfg.project.rtlLocales = d.locales.rtlLocales;
  }

  if (d.claude && !d.codex) cfg.agent.kind = 'claude';
  else if (d.codex && !d.claude) cfg.agent.kind = 'codex';

  if (d.defaultBranch) cfg.repo.defaultBranch = d.defaultBranch;

  if (d.defaultFlavor) cfg.app.defaultFlavor = d.defaultFlavor;
  // Name the backend environment after the flavor, since a flavor build points
  // at its matching backend. Seed a slot per flavor so the TODO names real keys.
  if (d.defaultFlavor) {
    cfg.backend.defaultEnv = d.defaultFlavor;
    const urls = {};
    for (const name of Object.keys(d.flavors).length ? Object.keys(d.flavors) : [d.defaultFlavor]) urls[name] = '';
    cfg.backend.baseUrls = urls;
  }
  if (d.android.activity) cfg.app.androidActivity = d.android.activity;
  if (Object.keys(d.flavors).length) cfg.app.flavors = d.flavors;
  if (d.commands.android) cfg.app.build.android = d.commands.android;
  if (d.commands.ios) cfg.app.build.ios = d.commands.ios;

  if (d.avds.length === 1) cfg.devices.android.avd = d.avds[0];
  if (d.simulators.length) cfg.devices.ios.deviceName = d.simulators[0].name;

  for (const k of Object.keys(d.codeMap)) if (d.codeMap[k]) cfg.codeMap[k] = d.codeMap[k];
  if (d.commands.test) cfg.codeMap.testCommand = d.commands.test;
  if (d.commands.lint) cfg.codeMap.lintCommand = d.commands.lint;
  if (d.commands.typecheck) cfg.codeMap.typecheckCommand = d.commands.typecheck;
  cfg.codeMap.testsGitignored = d.testsGitignored;

  return cfg;
}

// ------------------------------------------------------------------ reports

function pad(label, width) {
  return `${label}:`.padEnd(width + 2);
}

function printPairs(pairs) {
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) u.info(`  ${pad(k, width)} ${v}`);
}

function describeDetections(d) {
  const pairs = [
    ['stack', d.stack.kind === 'unknown' ? 'not recognised' : d.stack.kind],
    ['project name', d.projectName || 'not detected'],
    ['android package', d.android.applicationId || 'not detected'],
    ['launcher activity', d.android.activity || 'not detected'],
    [
      'flavors',
      Object.keys(d.flavors).length ? Object.keys(d.flavors).join(', ') : 'none found',
    ],
    ['ios bundle ids', d.iosBundleIds.length ? d.iosBundleIds.join(', ') : 'none found'],
    ['package manager', d.packageManager || 'n/a'],
    ['source dir', d.codeMap.sourceDir || 'not detected'],
    ['translations', d.codeMap.translationsDir || 'not detected'],
    [
      'locales',
      d.locales.locales.length
        ? `${d.locales.locales.join(', ')}${d.locales.rtlLocales.length ? ` (rtl: ${d.locales.rtlLocales.join(', ')})` : ''}`
        : 'not detected',
    ],
    ['test command', d.commands.test || 'not detected'],
    ['lint command', d.commands.lint || 'not detected'],
    ['typecheck command', d.commands.typecheck || 'not detected'],
    ['tests gitignored', d.testsGitignored ? 'yes' : 'no'],
    ['default branch', d.defaultBranch || 'not detected'],
    ['emulators', d.avds.length ? d.avds.join(', ') : 'none found'],
    ['ios simulators', d.simulators.length ? `${d.simulators.length} available` : 'none found'],
    [
      'agents on PATH',
      [d.claude ? 'claude' : '', d.codex ? 'codex' : ''].filter(Boolean).join(', ') || 'none',
    ],
  ];
  printPairs(pairs);
}

// --------------------------------------------------------------------- ask

const PROD_LIKE = /^(prod|production|live|release)$/i;
// credentials-file status values that mean an account is usable.
const HAVE_ACCOUNT = ['env', 'file'];

// Flavors and backend URLs are keyed by the same names, so the union is the
// list of environments this project has.
function envNames(cfg) {
  const names = [];
  for (const n of Object.keys((cfg.app && cfg.app.flavors) || {})) if (!names.includes(n)) names.push(n);
  for (const n of Object.keys((cfg.backend && cfg.backend.baseUrls) || {})) if (!names.includes(n)) names.push(n);
  if (names.length === 0 && cfg.app && cfg.app.defaultFlavor) names.push(cfg.app.defaultFlavor);
  return names;
}

function isProtectedName(cfg, name) {
  const listed = ((cfg.backend && cfg.backend.protectedEnvs) || []).map(n => String(n).toLowerCase());
  return listed.includes(String(name).toLowerCase()) || PROD_LIKE.test(String(name));
}

// Presence only, so a prompt can say "one is already set" without reading it.
function credentialsKnownFor(host, cfg, env) {
  return HAVE_ACCOUNT.includes(credFile.status(u.credentialsPathOf(host, cfg), env));
}

// The username is not a secret, so it can be offered as the default.
function credentialUsername(host, cfg, env) {
  try {
    const data = credFile.read(u.credentialsPathOf(host, cfg));
    const block = data && data[env];
    return (block && typeof block.username === 'string' && block.username !== 'CHANGE_ME') ? block.username : '';
  } catch (_) {
    return '';
  }
}

async function askQuestions(host, d, cfg) {
  const credentials = {};
  const answers = { project: {}, agent: {}, app: {}, devices: { android: {}, ios: {} }, backend: { auth: {}, baseUrls: {} } };

  u.heading('Step 1 of 4: project');
  answers.project.name = await u.askWithDefault('App name', cfg.project.name || d.projectName);

  u.heading('Step 2 of 4: app under test');
  const flavorNames = Object.keys(cfg.app.flavors || {});
  if (flavorNames.length > 1) {
    u.info(`  flavors found: ${flavorNames.join(', ')}`);
    answers.app.defaultFlavor = await u.askWithDefault('Flavor to QC', cfg.app.defaultFlavor);
  } else if (flavorNames.length === 1) {
    u.info(`  only one flavor found (${flavorNames[0]}), using it`);
  } else {
    answers.app.defaultFlavor = await u.askWithDefault('Flavor to QC', cfg.app.defaultFlavor);
  }

  if (d.avds.length > 1) {
    u.info(`  emulators: ${d.avds.join(', ')}`);
    answers.devices.android.avd = await u.askWithDefault(
      'Emulator to drive',
      cfg.devices.android.avd || d.avds[0],
    );
  }
  if (d.simulators.length) {
    const wantIos = await u.confirm('Also QC on an iOS simulator?', false);
    if (wantIos) {
      answers.devices.ios.enabled = true;
      answers.devices.ios.deviceName = await u.askWithDefault(
        'Simulator name',
        cfg.devices.ios.deviceName || d.simulators[0].name,
      );
    }
  }

  u.heading('Step 3 of 4: agent');
  if (d.claude && d.codex) {
    const kind = await u.askWithDefault('Agent to drive the run (claude/codex)', cfg.agent.kind === 'codex' ? 'codex' : 'claude');
    answers.agent.kind = /^codex$/i.test(kind) ? 'codex' : 'claude';
  } else if (d.claude || d.codex) {
    u.info(`  using ${d.claude ? 'claude' : 'codex'}, the only agent on PATH`);
  } else {
    u.info('  no agent CLI on PATH; qc-check will print the prompt for you to paste');
  }

  u.heading('Step 4 of 5: backend');
  const hasBackend = await u.confirm('Does this app talk to a backend qc-check should check?', cfg.backend.enabled !== false);
  answers.backend.enabled = hasBackend;
  if (hasBackend) {
    answers.backend.auth.path = await u.askWithDefault('Login path', cfg.backend.auth.path || '/auth/login');
    answers.backend.auth.usernameField = await u.askWithDefault(
      'Username body field',
      cfg.backend.auth.usernameField || 'username',
    );
    answers.backend.auth.passwordField = await u.askWithDefault(
      'Password body field',
      cfg.backend.auth.passwordField || 'password',
    );
    answers.backend.auth.tokenPath = await u.askWithDefault(
      'Dot-path to the token in the login response',
      cfg.backend.auth.tokenPath,
    );
  }

  // One pass per environment. A flavor build points at its own backend and
  // needs its own test account, so the three are asked for together.
  u.heading('Step 5 of 5: environments and their QC accounts');
  const names = envNames(cfg);
  u.info(`  environments: ${names.join(', ') || '(none detected)'}`);
  if (names.some((n) => isProtectedName(cfg, n))) {
    u.info('  a protected environment (prod-like) defaults to no account: a QC run');
    u.info('  logs in and can write data, which is rarely what you want there.');
  }
  u.info('');

  for (const env of names) {
    const guarded = isProtectedName(cfg, env);
    u.info(`  ${env}${guarded ? '  (protected)' : ''}`);
    if (hasBackend) {
      const url = await u.askWithDefault(
        `  base URL for ${env}`,
        (cfg.backend.baseUrls && cfg.backend.baseUrls[env]) || '',
      );
      if (url) answers.backend.baseUrls[env] = url;
    }
    const known = credentialsKnownFor(host, cfg, env);
    const wantCreds = await u.confirm(
      `  set a QC account for ${env}?${known ? ' (one is already set)' : ''}`,
      !guarded && !known,
    );
    if (wantCreds) {
      const username = await u.askWithDefault('    username', credentialUsername(host, cfg, env));
      const password = await u.askSecret(
        `    password (hidden${known ? ', blank keeps the current one' : ''}): `,
      );
      if (username) credentials[env] = { username, password };
    }
    u.info('');
  }

  while (await u.confirm('Add another environment?', false)) {
    const name = await u.askWithDefault('  name (for example uat)', '');
    if (!name) break;
    answers.app.flavors = answers.app.flavors || {};
    answers.app.flavors[name] = {
      androidPackage: await u.askWithDefault('  android package', ''),
      iosBundleId: await u.askWithDefault('  ios bundle id', ''),
    };
    if (hasBackend) {
      const url = await u.askWithDefault('  base URL', '');
      if (url) answers.backend.baseUrls[name] = url;
    }
    if (await u.confirm(`  set a QC account for ${name}?`, !isProtectedName(cfg, name))) {
      const username = await u.askWithDefault('    username', '');
      const password = await u.askSecret('    password (hidden): ');
      if (username) credentials[name] = { username, password };
    }
  }

  const allNames = [...new Set([...names, ...Object.keys(answers.app.flavors || {})])];
  if (allNames.length > 1) {
    const chosen = await u.askWithDefault('Default environment', cfg.app.defaultFlavor || allNames[0]);
    if (chosen) {
      answers.app.defaultFlavor = chosen;
      answers.backend.defaultEnv = chosen;
    }
  }

  answers.project.commitReports = await u.confirm(
    'Keep QC reports in git? (recordings stay ignored either way)',
    cfg.project.commitReports === true,
  );

  return { answers, credentials };
}

// ------------------------------------------------------------------- todos

function collectTodos(cfg, d) {
  const todos = [];
  const flavor = cfg.app.defaultFlavor;
  const flavorCfg = (cfg.app.flavors || {})[flavor];

  if (d.stack.kind === 'unknown') {
    todos.push('stack not recognised: check codeMap.sourceDir and app.build by hand');
  }
  if (!flavorCfg || !flavorCfg.androidPackage) {
    todos.push(`app.flavors.${flavor || '<flavor>'}.androidPackage is empty: set the installed package id`);
  }
  if (!cfg.app.androidActivity) {
    todos.push('app.androidActivity is empty: set the fully qualified launcher activity');
  }
  if (!cfg.app.build.android && cfg.devices.android.enabled) {
    todos.push('app.build.android is empty: set the command that installs the flavor, or build by hand');
  }
  if (cfg.devices.ios.enabled && (!flavorCfg || !flavorCfg.iosBundleId)) {
    todos.push(`app.flavors.${flavor || '<flavor>'}.iosBundleId is empty: set the simulator bundle id`);
  }
  if (cfg.devices.android.enabled && !cfg.devices.android.avd) {
    todos.push('devices.android.avd is empty: name an emulator, or start one before the run');
  }
  if (!cfg.codeMap.translationsDir) {
    todos.push('codeMap.translationsDir is empty: locale checks are skipped without it');
  }
  if (!cfg.codeMap.testCommand) {
    todos.push('codeMap.testCommand is empty: the unit-test phase is skipped without it');
  }
  if (cfg.backend.enabled) {
    const env = cfg.backend.defaultEnv;
    if (!cfg.backend.baseUrls || !cfg.backend.baseUrls[env]) {
      todos.push(`backend.baseUrls.${env} is empty: set it, or set backend.enabled to false`);
    }
    if (!cfg.backend.auth.path) todos.push('backend.auth.path is empty: set the login path');
    if (!cfg.backend.auth.tokenPath) {
      todos.push('backend.auth.tokenPath is empty: set the dot-path to the bearer token');
    }
  }
  if (cfg.agent.kind === 'none') {
    todos.push(
      d.claude && d.codex
        ? 'agent.kind is none: both claude and codex are on PATH, set the one to use'
        : 'agent.kind is none: `qc-check prompt` prints the workflow to paste into any agent',
    );
  }
  return todos;
}

// -------------------------------------------------------------------- main

function help() {
  u.info(`qc-check setup - detect this repository and write qc.config.json.

Usage
  qc-check setup [options]

What it does
  1. Detects the stack, package ids, flavors, build and test commands,
     source layout, locales, emulators and the agent CLI on PATH.
  2. Asks only about what it cannot detect, with detected defaults.
  3. Writes qc.config.json, the credentials template, gitignore entries,
     and copies the runtime to qc/.

Options
  --dir <path>   configure this repository instead of the current one
  --force        start from a fresh config instead of updating the existing one
  --yes          take every detected value and default, ask nothing
  --help         show this help

Examples
  qc-check setup
  qc-check setup --dir /path/to/app --yes

After setup
  qc-check doctor
  qc-check run ABC-123`);
}

// Write the QC accounts collected during setup, plus anything supplied through
// QC_CRED_<ENV>_* variables. Values are never printed, not even partially.
function writeCredentials(host, cfg, collected) {
  const credPath = u.credentialsPathOf(host, cfg);
  const credRel = path.relative(host, credPath);
  const asked = Object.keys(collected || {});

  if (fs.existsSync(credPath) && !credFile.isGenerated(credPath)) {
    u.info(`  kept     ${credRel} (hand-written, not managed by qc-check)`);
    if (asked.length) {
      u.warn(
        `${credRel} is hand-written, so the account(s) you entered were not saved. ` +
          'Edit that file yourself, or move it aside and re-run setup.',
      );
    }
    return;
  }

  const data = fs.existsSync(credPath) ? credFile.read(credPath) : {};
  const touched = [];

  for (const env of asked) {
    const entry = collected[env] || {};
    const existing = (data[env] && data[env].password) || '';
    // A blank password keeps whatever was already there.
    const password = entry.password || existing;
    if (!password) {
      u.warn(`no password entered for ${env}, so no account was saved for it.`);
      continue;
    }
    data[env] = { username: entry.username, password };
    touched.push(env);
  }

  for (const env of envNames(cfg)) {
    const fromEnv = credFile.fromEnvVars(env);
    if (fromEnv && fromEnv.username && fromEnv.password) {
      data[env] = fromEnv;
      if (!touched.includes(env)) touched.push(`${env} (from QC_CRED_* variables)`);
    }
  }

  // A placeholder makes the shape discoverable without pretending an account
  // exists: CHANGE_ME never counts as usable.
  for (const env of envNames(cfg)) {
    if (!data[env] && !isProtectedName(cfg, env)) {
      data[env] = { username: 'CHANGE_ME', password: 'CHANGE_ME' };
    }
  }

  credFile.write(credPath, data);
  const ready = Object.keys(data).filter((e) => data[e].password && data[e].password !== 'CHANGE_ME');
  u.info(`  wrote    ${credRel} (mode 0600, gitignored)`);
  u.info(`           accounts set: ${ready.join(', ') || 'none yet'}`);
  if (touched.length) u.info(`           updated: ${touched.join(', ')}`);
}

// Keep one marked block in .gitignore, so switching commitReports rewrites it
// instead of leaving the old rules behind.
function syncGitignore(host, lines) {
  const file = path.join(host, '.gitignore');
  const START = '# >>> qc-check';
  const END = '# <<< qc-check';
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  // Drop a previous marked block, and the older unmarked one.
  text = text.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, 'g'), '\n');
  text = text.replace(/\n?# qc-check: evidence and credentials stay local\n(?:[^\n]*\n)*?(?=\n|$)/g, '\n');

  const block = [START, '# Evidence and credentials. Managed by `qc-check setup`.', ...lines, END].join('\n');
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${text}${sep}\n${block}\n`.replace(/\n{3,}/g, '\n\n'));
}

async function run(args = {}) {
  const host = u.findHost(args);
  if (!fs.existsSync(host)) u.fail(`no such directory: ${host}`);

  let collectedCredentials = {};
  const force = Boolean(args.force);
  const interactive = u.isInteractive() && !args.yes;

  u.heading('Repository');
  u.info(`  configuring ${host}`);

  let existing = force ? null : u.readConfig(host);
  if (existing && !force) {
    u.info(`  found an existing ${u.CONFIG_FILE}`);
    if (interactive) {
      const update = await u.confirm('Update it in place, keeping the values you set?', true);
      if (!update) {
        const fresh = await u.confirm('Start from a fresh config instead?', false);
        if (!fresh) {
          u.info('  nothing changed.');
          return;
        }
        existing = null;
      }
    } else {
      u.info('  updating it in place, keeping the values already set');
    }
  } else if (force && u.readConfig(host)) {
    u.info(`  --force: starting from a fresh config, the existing ${u.CONFIG_FILE} is replaced`);
  }

  u.heading('Detected');
  const d = detect(host);
  describeDetections(d);

  // Detection first, then the user's existing values, so hand edits win.
  let cfg = u.deepMerge(baseConfig(), detectedConfig(d));
  if (existing) {
    const keep = { ...existing };
    delete keep.$schema;
    cfg = u.deepMerge(cfg, keep);
  }

  if (interactive) {
    const asked = await askQuestions(host, d, cfg);
    cfg = u.deepMerge(cfg, asked.answers);
    collectedCredentials = asked.credentials;
  } else {
    u.heading('Assumed');
    u.info('  not interactive: taking every detected value and the schema defaults');
    printPairs([
      ['app name', cfg.project.name || '(none)'],
      ['flavor', cfg.app.defaultFlavor || '(none)'],
      ['emulator', cfg.devices.android.avd || '(none, start one before the run)'],
      ['agent', cfg.agent.kind],
      ['backend', cfg.backend.enabled ? 'enabled, URLs left blank' : 'disabled'],
      ['ios', cfg.devices.ios.enabled ? 'enabled' : 'disabled'],
      ['tablet', cfg.devices.android_tablet.enabled ? 'enabled' : 'disabled'],
    ]);
  }

  // The local schema path is not shipped to the host repo, so no $schema key.
  delete cfg.$schema;
  cfg = orderLike(orderTemplate(), cfg);

  u.heading('Writing');
  u.writeConfig(host, cfg);
  u.info(`  wrote    ${u.CONFIG_FILE}`);

  writeCredentials(host, cfg, collectedCredentials);

  const reports = cfg.project.reportsDir || 'qc-reports';
  // Recordings are large binaries and the active marker is per-machine, so
  // they stay out of git even when the reports themselves are kept.
  const ignoreLines = cfg.project.commitReports
    ? [cfg.credentialsFile, `${reports}/.active.json`, `${reports}/_unsorted/`, `${reports}/**/recordings/`]
    : [cfg.credentialsFile, `${reports}/`];
  syncGitignore(host, ignoreLines);
  u.info(`  ignored  ${ignoreLines.join(', ')}`);

  const copied = u.copyDir(path.join(u.PKG_ROOT, 'runtime'), path.join(host, u.RUNTIME_DIR));
  u.info(`  copied   ${copied} runtime file(s) to ${u.RUNTIME_DIR}/`);

  const todos = collectTodos(cfg, d);
  if (todos.length) {
    u.heading('TODO: not detected, fill these in');
    for (const t of todos) u.info(`  - ${t}`);
  }

  u.heading('Next steps');
  const needAccounts = envNames(cfg).filter(
    (e) => !isProtectedName(cfg, e) && !HAVE_ACCOUNT.includes(credFile.status(u.credentialsPathOf(host, cfg), e)),
  );
  u.info(
    needAccounts.length
      ? `  1. Add a QC account for: ${needAccounts.join(', ')}   (qc-check env credentials <env>)`
      : '  1. QC accounts are set. Check them with: qc-check env',
  );
  u.info(`  2. Review ${u.CONFIG_FILE}${todos.length ? ' and clear the TODOs above' : ''}.`);
  u.info('  3. qc-check doctor        confirm Appium, a device and an agent are ready.');
  u.info('  4. qc-check run ABC-123 --env <env>   QC one ticket.');
  u.info('');
}

module.exports = { run, help };
