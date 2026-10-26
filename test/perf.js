#!/usr/bin/env node
'use strict';

// Perf and memory probes with no device: the dumpsys / am parsers against
// captured output (a trimmed real capture from an API 37 emulator running a
// Flutter debug build, plus older formats), the threshold judges, the step
// splitter, and driver.js perf / mem / startup / leak-loop / key end to end
// with adb stubbed out.
//
//   node test/perf.js

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRIVER = path.join(ROOT, 'runtime', 'driver.js');
const device = require(path.join(ROOT, 'runtime', 'device.js'));

let failures = 0;
let checks = 0;

async function check(name, fn) {
  checks += 1;
  try {
    await fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${String(err.message).split('\n')[0]}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) {throw new Error(msg);}
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {throw new Error(`${msg}: expected ${e}, got ${a}`);}
}

// --- fixtures ------------------------------------------------------------------

// Real capture (API 37 emulator, Flutter debug build), package renamed and
// the trailing buffer / database sections trimmed. Flutter draws into a
// SurfaceView, so HWUI saw only 9 frames.
const GFX_FLUTTER_REAL = `Applications Graphics Acceleration Info:
Uptime: 7739337 Realtime: 7739337

** Graphics info for pid 3218 [com.example.app] **

Stats since: 92837868418ns
Total frames rendered: 9
Janky frames: 9 (100.00%)
Janky frames (legacy): 8 (88.89%)
50th percentile: 300ms
90th percentile: 3750ms
95th percentile: 3750ms
99th percentile: 3750ms
Number Missed Vsync: 6
Number High input latency: 0
Number Slow UI thread: 7
Number Slow bitmap uploads: 3
Number Slow issue draw commands: 9
Number Frame deadline missed: 9
Number Frame deadline missed (legacy): 8
HISTOGRAM: 5ms=0 6ms=0 31ms=1 125ms=1 150ms=1 250ms=1 300ms=1 400ms=1 1350ms=1 1400ms=1 3750ms=1 4950ms=0
50th gpu percentile: 4950ms
90th gpu percentile: 4950ms
95th gpu percentile: 4950ms
99th gpu percentile: 4950ms
GPU HISTOGRAM: 1ms=0 19ms=1 24ms=1 4950ms=7

Pipeline=Skia (OpenGL)
GraphicBufferAllocator buffers:
            Handle |         Size |     W (Stride) x H | Layers |   Format |      Usage | Requestor
0xb4000071d4e264a0 |      unknown | 1080 (   0) x 2400 |      1 |        1 | 0x     b00 | 287f83a SurfaceView[com.example.app/com.example.app.MainActivity]#3(BLAST Consumer)3
0xb4000071d4e44ff0 |      unknown | 1080 (   0) x 2400 |      1 |        1 | 0x     b00 | VRI[MainActivity]#2(BLAST Consumer)2

Profile data in ms:

	com.example.app/com.example.app.MainActivity/android.view.ViewRootImpl@671ae63 (visibility=0)
View hierarchy:

  com.example.app/com.example.app.MainActivity/android.view.ViewRootImpl@671ae63
  6 views, 11.21 kB of render nodes
`;

// The same app right after `gfxinfo reset` and a scroll: zero frames, and the
// empty histogram reports its top bucket for every percentile (real capture).
const GFX_ZERO = `** Graphics info for pid 11147 [com.example.app] **

Stats since: 7801234567890ns
Total frames rendered: 0
Janky frames: 0 (0.00%)
Janky frames (legacy): 0 (0.00%)
50th percentile: 4950ms
90th percentile: 4950ms
95th percentile: 4950ms
99th percentile: 4950ms
Number Missed Vsync: 0
Number High input latency: 0
Number Slow UI thread: 0
Number Slow bitmap uploads: 0
Number Slow issue draw commands: 0
Number Frame deadline missed: 0
`;

// A view-based app on API 29 (no "Frame deadline missed" line yet).
const GFX_VIEWS_API29 = `Applications Graphics Acceleration Info:
Uptime: 2345678 Realtime: 2345678

** Graphics info for pid 4321 [com.example.app] **

Stats since: 1234567890ns
Total frames rendered: 1240
Janky frames: 62 (5.00%)
50th percentile: 9ms
90th percentile: 14ms
95th percentile: 19ms
99th percentile: 42ms
Number Missed Vsync: 11
Number High input latency: 2
Number Slow UI thread: 30
Number Slow bitmap uploads: 4
Number Slow issue draw commands: 17
HISTOGRAM: 5ms=120 6ms=200 7ms=180
Pipeline=Skia (OpenGL)
`;

