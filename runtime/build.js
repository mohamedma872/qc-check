#!/usr/bin/env node
// QC - build the branch under test in its own git worktree, and prove the
// install landed.
//
// The developer's checkout is never touched: no checkout, no stash, no reset.
// Each branch gets a worktree under app.build.worktreeDir (default: the OS
// temp dir, so the host's analyzer and file watchers never see it). The
// gitignored files in app.build.copyFiles (env files, keystores' properties)
// are copied in from the main checkout and never committed.
//
// Usage:
//   node qc/build.js prepare --branch <b> [--remote origin] [--copy a,b] [--flavor f] [--force]
//   node qc/build.js run --platform android|ios [--branch <b>] [--flavor f] [--serial s] [--force]
//   node qc/build.js status
//   node qc/build.js clean [--branch <b>]
//
// Exit codes: 0 ok | 1 usage/config | 2 git failed | 3 build failed | 5 install not verified
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HELP = [
  'build.js - build the branch under test in its own worktree, and verify the install.',
  '',
  'Usage:',
  '  build.js prepare --branch <b> [--remote <r>] [--copy a,b] [--flavor <f>] [--force]',
  '        fetch, then create or reuse a worktree of <b> and copy app.build.copyFiles (plus',
  '        --copy; {flavor} is expanded) into it from the main checkout',
  '        (--force discards local changes in that worktree)',
  '  build.js run --platform android|ios [--branch <b>] [--flavor <f>] [--serial <s>] [--force]',
  '        run app.build.<platform> inside the worktree (the last prepared one by default);',
  '        skipped when the same commit was already built and installed, unless --force',
  '  build.js status        worktrees and the commit last built per platform',
  '  build.js clean [--branch <b>]   remove the worktrees (all of them by default)',
  '',
  'Install verification: Android compares `dumpsys package <pkg>` lastUpdateTime before and',
  'after and fails on adb Exception / Failure / "Can\'t find service" output; iOS checks',
  '`xcrun simctl get_app_container`. A failed check prints ERROR: and exits 5.',
  'Exit codes: 0 ok | 1 usage/config | 2 git failed | 3 build failed | 5 install not verified',
].join('\n');

// --- pure logic (exported for test/intake.js) --------------------------------

function safeName(branch) {
  return String(branch).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+/, '') || 'branch';
}

function expandBuild(command, flavor) {
  return String(command || '').replace(/\{flavor\}/g, flavor);
}

// Skip only when the same commit was built with the same command and flavor,
// and the installed app is still the one that build put there.
function shouldSkip(stamp, current, opts) {
  const o = opts || {};
  if (o.force) {return { skip: false, why: '--force' };}
  if (!stamp) {return { skip: false, why: 'no previous successful build' };}
  if (stamp.sha !== current.sha) {return { skip: false, why: `commit changed (${short(stamp.sha)} -> ${short(current.sha)})` };}
  if (stamp.flavor !== current.flavor) {return { skip: false, why: `flavor changed (${stamp.flavor} -> ${current.flavor})` };}
  if (stamp.command !== current.command) {return { skip: false, why: 'build command changed' };}
  if (current.installed === false) {return { skip: false, why: 'the app is not installed on the device' };}
  if (stamp.lastUpdateTime && current.lastUpdateTime && stamp.lastUpdateTime !== current.lastUpdateTime) {
    return { skip: false, why: 'the installed app was replaced since that build' };
  }
  return { skip: true, why: `commit ${short(current.sha)} already built and installed` };
}

function short(sha) {
  return String(sha || '').slice(0, 10) || '?';
}

// `adb shell dumpsys package <pkg>`, reduced to what the install check needs.
function parseDumpsys(text, pkg) {
  const s = String(text || '');
  const serviceMissing = /Can't find service/i.test(s);
  const listed = pkg ? s.includes(`Package [${pkg}]`) : /Package \[[^\]]+\]/.test(s);
  const pick = re => { const m = s.match(re); return m ? m[1].trim() : ''; };
  return {
    installed: listed && !serviceMissing,
    serviceMissing,
    lastUpdateTime: listed ? pick(/lastUpdateTime=([^\r\n]+)/) : '',
    versionCode: listed ? pick(/versionCode=(\d+)/) : '',
    versionName: listed ? pick(/versionName=([^\s]+)/) : '',
  };
}

