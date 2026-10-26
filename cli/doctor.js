'use strict';

// qc-check doctor: tell the user exactly what is not ready yet.
// Every problem line names the fix, because this is the command people run
// when something has already gone wrong.

const fs = require('fs');
const path = require('path');

const {
  info,
  heading,
  findHost,
  readConfig,
  reportsDirOf,
  credentialsPathOf,
  RUNTIME_DIR,
  which,
  listAvds,
  listIosSimulators,
  listIosRealDevices,
  appiumStatus,
  pkgVersion,
  tryExec,
} = require('./util');
const repoHost = require('../runtime/repo-host');

function help() {
  info(`qc-check doctor - check the environment and configuration.

Usage
  qc-check doctor [--dir <path>]

Exits 0 when the repository is ready to run QC, non-zero otherwise, so it can
gate a script. Reports presence only: it never opens the credentials file.`);
}

async function run(args) {
  const host = findHost(args);
  const cfg = readConfig(host);
  const ok = [];
  const fix = [];

  info(`qc-check ${pkgVersion()}`);
  info(`repository: ${host}`);

  // ---------------------------------------------------------------- node
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fix.push(`Node ${process.versions.node} is too old. Install Node 18 or newer.`);
  else ok.push(`node ${process.versions.node}`);

  // -------------------------------------------------------------- config
  if (!cfg) {
    fix.push('qc.config.json is missing. Run `qc-check setup`.');
    report(ok, fix);
    return;
  }
  ok.push('qc.config.json parses');

  const reports = reportsDirOf(host, cfg);
  ok.push(`reports dir: ${path.relative(host, reports) || '.'}`);

  // ------------------------------------------------------------- runtime
  const runtime = path.join(host, RUNTIME_DIR);
  if (!fs.existsSync(path.join(runtime, 'driver.js'))) {
    fix.push(`the runtime is not installed at ${RUNTIME_DIR}/. Run \`qc-check setup\`.`);
  } else {
    const n = fs.readdirSync(runtime).length;
    ok.push(`runtime installed at ${RUNTIME_DIR}/ (${n} files)`);
  }

  // --------------------------------------------------------------- build
  const flavor = (cfg.app && cfg.app.defaultFlavor) || '';
  const flavors = (cfg.app && cfg.app.flavors) || {};
  if (!flavor) fix.push('app.defaultFlavor is not set.');
  else if (!flavors[flavor]) fix.push(`app.defaultFlavor "${flavor}" has no entry in app.flavors.`);
  else {
    const f = flavors[flavor];
    ok.push(`flavor ${flavor}: ${f.androidPackage || f.iosBundleId || '(no package id)'}`);
  }

  // -------------------------------------------------------------- devices
  const devices = cfg.devices || {};
  const enabled = Object.entries(devices)
    .filter(([k, v]) => k !== 'appium' && v && v.enabled)
    .map(([k]) => k);

  if (enabled.length === 0) {
    fix.push('no device profile is enabled. Set devices.android.enabled to true.');
  } else {
    ok.push(`device profiles: ${enabled.join(', ')}`);
  }

  // An AVD named in the config but absent on this machine is the single most
  // common reason a run dies minutes in.
  const avds = listAvds();
  for (const name of ['android', 'android_tablet']) {
    const prof = devices[name];
    if (!prof || !prof.enabled || !prof.avd) continue;
    if (avds.length === 0) {
      ok.push(`${name}: cannot list emulators (is the Android SDK on PATH?)`);
    } else if (!avds.includes(prof.avd)) {
      fix.push(
        `devices.${name}.avd "${prof.avd}" is not installed. Available: ${avds.join(', ') || 'none'}`,
      );
    } else {
      ok.push(`${name}: emulator ${prof.avd} exists`);
    }
  }

  if (devices.ios && devices.ios.enabled) {
    if (process.platform !== 'darwin') {
      fix.push('devices.ios.enabled is true but this is not macOS.');
    } else if (devices.ios.realDevice) {
      const want = devices.ios.udid;
      const phones = listIosRealDevices();
      const found = phones.find((p) => p.udid === want);
      if (!want) {
        fix.push('devices.ios.realDevice is true but devices.ios.udid is empty. Find it with `xcrun devicectl list devices` or in Device Hub.');
      } else if (!found) {
        fix.push(
          `devices.ios.udid "${want}" is not a paired iPhone. Connect and trust it, then check Device Hub. ` +
            `Seen: ${phones.map((p) => `${p.name} (${p.udid})`).join(', ') || 'none'}`,
        );
      } else {
        ok.push(`ios: iPhone ${found.name}${found.connected ? '' : ' (paired, not connected right now)'}`);
      }
      if (!devices.ios.teamId) {
        fix.push('devices.ios.teamId is empty: a real iPhone needs your Apple team id to sign WebDriverAgent.');
      }
    } else {
      const sims = listIosSimulators();
      const want = devices.ios.deviceName;
      if (want && sims.length && !sims.some((s) => s.name === want)) {
        fix.push(`devices.ios.deviceName "${want}" is not an available simulator.`);
      } else {
        ok.push(`ios: simulator ${want || '(auto)'}`);
      }
      // eslint-disable-next-line global-require
      const wdaApp = require('../runtime/wda.js').readyAppPath();
      ok.push(
        wdaApp
          ? `ios: prebuilt WebDriverAgent ready (sessions skip xcodebuild): ${wdaApp}`
          : 'ios: prebuilt WebDriverAgent not built yet; the first iOS connect builds it (or run `node qc/wda.js`)',
      );
    }
  }

  // --------------------------------------------------------------- appium
  const ap = devices.appium || {};
  const apHost = ap.host || '127.0.0.1';
  const apPort = ap.port || 4723;
  if (!which('appium')) {
    fix.push('appium is not on PATH. Install it with `npm i -g appium`, then add a driver.');
  } else {
    const st = appiumStatus(apHost, apPort);
    if (st.state === 'none') {
      fix.push(`no Appium server at ${apHost}:${apPort}. Start one with \`appium --port ${apPort}\`.`);
    } else if (st.state === 'impostor') {
      fix.push(
        `something is listening on ${apHost}:${apPort} but it is not Appium. Find it with \`lsof -iTCP:${apPort} -sTCP:LISTEN\`, stop it, then start Appium.`,
      );
    } else {
      ok.push(`appium ${st.version} reachable at ${apHost}:${apPort}`);
    }
  }

  // -------------------------------------------------------------- backend
  if (cfg.backend && cfg.backend.enabled) {
    const env = cfg.backend.defaultEnv;
    const url = (cfg.backend.baseUrls || {})[env];
    if (!url) fix.push(`backend.baseUrls has no URL for defaultEnv "${env}".`);
    else ok.push(`backend ${env}: ${url}`);
    if (!(cfg.backend.auth || {}).path) {
      fix.push('backend.auth.path is empty, so the contract and smoke phases cannot log in.');
    }
  } else {
    ok.push('backend checks disabled');
  }

  // -------------------------------------------------------------- tracker
  const tracker = cfg.tracker || {};
  if (!tracker.kind || tracker.kind === 'none') {
    ok.push('tracker: none (publish is skipped, the report stays on disk)');
  } else if (tracker.kind === 'jira' && tracker.rest && tracker.rest.enabled) {
    const r = tracker.rest;
    const envs = [r.baseUrlEnv || 'JIRA_BASE_URL', r.emailEnv || 'JIRA_EMAIL', r.tokenEnv || 'JIRA_API_TOKEN'];
    const absent = envs.filter(n => !process.env[n]);
    if (absent.length) {
      fix.push(`tracker: jira over REST needs ${absent.join(', ')} in the environment (export them in your shell profile)`);
    } else {
      ok.push(`tracker: jira over REST (${envs.join(', ')} set; \`node qc/tracker.js check\` tests the login)`);
    }
  } else {
    const unset = Object.entries(tracker.tools || {})
      .filter(([, v]) => !v)
      .map(([k]) => k);
    ok.push(`tracker: ${tracker.kind}${unset.length ? ` (not wired: ${unset.join(', ')})` : ''}`);
  }

  // ------------------------------------------------------- pull requests
  // Only `qc-check run pr` and PR comments need this, so a gap is reported as
  // "not ready for PR runs" rather than failing the whole check.
  const repo = cfg.repo || {};
  const remoteName = repo.remote || 'origin';
  const remoteUrl = tryExec('git', ['remote', 'get-url', remoteName], { cwd: host });
  const remote = remoteUrl.ok ? repoHost.parseRemote(remoteUrl.stdout) : null;
  let prHost = 'none';
  try {
    prHost = repoHost.resolveHost(repo.host, remote).kind;
  } catch (err) {
    fix.push(err.message);
  }
  if (prHost === 'github') {
    ok.push(
      which('gh')
        ? `pull requests: github ${remote ? remote.slug : ''} via gh (\`gh auth status\` checks the login)`
        : 'pull requests: github, but gh is not on PATH, so `qc-check run pr` will not work (brew install gh)',
    );
  } else if (prHost === 'bitbucket') {
    const bb = repo.bitbucket || {};
    const names = [bb.emailEnv || 'BITBUCKET_EMAIL', bb.tokenEnv || 'BITBUCKET_API_TOKEN'];
    const absent = names.filter((n) => !process.env[n]);
    ok.push(
      absent.length
        ? `pull requests: bitbucket ${remote ? remote.slug : ''}, but ${absent.join(', ')} not set, so \`qc-check run pr\` will not work`
        : `pull requests: bitbucket ${remote ? remote.slug : ''} (${names.join(', ')} set)`,
    );
  } else {
    ok.push(`pull requests: no supported host on remote "${remoteName}" (\`qc-check run pr\` needs GitHub or Bitbucket Cloud)`);
  }
  for (const rel of ((cfg.app && cfg.app.build && cfg.app.build.copyFiles) || [])) {
    if (!fs.existsSync(path.resolve(host, rel))) {
      fix.push(`app.build.copyFiles lists ${rel}, which is not in this checkout, so a worktree build will miss it.`);
    }
  }

  // ---------------------------------------------------------- credentials
  // Presence only. Opening this file is exactly what the tool promises not to do.
  const credPath = credentialsPathOf(host, cfg);
  if (fs.existsSync(credPath)) ok.push(`credentials file present: ${path.relative(host, credPath)}`);
  else {
    fix.push(
      `credentials file missing: ${path.relative(host, credPath)}. Copy ${RUNTIME_DIR}/credentials.example.js to it and fill it in.`,
    );
  }

  // ---------------------------------------------------------------- agent
  const agent = cfg.agent || {};
  const kind = agent.kind || 'claude';
  if (kind === 'none') {
    ok.push('agent: none (qc-check prompt prints the prompt for you to paste)');
  } else if (kind === 'custom') {
    if (!agent.command) fix.push('agent.kind is custom but agent.command is empty.');
    else ok.push(`agent: custom (${agent.command.split(' ')[0]})`);
  } else if (!which(kind)) {
    fix.push(
      `agent.kind is "${kind}" but "${kind}" is not on PATH. Install it, or set agent.kind to "none" and use \`qc-check prompt\`.`,
    );
  } else {
    ok.push(`agent: ${kind}${agent.headless ? ' (headless)' : ''}`);
  }

  report(ok, fix);
}

function report(ok, fix) {
  heading('Ready');
  for (const line of ok) info(`  ok    ${line}`);
  if (fix.length) {
    heading('Needs attention');
    for (const line of fix) info(`  FIX   ${line}`);
  }
  info('');
  info(
    fix.length === 0
      ? 'Ready to run: qc-check run ABC-123'
      : `${fix.length} thing${fix.length === 1 ? '' : 's'} to fix.`,
  );
  process.exit(fix.length === 0 ? 0 : 1);
}

module.exports = { run, help };