// Real capture (API 37), package renamed, Native Allocations / SQL /
// DATABASES / Asset Allocations trimmed.
const MEM_API37_REAL = `Applications Memory Usage (in Kilobytes):
Uptime: 7737696 Realtime: 7737696

** MEMINFO in pid 3218 [com.example.app] **
                   Pss  Private  Private  SwapPss      Rss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty    Total     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------   ------
  Native Heap    49289    49240        0        0    53148   128776    56600    67267
  Dalvik Heap     6261     6136        0        0    14080    11704     5852     5852
 Dalvik Other    14399     5960        0        0    23332
        Stack     2540     2540        0        0     2544
      Unknown   189157   188896      248        0   190872
        TOTAL   469671   326536   123036        8   621444   140480    62452    73119

 App Summary
                       Pss(KB)                        Rss(KB)
                        ------                         ------
           Java Heap:    14400                          38320
         Native Heap:    49240                          53148
                Code:    94844                         224284
               Stack:     2540                           2544
            Graphics:        0                              0
       Private Other:   288548
              System:    20099
             Unknown:                                  303148

           TOTAL PSS:   469671            TOTAL RSS:   621444       TOTAL SWAP PSS:        8

 Objects
               Views:        6         ViewRootImpl:        1
         AppContexts:       16           Activities:        1
              Assets:       42        AssetManagers:        0
       Local Binders:       38        Proxy Binders:       72
       Parcel memory:       18         Parcel count:       72
    Death Recipients:        1             WebViews:        0

 Native Allocations
                         Count                       Total(kB)
                        ------                         ------
    Other (malloced):      332                             30
`;

// API 26-29: one TOTAL line, no RSS column in the summary.
const MEM_OLD = `Applications Memory Usage (in Kilobytes):
Uptime: 1234567 Realtime: 1234567

** MEMINFO in pid 2468 [com.example.app] **
                   Pss  Private  Private  SwapPss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------
  Native Heap    11292    11248        0        0    24576    14882     9693
  Dalvik Heap     5940     5896        0        0     9832     4916     4916
        TOTAL    47669    31480     9356      142    34408    19798    14609

 App Summary
                       Pss(KB)
                        ------
           Java Heap:     5940
         Native Heap:    11292
                Code:    11004
               Stack:      752
            Graphics:     8960
       Private Other:     3208
              System:     6513

               TOTAL:    47669       TOTAL SWAP PSS:      142

 Objects
               Views:      112         ViewRootImpl:        2
         AppContexts:        4           Activities:        2
              Assets:        8        AssetManagers:        0
       Local Binders:       24        Proxy Binders:       31
       Parcel memory:        9         Parcel count:       38
    Death Recipients:        0      OpenSSL Sockets:        0
            WebViews:        1
`;

// Real capture: SurfaceFlinger layer list on API 37.
const SF_LIST_API37 = `RequestedLayerState{Background for 287f83a SurfaceView[com.example.app/com.example.app.MainActivity]#168 parentId=166 relativeParentId=164 z=-2147483648}
RequestedLayerState{140cd83 ActivityRecordInputSink com.example.app/com.example.app.MainActivity#119 parentId=113 z=-2147483648}
RequestedLayerState{287f83a SurfaceView[com.example.app/com.example.app.MainActivity](BLAST)#167 parentId=166}
RequestedLayerState{287f83a SurfaceView[com.example.app/com.example.app.MainActivity]#166 parentId=165 relativeParentId=164 z=-2}
RequestedLayerState{5a51cce com.example.app/com.example.app.MainActivity#120 parentId=113}
RequestedLayerState{VRI-com.example.app/com.example.app.MainActivity#164 parentId=120}
RequestedLayerState{Bounds for - com.example.app/com.example.app.MainActivity#165 parentId=164}
RequestedLayerState{StatusBar#80 parentId=12}
`;

// Older releases: bare layer names.
const SF_LIST_OLD = `com.android.systemui.ImageWallpaper#0
SurfaceView - com.example.app/com.example.app.MainActivity#0
com.example.app/com.example.app.MainActivity#0
StatusBar#0
`;

// 60 Hz, 12 frames at a smooth 16.7ms then 3 slow ones, a 2s idle gap,
// and a pending fence row (INT64_MAX) that must be ignored.
function sfLatency() {
  const rows = ['16666666'];
  let t = 1000000000000;
  const gaps = [16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 50, 33.4, 66.8, 2000, 16.7];
  rows.push(`${t - 5000000}\t${t}\t${t - 4000000}`);
  for (const g of gaps) {
    t += Math.round(g * 1e6);
    rows.push(`${t - 5000000}\t${t}\t${t - 4000000}`);
  }
  rows.push('9223372036854775807\t9223372036854775807\t9223372036854775807');
  rows.push('0\t0\t0');
  return `${rows.join('\n')}\n`;
}

const AM_COLD = `Starting: Intent { cmp=com.example.app/.MainActivity }
Status: ok
LaunchState: COLD
Activity: com.example.app/.MainActivity
TotalTime: 1234
WaitTime: 1240
Complete
`;

// Real capture shape: a debug build that took longer than am's wait.
const AM_TIMEOUT = `Starting: Intent { cmp=com.example.app/com.example.app.MainActivity }
Status: timeout
LaunchState: UNKNOWN (-1)
Activity: com.example.app/com.example.app.MainActivity
WaitTime: 17391
Complete
`;

const AM_DELIVERED = `Starting: Intent { cmp=com.example.app/com.example.app.MainActivity }
Warning: Activity not started, intent has been delivered to currently running top-most instance.
Status: ok
LaunchState: UNKNOWN (0)
Activity: com.example.app/com.example.app.MainActivity
TotalTime: 0
WaitTime: 29
Complete
`;