// Lines of build/install output that mean adb or the package manager failed,
// even when the command exited 0. Anchored so a compiler warning that merely
// mentions an exception type does not count.
const FAILURE_PATTERNS = [
  /Exception occurred while executing/i,
  /Can't find service/i,
  /INSTALL_FAILED_[A-Z_]+/,
  /INSTALL_PARSE_FAILED_[A-Z_]+/,
  /^\s*(?:adb: )?failed to install/i,
  /^\s*Failure\b/,
  /^\s*(?:adb: )?Exception\b/,
  /^\s*(?:java|android)\.[\w.]+(?:Exception|Error)\b/,
  /^\s*cmd: Failure/i,
];

function installFailures(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(l => FAILURE_PATTERNS.some(re => re.test(l)))
    .map(l => l.trim());
}

// The verdict on an Android install, from dumpsys before and after plus the
// command output.
function verifyAndroidInstall(beforeText, afterText, output, pkg) {
  const before = parseDumpsys(beforeText, pkg);
  const after = parseDumpsys(afterText, pkg);
  const problems = [];
  const failures = installFailures(output);
  if (failures.length) {problems.push(`adb reported a failure: ${failures.slice(0, 3).join(' | ')}`);}
  if (after.serviceMissing) {
    problems.push('the package service is not answering ("Can\'t find service: package"): Android system_server is down; reboot the emulator');
  } else if (!after.installed) {
    problems.push(`${pkg} is not installed after the build`);
  } else if (before.installed && before.lastUpdateTime && before.lastUpdateTime === after.lastUpdateTime) {
    problems.push(`${pkg} did not update: lastUpdateTime is still ${after.lastUpdateTime}, so the OLD build is still installed`);
  }
  return { ok: problems.length === 0, problems, before, after };
}

module.exports = {
  safeName,
  expandBuild,
  shouldSkip,
  parseDumpsys,
  installFailures,
  verifyAndroidInstall,
};

// --- CLI -----------------------------------------------------------------------

function fail(message, code) {
  console.error(message);
  process.exit(code || 1);
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !String(args[i + 1]).startsWith('--') ? args[i + 1] : null;
}

function git(cwd, argv, opts) {
  const res = spawnSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0 && !(opts && opts.soft)) {
    fail(`ERROR: git ${argv.join(' ')} failed in ${cwd}: ${String(res.stderr || res.stdout).trim()}`, 2);
  }
  return { ok: res.status === 0, out: String(res.stdout || '').trim(), err: String(res.stderr || '').trim() };
}

