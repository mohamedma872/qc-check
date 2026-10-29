'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluate } = require('../runtime/quality-gate');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'qc-gate-'));
try {
  const summary = { verdict:'PASS', ticket:'ABC-123',environment:'staging',runId:'run-1',startedAt:'2026-01-01T00:00:00Z',phases:{phone:'passed'},findings:{red:0},artifacts:{screenshots:1} };
  assert.equal(evaluate(summary,dir).pass,false,'missing evidence must block');
  fs.writeFileSync(path.join(dir,'report.md'),'report');
  fs.writeFileSync(path.join(dir,'state.json'),'{}');
  fs.mkdirSync(path.join(dir,'screenshots'));
  fs.writeFileSync(path.join(dir,'screenshots','001.png'),'synthetic');
  const manifest={commitSha:'abcdef',deviceId:'test-device',osVersion:'test-os',agentVersion:'test-agent',capturedAt:'2026-01-01T00:00:00Z',environment:'staging',runId:'run-1',reviewed:true};
  fs.writeFileSync(path.join(dir,'evidence-manifest.json'),JSON.stringify(manifest));
  assert.equal(evaluate(summary,dir).pass,true,'complete fixture should pass');
  for (const verdict of ['FAIL','BLOCKED','SKIPPED','INCONCLUSIVE',null]) {
    assert.equal(evaluate({...summary,verdict},dir).pass,false,'nonpass must block');
  }
  assert.equal(evaluate({...summary,phases:{phone:'skipped'}},dir).pass,false,'skipped required phase must block');
  assert.equal(evaluate({...summary,phases:{smoke:'skipped',phone:'pass'}},dir).pass,false,'skipped smoke must block');
  for (const status of ['fail','blocked','pending','in_progress']) {
    assert.equal(evaluate({...summary,phases:{phone:status}},dir).pass,false,status + ' phase must block');
  }
  const optional = {...summary,phases:{'code-review':'skipped',contract:'skipped',phone:'pass',publish:'skipped'}};
  assert.equal(evaluate(optional,dir).pass,false,'optional skip without a reason must block');
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({phases:{'code-review':{status:'skipped',note:'no diff'},contract:{status:'skipped',note:'backend disabled'},publish:{status:'skipped',note:'no tracker configured'}}}));
  assert.equal(evaluate(optional,dir).pass,true,'optional skips with reasons should pass');
  fs.writeFileSync(path.join(dir,'state.json'),'{}');
  assert.equal(evaluate({...summary,findings:{red:1}},dir).pass,false);
  assert.equal(evaluate({...summary,artifacts:{screenshots:0}},dir).pass,false);
  fs.writeFileSync(path.join(dir,'evidence-manifest.json'),JSON.stringify({...manifest,reviewed:false}));
  assert.equal(evaluate(summary,dir).pass,false,'unreviewed evidence must block');
  console.log('quality-gate: all assertions passed');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