const AM_OLD = `Starting: Intent { cmp=com.example.app/.MainActivity }
Status: ok
Activity: com.example.app/.MainActivity
ThisTime: 812
TotalTime: 812
WaitTime: 830
Complete
`;

const PKG_DEBUG = `Packages:
  Package [com.example.app] (2a1b3c4):
    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]
    pkgFlags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]
`;
const PKG_RELEASE = `Packages:
  Package [com.example.app] (2a1b3c4):
    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]
    privateFlags=[ PRIVATE_FLAG_ACTIVITIES_RESIZE_MODE_RESIZEABLE ]
`;

const RESUMED_APP = '    topResumedActivity=ActivityRecord{242963129 u0 com.example.app/com.example.app.MainActivity t32}\n  ResumedActivity: ActivityRecord{242963129 u0 com.example.app/com.example.app.MainActivity t32}\n';
const RESUMED_LAUNCHER = '    topResumedActivity=ActivityRecord{11994414 u0 com.example.launcher/.LauncherActivity t2}\n';

// --- pure checks -------------------------------------------------------------------

async function pureChecks() {
  console.log('\nframe stats');

  await check('parseGfxinfo reads a real Flutter capture, keeping legacy lines apart', () => {
    const g = device.parseGfxinfo(GFX_FLUTTER_REAL);
    eq([g.pid, g.pkg, g.totalFrames, g.jankyFrames, g.jankyPct], [3218, 'com.example.app', 9, 9, 100], 'header');
    eq([g.p50Ms, g.p90Ms, g.p95Ms, g.p99Ms], [300, 3750, 3750, 3750], 'percentiles');
    eq([g.missedVsync, g.highInputLatency, g.slowUiThread, g.slowBitmapUploads, g.slowIssueDrawCommands, g.frameDeadlineMissed],
      [6, 0, 7, 3, 9, 9], 'counters');
    assert(g.surfaceView === true, 'SurfaceView not detected');
  });

  await check('parseGfxinfo on API 29 view data: no deadline line is null', () => {
    const g = device.parseGfxinfo(GFX_VIEWS_API29);
    eq([g.totalFrames, g.jankyPct, g.p90Ms, g.frameDeadlineMissed, g.surfaceView], [1240, 5, 14, null, false], 'fields');
  });

  await check('parseGfxinfo with zero frames nulls the 4950ms empty-histogram percentiles', () => {
    const g = device.parseGfxinfo(GFX_ZERO);
    eq([g.totalFrames, g.p50Ms, g.p90Ms, g.p99Ms], [0, null, null, null], 'zero');
  });

  await check('parseGfxinfo: "No process found" and garbage', () => {
    assert(device.parseGfxinfo('No process found for: com.example.app\n').noProcess, 'noProcess');
    assert(device.parseGfxinfo('something else').unparsed, 'unparsed');
  });

  await check('judgePerf: ok, fail on jank, fail on p90, insufficient under 10 frames', () => {
    const lim = { maxJankPct: 10, maxP90Ms: 32 };
    eq(device.judgePerf(device.parseGfxinfo(GFX_VIEWS_API29), lim).verdict, 'ok', 'views');
    const jank = device.judgePerf({ totalFrames: 100, jankyPct: 12.5, p90Ms: 20 }, lim);
    assert(jank.verdict === 'fail' && /janky frames 12.5% > 10%/.test(jank.reasons[0]), JSON.stringify(jank));
    const slow = device.judgePerf({ totalFrames: 100, jankyPct: 2, p90Ms: 40 }, lim);
    assert(slow.verdict === 'fail' && /90th percentile 40ms > 32ms/.test(slow.reasons[0]), JSON.stringify(slow));
    eq(device.judgePerf(device.parseGfxinfo(GFX_FLUTTER_REAL), lim).verdict, 'insufficient', 'flutter');
    eq(device.judgePerf(device.parseGfxinfo(GFX_ZERO), lim).verdict, 'insufficient', 'zero');
    eq(device.judgePerf({ totalFrames: 100, jankyPct: 10, p90Ms: 32 }, lim).verdict, 'ok', 'limits are inclusive');
  });

  await check('parseSfLayers + pickSfLayer pick the Flutter SurfaceView buffer layer (API 37 and old)', () => {
    eq(device.pickSfLayer(device.parseSfLayers(SF_LIST_API37), 'com.example.app'),
      '287f83a SurfaceView[com.example.app/com.example.app.MainActivity](BLAST)#167', 'api37');
    eq(device.pickSfLayer(device.parseSfLayers(SF_LIST_OLD), 'com.example.app'),
      'SurfaceView - com.example.app/com.example.app.MainActivity#0', 'old');
    eq(device.pickSfLayer(device.parseSfLayers(SF_LIST_API37), 'com.example.other'), null, 'none');
  });

  await check('parseSfLatency: frame gaps, idle gap and pending fences excluded, jank over 1.5 vsync', () => {
    const s = device.parseSfLatency(sfLatency());
    eq([s.refreshMs, s.totalFrames, s.jankyFrames], [16.7, 15, 3], 'counts');
    eq([s.p50Ms, s.p90Ms], [16.7, 50], 'percentiles');
  });

  console.log('\nmemory');

  await check('parseMeminfo reads a real API 37 App Summary and Objects', () => {
    const m = device.parseMeminfo(MEM_API37_REAL);
    eq([m.pid, m.pkg], [3218, 'com.example.app'], 'head');
    eq(m.summary, {
      javaHeap: 14400, nativeHeap: 49240, code: 94844, stack: 2540, graphics: 0, privateOther: 288548,
      system: 20099, totalPss: 469671, totalRss: 621444, totalSwapPss: 8,
    }, 'summary');
    eq([m.objects.views, m.objects.viewRootImpl, m.objects.appContexts, m.objects.activities, m.objects.assets,
      m.objects.localBinders, m.objects.proxyBinders, m.objects.parcelMemory, m.objects.deathRecipients, m.objects.webViews],
    [6, 1, 16, 1, 42, 38, 72, 18, 1, 0], 'objects');
  });

  await check('parseMeminfo reads the older "TOTAL:" format', () => {
    const m = device.parseMeminfo(MEM_OLD);
    eq([m.summary.totalPss, m.summary.totalSwapPss, m.summary.totalRss, m.summary.graphics], [47669, 142, undefined, 8960], 'summary');
    eq([m.objects.activities, m.objects.viewRootImpl, m.objects.webViews], [2, 2, 1], 'objects');
  });

  await check('parseMeminfo: "No process found"', () => {
    assert(device.parseMeminfo('No process found for: com.example.app\n').noProcess, 'noProcess');
    assert(device.parseMeminfo('Applications Memory Usage (in Kilobytes):\n').unparsed, 'partial dump is unparsed');
  });

  const snap = (pss, objects = {}) => ({ summary: { totalPss: pss, javaHeap: 1000 }, objects: { activities: 1, viewRootImpl: 1, appContexts: 4, views: 10, ...objects } });

  await check('compareMem passes small growth, reports deltas', () => {
    const r = device.compareMem(snap(400000), snap(400000 + 10 * 1024, { views: 14 }), { maxGrowthMb: 25 });
    assert(!r.failed, r.reasons.join('; '));
    eq([r.growthKb, r.growthPct], [10240, 2.6], 'growth');
    eq(r.objects.find(o => o.key === 'views').delta, 4, 'views delta');
  });

  await check('compareMem fails over maxGrowthMb and over maxGrowthPct', () => {
    const mbFail = device.compareMem(snap(400000), snap(400000 + 30 * 1024), { maxGrowthMb: 25 });
    assert(mbFail.failed && /grew 30.0 MB > 25 MB/.test(mbFail.reasons[0]), mbFail.reasons.join());
    const pctFail = device.compareMem(snap(100000), snap(115000), { maxGrowthMb: 25, maxGrowthPct: 10 });
    assert(pctFail.failed && /15% > 10%/.test(pctFail.reasons[0]), pctFail.reasons.join());
  });

  await check('compareMem fails when Activities / ViewRootImpl / AppContexts grow, even with flat PSS', () => {
    const r = device.compareMem(snap(400000), snap(399000, { activities: 3, viewRootImpl: 2 }), { maxGrowthMb: 25 });
    assert(r.failed, 'should fail');
    assert(r.reasons.some(x => /activities grew 1 -> 3/.test(x)) && r.reasons.some(x => /viewRootImpl/.test(x)), r.reasons.join('; '));
    assert(!device.compareMem(snap(1), snap(1, { activities: 0 })).failed, 'shrink is fine');
  });

  await check('compareMem notes a swap shift (TOTAL PSS includes SwapPss)', () => {
    const a = { summary: { totalPss: 400000, totalSwapPss: 0 }, objects: {} };
    const b = { summary: { totalPss: 410000, totalSwapPss: 150000 }, objects: {} };
    const r = device.compareMem(a, b, { maxGrowthMb: 25 });
    assert(!r.failed && r.notes.length === 1 && /swap changed by \+146\.5 MB/.test(r.notes[0]), JSON.stringify(r.notes));
    eq(device.compareMem(snap(1), snap(1)).notes, [], 'no swap, no note');
  });

  await check('compareMem on parsed real and old snapshots', () => {
    const r = device.compareMem(device.parseMeminfo(MEM_OLD), device.parseMeminfo(MEM_API37_REAL), { maxGrowthMb: 25 });
    assert(r.failed && r.reasons.some(x => /AppContexts|appContexts/.test(x)), r.reasons.join('; '));
  });

  console.log('\nstartup, steps, helpers');

  await check('parseAmStartW: cold, timeout, delivered, old ThisTime', () => {
    const c = device.parseAmStartW(AM_COLD);
    eq([c.status, c.launchState, c.totalTime, c.waitTime, c.delivered], ['ok', 'COLD', 1234, 1240, false], 'cold');
    const t = device.parseAmStartW(AM_TIMEOUT);
    eq([t.status, t.launchState, t.totalTime, t.waitTime], ['timeout', 'UNKNOWN', null, 17391], 'timeout');
    eq(device.parseAmStartW(AM_DELIVERED).delivered, true, 'delivered');
    eq(device.parseAmStartW(AM_OLD).thisTime, 812, 'thisTime');
    eq(device.parseAmStartW('Error: Activity class {com.example.app/.X} does not exist.\n').error,
      'Error: Activity class {com.example.app/.X} does not exist.', 'error');
  });

  await check('isDebuggable and parseResumedActivity', () => {
    eq([device.isDebuggable(PKG_DEBUG), device.isDebuggable(PKG_RELEASE)], [true, false], 'debuggable');
    eq(device.parseResumedActivity(RESUMED_APP), 'com.example.app/com.example.app.MainActivity', 'app');
    eq(device.parseResumedActivity('  mResumedActivity: ActivityRecord{7d1 u0 com.example.app/.Main t5}\n'), 'com.example.app/.Main', 'old');
    eq(device.parseResumedActivity(''), null, 'none');
  });

  await check('median and percentile', () => {
    eq([device.median([3, 1, 2]), device.median([4, 1, 3, 2]), device.median([]), device.median([5, 'x', null])], [2, 2.5, null, 5], 'median');
    eq([device.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), device.percentile([7], 50)], [9, 7], 'percentile');
  });

  await check('splitSteps splits on ; and whitespace outside quotes', () => {
    eq(device.splitSteps('open-url --url https://example.com/p/1; back'), [['open-url', '--url', 'https://example.com/p/1'], ['back']], 'plain');
    eq(device.splitSteps(`tap --text "Add to cart"; input --selector q --text 'a;b "c"'`),
      [['tap', '--text', 'Add to cart'], ['input', '--selector', 'q', '--text', 'a;b "c"']], 'quotes');
    eq(device.splitSteps('tap --text "say \\"hi\\""; ; key --code BACK ;'), [['tap', '--text', 'say "hi"'], ['key', '--code', 'BACK']], 'escapes and empty steps');
    eq(device.splitSteps(`tap --text ''`), [['tap', '--text', '']], 'empty quoted word kept');
    let threw = false;
    try {
      device.splitSteps('tap --text "open');
    } catch {
      threw = true;
    }
    assert(threw, 'unterminated quote should throw');
  });

  await check('keyEventArg maps names, numbers and KEYCODE_*, rejects the rest', () => {
    eq(['BACK', 'home', '4', 'KEYCODE_VOLUME_UP', 'rm -rf', ''].map(device.keyEventArg), ['4', '3', '4', 'KEYCODE_VOLUME_UP', null, null], 'keys');
  });
}

