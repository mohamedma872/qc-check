#!/usr/bin/env node
'use strict';

// Prebuilt WebDriverAgent for iOS simulators.
//
// By default Appium starts WebDriverAgent with `xcodebuild test-without-building`
// on every session. Under Xcode 26 that step hangs or dies with exit code 75,
// and the session times out waiting for WDA's /status. This module builds WDA
// once per Xcode + WDA version, makes the runner app launchable on its own, and
// lets config.js hand it to Appium as a preinstalled app (`usePreinstalledWDA`
// + `prebuiltWDAPath`): Appium then installs and starts it with `simctl`, and
// xcodebuild never runs at session time.
//
// "Launchable on its own" is the Xcode 26 part. Its runner embeds
// Testing.framework and libXCTestSwiftSupport, which link
// lib_TestingInterop.dylib and _Testing_Foundation.framework. xcodebuild injects
// those at test time; launched by simctl the app dies in dyld ("cannot be opened
// because of a problem"). So the platform's testing frameworks are copied into
// the runner and the bundle is re-signed ad hoc.
//
// Simulators only: a real iPhone needs a WDA signed with the user's team.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNNER = 'WebDriverAgentRunner-Runner.app';
const READY = '.qc-ready';

function cacheRoot() {
  return process.env.QC_WDA_CACHE || path.join(os.homedir(), '.cache', 'qc-check', 'wda');
}

function developerDir() {
  if (process.env.DEVELOPER_DIR) {return process.env.DEVELOPER_DIR;}
  const r = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

// Xcode's build number (e.g. 17F42), read from version.plist: cheap enough to
// run on every capsFor() call, unlike `xcodebuild -version`.
function xcodeBuild(devDir) {
  const plist = path.join(devDir, '..', 'version.plist');
  if (!fs.existsSync(plist)) {return '';}
  const m = fs.readFileSync(plist, 'utf8').match(/<key>ProductBuildVersion<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? m[1] : '';
}

// The WebDriverAgent sources the installed XCUITest driver ships with.
function wdaProject() {
  const home = process.env.APPIUM_HOME || path.join(os.homedir(), '.appium');
  const driver = path.join(home, 'node_modules', 'appium-xcuitest-driver');
  for (const dir of [
    path.join(driver, 'node_modules', 'appium-webdriveragent'),
    path.join(home, 'node_modules', 'appium-webdriveragent'),
  ]) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(path.join(dir, 'WebDriverAgent.xcodeproj')) && fs.existsSync(pkg)) {
      return { dir, version: JSON.parse(fs.readFileSync(pkg, 'utf8')).version };
    }
  }
  return null;
}

// Everything that decides where the build lives; null when this host cannot
// build one (not macOS, no Xcode, no XCUITest driver).
function target() {
  if (process.platform !== 'darwin') {return null;}
  const devDir = developerDir();
  const build = devDir && xcodeBuild(devDir);
  const wda = wdaProject();
  if (!build || !wda) {return null;}
  const dir = path.join(cacheRoot(), `${wda.version}-xcode${build}`);
  return {
    devDir,
    wda,
    dir,
    app: path.join(dir, 'Build', 'Products', 'Debug-iphonesimulator', RUNNER),
  };
}

// Path of a ready runner for the current Xcode + driver, or null.
function readyAppPath() {
  const t = target();
  return t && fs.existsSync(path.join(t.dir, READY)) && fs.existsSync(t.app) ? t.app : null;
}

// Copies the simulator platform's testing frameworks and dylibs the runner
// does not already embed. Returns the names added.
function embedTestingFrameworks(app, devDir) {
  const platform = path.join(devDir, 'Platforms', 'iPhoneSimulator.platform', 'Developer');
  const sources = [
    [path.join(platform, 'Library', 'Frameworks'), (n) => n.endsWith('.framework')],
    [path.join(platform, 'Library', 'PrivateFrameworks'), (n) => /^XCT.*\.framework$/.test(n)],
    [path.join(platform, 'usr', 'lib'), (n) => n.endsWith('.dylib')],
  ];
  const dest = path.join(app, 'Frameworks');
  fs.mkdirSync(dest, { recursive: true });
  const added = [];
  for (const [dir, wanted] of sources) {
    if (!fs.existsSync(dir)) {continue;}
    for (const name of fs.readdirSync(dir).filter(wanted)) {
      if (fs.existsSync(path.join(dest, name))) {continue;}
      fs.cpSync(path.join(dir, name), path.join(dest, name), { recursive: true, verbatimSymlinks: true });
      added.push(name);
    }
  }
  return added;
}

// Builds (once) and patches the runner. Returns { app } or { error, log }.
function prepare({ rebuild = false, log = console.log } = {}) {
  const t = target();
  if (!t) {
    return { error: 'needs macOS with Xcode and the Appium XCUITest driver (appium driver install xcuitest)' };
  }
  if (!rebuild && readyAppPath()) {return { app: t.app };}

  fs.rmSync(t.dir, { recursive: true, force: true });
  fs.mkdirSync(t.dir, { recursive: true });
  const logFile = path.join(t.dir, 'build.log');
  log(`Building WebDriverAgent ${t.wda.version} for simulators (one time per Xcode, a few minutes) ...`);
  log(`   log: ${logFile}`);
  const out = fs.openSync(logFile, 'w');
  const r = spawnSync(
    'xcodebuild',
    [
      'build-for-testing',
      '-project', path.join(t.wda.dir, 'WebDriverAgent.xcodeproj'),
      '-scheme', 'WebDriverAgentRunner',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', t.dir,
      'CODE_SIGNING_ALLOWED=NO',
    ],
    { stdio: ['ignore', out, out], env: { ...process.env, DEVELOPER_DIR: t.devDir } },
  );
  fs.closeSync(out);
  if (r.status !== 0 || !fs.existsSync(t.app)) {
    return { error: `xcodebuild build-for-testing failed (exit ${r.status})`, log: logFile };
  }

  const added = embedTestingFrameworks(t.app, t.devDir);
  if (added.length) {log(`   embedded: ${added.join(', ')}`);}
  const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', t.app], { encoding: 'utf8' });
  if (sign.status !== 0) {
    return { error: `codesign failed: ${(sign.stderr || '').trim()}`, log: logFile };
  }
  fs.writeFileSync(path.join(t.dir, READY), `${new Date().toISOString()}\n`);
  return { app: t.app };
}

module.exports = { readyAppPath, prepare, embedTestingFrameworks, cacheRoot };

function printHelp() {
  console.log(`Prebuilt WebDriverAgent for iOS simulators

Usage: node qc/wda.js [prepare] [--rebuild]   build once and print the runner path
       node qc/wda.js --path                  print the ready runner path (exit 1 if none)

The build is cached under ${cacheRoot()} (QC_WDA_CACHE overrides it), one per
Xcode build and XCUITest driver WDA version, so an Xcode or driver update
rebuilds it on the next connect. With a ready runner, iOS simulator sessions
start WDA through simctl instead of xcodebuild, which hangs under Xcode 26.
Opt out per repo with devices.ios.caps: { "appium:usePreinstalledWDA": null,
"appium:prebuiltWDAPath": null }.`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    printHelp();
    process.exit(0);
  }
  if (argv[0] === '--path') {
    const app = readyAppPath();
    if (app) {console.log(app);}
    process.exit(app ? 0 : 1);
  }
  const res = prepare({ rebuild: argv.includes('--rebuild') });
  if (res.error) {
    console.error(`ERROR: ${res.error}`);
    if (res.log) {console.error(`   see ${res.log}`);}
    process.exit(1);
  }
  console.log(res.app);
}