function context() {
  // eslint-disable-next-line global-require
  const config = require('./config.js');
  const cfg = config.loadConfig();
  const build = (cfg.app && cfg.app.build) || {};
  const root = cfg.repoRoot;
  const slug = path.basename(root).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'repo';
  const cacheRoot = build.worktreeDir
    ? path.resolve(root, build.worktreeDir)
    : path.join(os.tmpdir(), 'qc-worktrees', `${slug}-${config.projectId(root)}`);
  // clean deletes this directory, so it must never be the checkout or above it.
  const rel = path.relative(cacheRoot, root);
  if (!rel || !rel.startsWith('..')) {
    fail(`ERROR: app.build.worktreeDir (${cacheRoot}) must not be the repository or one of its parents`);
  }
  return { config, cfg, build, root, cacheRoot };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const pointerFile = ctx => path.join(ctx.cacheRoot, 'current.json');
const stampFile = (ctx, branch, platform) => path.join(ctx.cacheRoot, 'stamps', `${safeName(branch)}.${platform}.json`);
const worktreeDir = (ctx, branch) => path.join(ctx.cacheRoot, safeName(branch));

function registeredWorktrees(root) {
  const out = git(root, ['worktree', 'list', '--porcelain']).out;
  return out.split('\n').filter(l => l.startsWith('worktree ')).map(l => safeReal(l.slice(9)));
}

function safeReal(p) {
  try { return fs.realpathSync(p); } catch (_) { return p; }
}

function cmdPrepare(args) {
  const ctx = context();
  const branch = flagValue(args, '--branch');
  if (!branch) {fail('ERROR: prepare needs --branch <name>');}
  const remote = flagValue(args, '--remote') || (ctx.cfg.repo && ctx.cfg.repo.remote) || 'origin';
  const dir = worktreeDir(ctx, branch);
  const ref = `refs/remotes/${remote}/${branch}`;

  // Fetching only updates the shared object store and the remote-tracking
  // ref: the developer's HEAD, index and working tree are left alone.
  console.error(`fetching ${remote} ${branch} ...`);
  git(ctx.root, ['fetch', '--no-tags', remote, `+refs/heads/${branch}:${ref}`]);
  const sha = git(ctx.root, ['rev-parse', ref]).out;

  fs.mkdirSync(ctx.cacheRoot, { recursive: true });
  git(ctx.root, ['worktree', 'prune']);
  const known = registeredWorktrees(ctx.root).includes(safeReal(dir));
  if (fs.existsSync(dir) && !known) {
    fail(`ERROR: ${dir} exists but is not a worktree of ${ctx.root}. Remove it, or run build.js clean.`, 2);
  }
  if (!known) {
    git(ctx.root, ['worktree', 'add', '--detach', dir, ref]);
    console.error(`OK: worktree created: ${dir}`);
  } else {
    const co = ['checkout', '--detach'];
    if (args.includes('--force')) {co.push('--force');}
    const res = git(dir, [...co, ref], { soft: true });
    if (!res.ok) {
      fail(`ERROR: could not move the worktree ${dir} to ${remote}/${branch}: ${res.err}\n  It has local changes. Re-run with --force to discard them.`, 2);
    }
    console.error(`OK: worktree reused: ${dir}`);
  }

  const extra = String(flagValue(args, '--copy') || '').split(',').map(x => x.trim()).filter(Boolean);
  const flavor = flavorOf(ctx, args);
  const wanted = [...(ctx.build.copyFiles || []), ...extra].map(f => expandBuild(f, flavor));
  for (const rel of [...new Set(wanted)]) {
    const src = path.resolve(ctx.root, rel);
    const dest = path.resolve(dir, rel);
    if (!dest.startsWith(dir + path.sep)) {fail(`ERROR: app.build.copyFiles entry "${rel}" points outside the worktree`);}
    if (!fs.existsSync(src)) {
      console.error(`WARN: app.build.copyFiles: ${rel} is not in the main checkout; the build may miss it`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
    const ignored = git(dir, ['check-ignore', '-q', rel], { soft: true }).ok;
    if (!ignored) {
      console.error(`WARN: ${rel} is not gitignored on ${branch}: it now shows as a change in the worktree. Never commit it.`);
    }
    console.error(`OK: copied ${rel}`);
  }

  writeJson(pointerFile(ctx), { branch, remote, dir, sha, preparedAt: new Date().toISOString() });
  console.log(`OK: ${branch} at ${short(sha)} ready in ${dir}`);
}

function currentWorktree(ctx, args) {
  const branch = flagValue(args, '--branch');
  if (branch) {
    const dir = worktreeDir(ctx, branch);
    if (!fs.existsSync(dir)) {fail(`ERROR: no worktree for ${branch}. Run build.js prepare --branch ${branch} first.`);}
    return { branch, dir };
  }
  const p = readJson(pointerFile(ctx));
  if (!p || !p.dir || !fs.existsSync(p.dir)) {fail('ERROR: no prepared worktree. Run build.js prepare --branch <b> first.');}
  return { branch: p.branch, dir: p.dir };
}

function adb(serial, argv) {
  const res = spawnSync('adb', [...(serial ? ['-s', serial] : []), ...argv], { encoding: 'utf8', timeout: 60000 });
  if (res.error) {return { ok: false, out: '', err: res.error.message };}
  return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`, err: res.stderr || '' };
}

function androidSerial(ctx, args) {
  const explicit = flagValue(args, '--serial') || process.env.ANDROID_SERIAL
    || (ctx.cfg.devices && ctx.cfg.devices.android && ctx.cfg.devices.android.udid);
  if (explicit) {return explicit;}
  const res = adb(null, ['devices']);
  const ids = res.out.split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(p => p[1] === 'device').map(p => p[0]);
  if (ids.length === 1) {return ids[0];}
  if (!ids.length) {fail('ERROR: no Android device is connected (adb devices lists none)');}
  return fail(`ERROR: ${ids.length} Android devices are connected (${ids.join(', ')}); pass --serial <id>`);
}

function flavorOf(ctx, args) {
  const env = process.env.QC_ENV;
  const flavors = (ctx.cfg.app && ctx.cfg.app.flavors) || {};
  return flagValue(args, '--flavor') || (env && flavors[env] ? env : ctx.cfg.app.defaultFlavor);
}

function runShell(command, cwd, env) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', d => { output += d; process.stdout.write(d); });
    child.stderr.on('data', d => { output += d; process.stderr.write(d); });
    child.on('error', err => resolve({ code: 127, output: `${output}\n${err.message}` }));
    child.on('close', code => resolve({ code: code === null ? 1 : code, output }));
  });
}

async function cmdRun(args) {
  const ctx = context();
  const platform = flagValue(args, '--platform');
  if (platform !== 'android' && platform !== 'ios') {fail('ERROR: run needs --platform android|ios');}
  const raw = ctx.build[platform];
  if (!raw) {fail(`ERROR: app.build.${platform} is empty in qc.config.json: there is no build command to run`);}
  const wt = currentWorktree(ctx, args);
  const flavor = flavorOf(ctx, args);
  const command = expandBuild(raw, flavor);
  const fl = (ctx.cfg.app.flavors || {})[flavor] || {};
  const sha = git(wt.dir, ['rev-parse', 'HEAD']).out;
  const stampPath = stampFile(ctx, wt.branch, platform);
  const stamp = readJson(stampPath);
  const installs = /\binstall\b/.test(command);

  let serial = null;
  let before = '';
  const current = { sha, flavor, command };
  if (platform === 'android') {
    if (!fl.androidPackage) {fail(`ERROR: app.flavors.${flavor}.androidPackage is missing: the install cannot be verified`);}
    serial = androidSerial(ctx, args);
    const res = adb(serial, ['shell', 'dumpsys', 'package', fl.androidPackage]);
    before = res.out;
    const parsed = parseDumpsys(before, fl.androidPackage);
    current.installed = parsed.installed;
    current.lastUpdateTime = parsed.lastUpdateTime;
  } else if (installs && fl.iosBundleId) {
    current.installed = iosInstalled(ctx, fl.iosBundleId).ok;
  }

  const decision = shouldSkip(stamp, current, { force: args.includes('--force') });
  if (decision.skip) {
    console.log(`OK: build skipped: ${decision.why} (${platform}, ${flavor}, ${wt.branch}). --force rebuilds.`);
    return;
  }
  console.error(`building ${wt.branch} at ${short(sha)} for ${platform} (${flavor}): ${decision.why}`);
  console.error(`  in   ${wt.dir}`);
  console.error(`  run  ${command}`);

  if (stamp) {fs.rmSync(stampPath, { force: true });}
  const env = { ...process.env };
  if (serial) {env.ANDROID_SERIAL = serial;} // a bare `adb install` then targets the right device
  const result = await runShell(command, wt.dir, env);
  if (result.code !== 0) {fail(`ERROR: the ${platform} build failed (exit ${result.code}); nothing was installed`, 3);}

  const record = { sha, flavor, command, platform, branch: wt.branch, builtAt: new Date().toISOString() };
  if (platform === 'android') {
    if (!installs) {
      console.error('WARN: app.build.android does not install the app, so the install was not verified');
    } else {
      const after = adb(serial, ['shell', 'dumpsys', 'package', fl.androidPackage]).out;
      const v = verifyAndroidInstall(before, after, result.output, fl.androidPackage);
      if (!v.ok) {
        for (const p of v.problems) {console.error(`ERROR: ${p}`);}
        fail(`ERROR: install NOT verified on ${serial}: do not test this device until it is fixed`, 5);
      }
      record.lastUpdateTime = v.after.lastUpdateTime;
      record.versionCode = v.after.versionCode;
      console.error(`OK: ${fl.androidPackage} updated on ${serial}: lastUpdateTime ${v.before.lastUpdateTime || '(not installed)'} -> ${v.after.lastUpdateTime}`);
    }
  } else if (installs) {
    if (!fl.iosBundleId) {
      console.error(`WARN: app.flavors.${flavor}.iosBundleId is missing, so the install was not verified`);
    } else {
      const v = iosInstalled(ctx, fl.iosBundleId);
      if (!v.ok) {fail(`ERROR: install NOT verified: xcrun simctl get_app_container ${v.target} ${fl.iosBundleId} failed: ${v.err}`, 5);}
      console.error(`OK: ${fl.iosBundleId} installed on ${v.target}: ${v.out}`);
    }
  }
  writeJson(stampPath, record);
  console.log(`OK: ${platform} build of ${wt.branch} at ${short(sha)} done`);
}

function iosInstalled(ctx, bundleId) {
  const ios = (ctx.cfg.devices && ctx.cfg.devices.ios) || {};
  const target = ios.udid || 'booted';
  if (ios.realDevice) {return { ok: true, target, out: 'real device: not checked' };}
  const res = spawnSync('xcrun', ['simctl', 'get_app_container', target, bundleId], { encoding: 'utf8', timeout: 60000 });
  return { ok: res.status === 0, target, out: String(res.stdout || '').trim(), err: String(res.stderr || (res.error && res.error.message) || '').trim() };
}

function ownWorktrees(ctx) {
  if (!fs.existsSync(ctx.cacheRoot)) {return [];}
  const real = safeReal(ctx.cacheRoot);
  return registeredWorktrees(ctx.root).filter(d => d.startsWith(real + path.sep));
}

function cmdStatus() {
  const ctx = context();
  const wts = ownWorktrees(ctx);
  console.log(`worktrees under ${ctx.cacheRoot}: ${wts.length || 'none'}`);
  for (const d of wts) {
    const head = git(d, ['rev-parse', '--short=10', 'HEAD'], { soft: true }).out;
    console.log(`  ${d}  ${head}`);
  }
  const stamps = path.join(ctx.cacheRoot, 'stamps');
  if (fs.existsSync(stamps)) {
    for (const f of fs.readdirSync(stamps)) {
      const s = readJson(path.join(stamps, f)) || {};
      console.log(`  built ${s.branch} ${s.platform} ${s.flavor} at ${short(s.sha)} (${s.builtAt})`);
    }
  }
}

function cmdClean(args) {
  const ctx = context();
  const branch = flagValue(args, '--branch');
  const targets = branch ? [safeReal(worktreeDir(ctx, branch))] : ownWorktrees(ctx);
  for (const d of targets) {
    // Only ever a worktree under our own cache dir, never the main checkout.
    if (!d.startsWith(safeReal(ctx.cacheRoot) + path.sep)) {continue;}
    const res = git(ctx.root, ['worktree', 'remove', '--force', d], { soft: true });
    if (res.ok) {console.log(`OK: removed ${d}`);}
    else {console.error(`WARN: could not remove ${d}: ${res.err}`);}
  }
  git(ctx.root, ['worktree', 'prune']);
  if (branch) {
    for (const p of ['android', 'ios']) {fs.rmSync(stampFile(ctx, branch, p), { force: true });}
    const ptr = readJson(pointerFile(ctx));
    if (ptr && ptr.branch === branch) {fs.rmSync(pointerFile(ctx), { force: true });}
  } else {
    fs.rmSync(ctx.cacheRoot, { recursive: true, force: true });
  }
  if (!targets.length) {console.log('OK: no worktrees to remove');}
}

function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(args.length ? 0 : 1);
  }
  const cmds = { prepare: cmdPrepare, run: cmdRun, status: cmdStatus, clean: cmdClean };
  const cmd = cmds[args[0]];
  if (!cmd) {fail(`ERROR: unknown command "${args[0]}"\n\n${HELP}`);}
  Promise.resolve(cmd(args)).catch(err => fail(`ERROR: ${err && err.message ? err.message : String(err)}`));
}

if (require.main === module) {
  main(process.argv.slice(2));
}