// --- driver.js with adb stubbed ------------------------------------------------------

// Loaded through NODE_OPTIONS, so leak-loop's child processes get it too.
// adb answers come from QC_TEST_ADB (JSON: substring -> output, or a list
// served in order across processes); every call is logged.
const HOOK = `
const cp = require('child_process');
const fs = require('fs');
const realExecFileSync = cp.execFileSync;
const log = process.env.QC_TEST_SPAWN_LOG;
const record = (bin, argv) => fs.appendFileSync(log, JSON.stringify([bin, ...(argv || [])]) + '\\n');
const answers = JSON.parse(fs.readFileSync(process.env.QC_TEST_ADB, 'utf8'));
const counter = process.env.QC_TEST_ADB + '.n';
function served(key) {
  const v = answers[key];
  if (!Array.isArray(v)) return v;
  let n = {};
  try { n = JSON.parse(fs.readFileSync(counter, 'utf8')); } catch (_) {}
  const i = n[key] || 0;
  n[key] = i + 1;
  fs.writeFileSync(counter, JSON.stringify(n));
  return v[Math.min(i, v.length - 1)];
}
cp.execFileSync = (bin, argv, opts) => {
  if (bin === process.execPath) return realExecFileSync(bin, argv, opts);
  record(bin, argv);
  if (bin !== 'adb') { throw Object.assign(new Error('blocked in test: ' + bin), { code: 'ENOENT' }); }
  const a = argv.join(' ');
  if (a === 'devices') return 'List of devices attached\\nemulator-5554\\tdevice\\nemulator-5556\\tdevice\\n';
  if (a.includes('ro.boot.qemu.avd_name')) return argv[1] === 'emulator-5554' ? 'Example_Phone_API_35\\n' : 'Other_Lane\\n';
  for (const key of Object.keys(answers)) {
    if (a.includes(key)) return served(key);
  }
  return '';
};
cp.spawn = (bin, argv) => { record(bin, argv); throw new Error('spawn blocked in test'); };
`;

function makeHost() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-perf-test-'));
  fs.writeFileSync(path.join(dir, 'qc.config.json'), JSON.stringify({
    project: { name: 'Example', reportsDir: 'qc-reports' },
    app: {
      defaultFlavor: 'staging',
      androidActivity: '.MainActivity',
      flavors: { staging: { androidPackage: 'com.example.app', iosBundleId: 'com.example.app' } },
    },
    devices: {
      android: { enabled: true, avd: 'Example_Phone_API_35' },
      ios: { enabled: true, deviceName: 'iPhone', udid: '' },
      appium: { host: '127.0.0.1', port: 1 },
    },
    perf: { maxP90Ms: 20 },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'hook.js'), HOOK);
  const runDir = path.join(dir, 'qc-reports', 'T-1', 'staging', 'run1');
  fs.mkdirSync(runDir, { recursive: true });
  return { dir, runDir, spawnLog: path.join(dir, 'spawn.log'), adbFile: path.join(dir, 'adb.json') };
}

function runDriver(host, args, adbAnswers, { run = true } = {}) {
  fs.writeFileSync(host.adbFile, JSON.stringify(adbAnswers));
  fs.rmSync(`${host.adbFile}.n`, { force: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) {if (/^QC_/.test(k)) {delete env[k];}}
  Object.assign(env, {
    QC_SESSION_FILE: path.join(host.dir, 'session.json'),
    QC_TEST_SPAWN_LOG: host.spawnLog,
    QC_TEST_ADB: host.adbFile,
    NODE_OPTIONS: `--require ${path.join(host.dir, 'hook.js')}`,
  });
  if (run) {env.QC_RUN_DIR = host.runDir;}
  return new Promise(resolve => {
    execFile(process.execPath, [DRIVER, ...args], { cwd: host.dir, env, encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ status: err ? (err.code === undefined ? 1 : err.code) : 0, out: `${stdout}${stderr}` });
    });
  });
}

function bumpMem(text, totalPss, activities) {
  return text.replace(/TOTAL PSS:\s+\d+/, `TOTAL PSS:   ${totalPss}`).replace(/Activities:\s+\d+/, `Activities:        ${activities}`);
}

async function endToEnd() {
  console.log('\ndriver.js perf / mem / startup / leak-loop (adb stubbed)');
  const host = makeHost();
  const base = {
    'dumpsys package': PKG_RELEASE,
    ResumedActivity: RESUMED_APP,
    pidof: '3218\n',
  };
  try {
    await check('perf: OK within limits, saves gfx-<label>.json in <run>/perf', async () => {
      const r = await runDriver(host, ['perf', '--label', 'home', '--max-p90', '32'], { ...base, 'dumpsys gfxinfo': GFX_VIEWS_API29 });
      assert(r.status === 0 && /^OK: frames within limits/m.test(r.out), `${r.status}: ${r.out}`);
      const saved = JSON.parse(fs.readFileSync(path.join(host.runDir, 'perf', 'gfx-home.json'), 'utf8'));
      eq([saved.verdict, saved.stats.totalFrames, saved.limits.maxP90Ms], ['ok', 1240, 32], 'saved');
    });

    await check('perf: config.perf.maxP90Ms applies without a flag -> FAIL exit 3', async () => {
      const gfx = GFX_VIEWS_API29.replace('90th percentile: 14ms', '90th percentile: 25ms');
      const r = await runDriver(host, ['perf'], { ...base, 'dumpsys gfxinfo': gfx });
      assert(r.status === 3 && /^FAIL: 90th percentile 25ms > 20ms/m.test(r.out), `${r.status}: ${r.out}`);
    });

    await check('perf: over a limit on a release build is FAIL exit 3; debug build is WARN exit 2', async () => {
      const r = await runDriver(host, ['perf', '--max-jank', '1'], { ...base, 'dumpsys gfxinfo': GFX_VIEWS_API29 });
      assert(r.status === 3 && /^FAIL: janky frames 5% > 1%/m.test(r.out), `${r.status}: ${r.out}`);
      const d = await runDriver(host, ['perf', '--max-jank', '1'], { ...base, 'dumpsys package': PKG_DEBUG, 'dumpsys gfxinfo': GFX_VIEWS_API29 });
      assert(d.status === 2 && /^WARN: over the limits .*debug build/m.test(d.out), `${d.status}: ${d.out}`);
    });

    await check('perf: too few frames (Flutter) is WARN exit 2, points at --source surfaceflinger, still saves', async () => {
      const r = await runDriver(host, ['perf', '--label', 'flutter'], { ...base, 'dumpsys gfxinfo': GFX_FLUTTER_REAL });
      assert(r.status === 2 && /WARN: not enough data - only 9 frame/.test(r.out) && /--source surfaceflinger/.test(r.out), `${r.status}: ${r.out}`);
      assert(fs.existsSync(path.join(host.runDir, 'perf', 'gfx-flutter.json')), 'not saved');
    });

    await check('perf --source surfaceflinger reads the SurfaceView layer', async () => {
      const r = await runDriver(host, ['perf', '--source', 'surfaceflinger', '--max-jank', '50', '--max-p90', '60'],
        { ...base, 'SurfaceFlinger --list': SF_LIST_API37, 'SurfaceFlinger --latency': sfLatency() });
      assert(r.status === 0 && /layer 287f83a SurfaceView\[com.example.app/.test(r.out) && /frames: 15 /.test(r.out), `${r.status}: ${r.out}`);
      const calls = fs.readFileSync(host.spawnLog, 'utf8');
      assert(calls.includes("--latency '287f83a SurfaceView[com.example.app/com.example.app.MainActivity](BLAST)#167'"), 'layer not quoted');
    });

    await check('perf --reset resets gfxinfo; not running is an error', async () => {
      const r = await runDriver(host, ['perf', '--reset'], { ...base, 'gfxinfo': '' });
      assert(r.status === 0 && /^OK: frame stats reset/m.test(r.out), r.out);
      const n = await runDriver(host, ['perf'], { ...base, 'dumpsys gfxinfo': 'No process found for: com.example.app\n' });
      assert(n.status === 1 && /not running/.test(n.out), n.out);
    });

    await check('perf / mem / startup / leak-loop / key say WARN and exit 2 on iOS', async () => {
      for (const c of [['perf'], ['mem'], ['startup'], ['leak-loop', '--steps', 'back'], ['key', '--code', 'BACK']]) {
        const r = await runDriver(host, [...c, '--platform', 'ios'], base);
        assert(r.status === 2 && /^WARN: .*Android-only/m.test(r.out), `${c[0]}: ${r.status} ${r.out}`);
      }
    });

    await check('mem prints MB, saves mem-<label>.json, --gc sends a trim request, never a signal', async () => {
      fs.writeFileSync(host.spawnLog, '');
      const r = await runDriver(host, ['mem', '--gc', '--label', 'a'], { ...base, 'dumpsys meminfo': MEM_API37_REAL });
      assert(r.status === 0 && /TOTAL PSS\s+458\.7/.test(r.out) && /Activities 1/.test(r.out), `${r.status}: ${r.out}`);
      const saved = JSON.parse(fs.readFileSync(path.join(host.runDir, 'perf', 'mem-a.json'), 'utf8'));
      eq([saved.summary.totalPss, saved.foreground, saved.gc], [469671, true, true], 'saved');
      const calls = fs.readFileSync(host.spawnLog, 'utf8');
      assert(calls.includes('send-trim-memory') && !/\bkill\b/.test(calls), calls);
    });

    await check('mem without a run warns and does not save; No process found is an error', async () => {
      const r = await runDriver(host, ['mem', '--label', 'x'], { ...base, 'dumpsys meminfo': MEM_API37_REAL }, { run: false });
      assert(r.status === 0 && /WARN: no QC run in progress/.test(r.out), r.out);
      const n = await runDriver(host, ['mem'], { ...base, 'dumpsys meminfo': 'No process found for: com.example.app\n' });
      assert(n.status === 1 && /No process found/.test(n.out), n.out);
    });

    await check('mem warns when the app is in the background', async () => {
      const r = await runDriver(host, ['mem'], { ...base, ResumedActivity: RESUMED_LAUNCHER, 'dumpsys meminfo': MEM_API37_REAL });
      assert(/WARN: .*not in the foreground/.test(r.out), r.out);
    });

    await check('mem --compare a --to b: OK, then FAIL exit 3 on Activity growth and on MB growth', async () => {
      await runDriver(host, ['mem', '--label', 'b'], { ...base, 'dumpsys meminfo': bumpMem(MEM_API37_REAL, 470000, 1) });
      const ok = await runDriver(host, ['mem', '--compare', 'a', '--to', 'b'], base);
      assert(ok.status === 0 && /^OK: TOTAL PSS \+0\.3 MB/m.test(ok.out), `${ok.status}: ${ok.out}`);
      await runDriver(host, ['mem', '--label', 'c'], { ...base, 'dumpsys meminfo': bumpMem(MEM_API37_REAL, 470000, 3) });
      const leak = await runDriver(host, ['mem', '--compare', 'a', '--to', 'c'], base);
      assert(leak.status === 3 && /^FAIL: activities grew 1 -> 3/m.test(leak.out), `${leak.status}: ${leak.out}`);
      const grow = await runDriver(host, ['mem', '--compare', 'a', '--max-growth-mb', '5'], { ...base, 'dumpsys meminfo': bumpMem(MEM_API37_REAL, 469671 + 8 * 1024, 1) });
      assert(grow.status === 3 && /^FAIL: TOTAL PSS grew 8\.0 MB > 5 MB/m.test(grow.out), `${grow.status}: ${grow.out}`);
      await runDriver(host, ['mem', '--label', 'other-pid'], { ...base, 'dumpsys meminfo': MEM_API37_REAL.replace('pid 3218', 'pid 4000') });
      const restarted = await runDriver(host, ['mem', '--compare', 'a', '--to', 'other-pid'], base);
      assert(restarted.status === 2 && /WARN: the app restarted/.test(restarted.out) && !/^FAIL/m.test(restarted.out), `${restarted.status}: ${restarted.out}`);
      const missing = await runDriver(host, ['mem', '--compare', 'nope'], base);
      assert(missing.status === 1 && /mem-nope.json not found/.test(missing.out), missing.out);
    });

    await check('startup: force-stop + am start -W per run, median, OK under the limit', async () => {
      fs.writeFileSync(host.spawnLog, '');
      const r = await runDriver(host, ['startup', '--times', '3'], { ...base, 'am start -W': [AM_COLD, AM_TIMEOUT.replace('17391', '900'), AM_OLD] });
      assert(r.status === 0 && /^OK: median cold start 900ms <= 4000ms/m.test(r.out), `${r.status}: ${r.out}`);
      const calls = fs.readFileSync(host.spawnLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      eq(calls.filter(c => c.join(' ').includes('force-stop')).length, 3, 'force-stops');
      assert(calls.some(c => c.join(' ').includes("am start -W -n 'com.example.app/.MainActivity'")), 'component');
    });

    await check('startup: over the limit is FAIL exit 3 (release) and WARN exit 2 (debug)', async () => {
      const r = await runDriver(host, ['startup', '--times', '1', '--max-ms', '1000'], { ...base, 'am start -W': AM_COLD });
      assert(r.status === 3 && /^FAIL: median cold start 1234ms > 1000ms/m.test(r.out), `${r.status}: ${r.out}`);
      const d = await runDriver(host, ['startup', '--times', '1', '--max-ms', '1000'], { ...base, 'dumpsys package': PKG_DEBUG, 'am start -W': AM_COLD });
      assert(d.status === 2 && /debug build/.test(d.out), `${d.status}: ${d.out}`);
    });

    await check('key sends an adb keyevent on the pinned serial; bad codes are refused', async () => {
      fs.writeFileSync(host.spawnLog, '');
      const r = await runDriver(host, ['key', '--code', 'BACK'], base);
      assert(r.status === 0 && /OK: key BACK/.test(r.out), r.out);
      const calls = fs.readFileSync(host.spawnLog, 'utf8');
      assert(calls.includes('["adb","-s","emulator-5554","shell","input","keyevent","4"]'), calls);
      const bad = await runDriver(host, ['key', '--code', 'x;reboot'], base);
      assert(bad.status === 1 && /Usage: key/.test(bad.out), bad.out);
    });

    await check('leak-loop: warm-up, baseline, n iterations as child processes, compare -> OK', async () => {
      const r = await runDriver(host, ['leak-loop', '--steps', 'sleep --ms 1; key --code BACK', '--times', '3', '--label', 'pdp'],
        { ...base, 'dumpsys meminfo': [MEM_API37_REAL, bumpMem(MEM_API37_REAL, 470500, 1)] });
      assert(r.status === 0 && /iteration 3\/3 done/.test(r.out) && /^OK: TOTAL PSS/m.test(r.out), `${r.status}: ${r.out}`);
      for (const f of ['mem-pdp-before.json', 'mem-pdp-after.json']) {
        assert(fs.existsSync(path.join(host.runDir, 'perf', f)), `${f} missing`);
      }
      const keys = fs.readFileSync(host.spawnLog, 'utf8').split('\n').filter(l => l.includes('keyevent'));
      eq(keys.length >= 4, true, `warm-up + 3 iterations sent BACK (${keys.length})`);
    });

    await check('leak-loop: Activity growth is FAIL exit 3; a failing step aborts with its iteration', async () => {
      const leak = await runDriver(host, ['leak-loop', '--steps', 'sleep --ms 1', '--times', '2', '--warmup', '0'],
        { ...base, 'dumpsys meminfo': [MEM_API37_REAL, bumpMem(MEM_API37_REAL, 469671, 2)] });
      assert(leak.status === 3 && /FAIL: activities grew 1 -> 2/.test(leak.out), `${leak.status}: ${leak.out}`);
      const bad = await runDriver(host, ['leak-loop', '--steps', 'sleep --ms 1; key --code nope', '--times', '2', '--warmup', '0'],
        { ...base, 'dumpsys meminfo': MEM_API37_REAL });
      assert(bad.status === 1 && /FAIL: step "key --code nope" failed on iteration 1\/2/.test(bad.out), `${bad.status}: ${bad.out}`);
    });

    await check('leak-loop: leaving the app or a pid change aborts; bad steps are refused', async () => {
      const left = await runDriver(host, ['leak-loop', '--steps', 'sleep --ms 1', '--times', '2', '--warmup', '0'],
        { ...base, ResumedActivity: [RESUMED_APP, RESUMED_LAUNCHER], 'dumpsys meminfo': MEM_API37_REAL });
      assert(left.status === 1 && /iteration 1\/2 left the app/.test(left.out), `${left.status}: ${left.out}`);
      const crash = await runDriver(host, ['leak-loop', '--steps', 'sleep --ms 1', '--times', '2', '--warmup', '0'],
        { ...base, pidof: '9999\n', 'dumpsys meminfo': MEM_API37_REAL });
      assert(crash.status === 3 && /process changed on iteration 1\/2/.test(crash.out), `${crash.status}: ${crash.out}`);
      const nested = await runDriver(host, ['leak-loop', '--steps', 'leak-loop --steps back'], base);
      assert(nested.status === 1 && /cannot be a leak-loop step/.test(nested.out), nested.out);
      const quote = await runDriver(host, ['leak-loop', '--steps', 'tap --text "open'], base);
      assert(quote.status === 1 && /unterminated/.test(quote.out), quote.out);
    });

    await check('every adb call names emulator-5554; the other lane only gets the avd-name probe', async () => {
      const calls = fs.readFileSync(host.spawnLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
        .filter(c => c[0] === 'adb' && c[1] !== 'devices' && !c.join(' ').includes('ro.boot.qemu.avd_name'));
      assert(calls.length && calls.every(c => c[1] === '-s' && c[2] === 'emulator-5554'), JSON.stringify(calls.find(c => c[2] !== 'emulator-5554')));
    });

    await check('--help lists the perf commands', async () => {
      const r = await runDriver(host, ['--help'], base);
      for (const c of ['perf', '--reset', '--source surfaceflinger', 'mem', '--compare', 'leak-loop', 'startup', 'key', 'sleep']) {
        assert(r.out.includes(c), `help is missing ${c}`);
      }
    });
  } finally {
    fs.rmSync(host.dir, { recursive: true, force: true });
  }
}

(async () => {
  await pureChecks();
  await endToEnd();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();
