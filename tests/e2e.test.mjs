// End-to-end tests against the bundled demo site with a real (headless) Chrome.
// node --test tests/e2e.test.mjs      (skipped automatically when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../dist/browser.js';
import { startDemoServer } from '../dist/demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'browser-recipewright.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-e2e-'));
const env = { ...process.env, BROWSER_RECIPEWRIGHT_HOME: HOME, BROWSER_RECIPEWRIGHT_NAV_TIMEOUT_MS: '4000' };
// async on purpose: the demo server lives in this process and must keep answering while the CLI runs
const cli = (...args) =>
  new Promise((resolve) => {
    const p = spawn('node', [BIN, ...args], { env });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ code, json, stdout, stderr });
    });
  });

const skip = !findChrome() && 'Chrome not installed';
let srv;
test.before(async () => { srv = await startDemoServer(0); });
test.after(async () => { await cli('close', '--all'); await srv?.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('doctor passes', { skip }, async () => {
  const r = await cli('doctor');
  assert.equal(r.json.status, 'ok', r.stderr);
});

test('fresh profile without login → LOGIN_REQUIRED (exit 3)', { skip }, async () => {
  const r = await cli('run', 'demo/local-feed', '-i', `base=${srv.url}`, '--headless', '-p', 'demo/e2e');
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.json.error.code, 'LOGIN_REQUIRED');
  // v0.1.2: a run that failed before step 1 can still be resumed, even without a checkpoint
  fs.rmSync(path.join(r.json.runDir, 'state.json'), { force: true });
  const again = await cli('run', 'demo/local-feed', '--resume', r.json.runDir, '--headless', '--no-handoff');
  assert.equal(again.json.error.code, 'LOGIN_REQUIRED', again.stderr);
  assert.match(again.stderr, /stopped before its first step/);
  assert.doesNotMatch(again.stdout + again.stderr, /state\.json/);
});

test('login via snapshot + act, then full run succeeds with records', { skip }, async () => {
  assert.equal((await cli('launch', '--headless', '-p', 'demo/e2e', '--url', `${srv.url}/home.html`)).json.status, 'ok');
  const snap = await cli('snapshot', '-p', 'demo/e2e');
  const ref = snap.stdout.match(/button "Log in".*\[ref=(r\d+)\]/)[1];
  const act = await cli('act', 'click', '--ref', ref, '-p', 'demo/e2e');
  assert.equal(act.json.status, 'success', act.stdout);
  const r = await cli('run', 'demo/local-feed', '-i', `base=${srv.url}`, '-i', 'count=3', '-i', 'maxComments=4', '-p', 'demo/e2e', '--no-handoff');
  assert.equal(r.json.status, 'success', r.stderr);
  const out = JSON.parse(fs.readFileSync(r.json.output, 'utf8'));
  assert.equal(out.length, 3);
  for (const d of out) {
    assert.ok(d.post.likes >= 100);
    assert.ok(d.main.time);
    assert.ok(d.replies.length > 0 && d.replies.length <= 4);
  }
  const steps = fs.readFileSync(path.join(r.json.runDir, 'steps.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(steps.find((s) => s.stepId === 'collect-posts' && s.locator.hit === 0));
  assert.ok(steps.find((s) => s.path === 'read-each[2].collect-replies'));
});

test('pagination merge: appendTo + dedupe, forEach.flatten; act collect shows items', { skip }, async () => {
  const feed = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/demo/local-feed.json'), 'utf8'));
  const c = feed.steps.find((s) => s.id === 'collect-posts');
  const fields = { url: c.fields.url, author: c.fields.author };
  const page = (id, extra) => ({ id, action: 'collect', item: c.item, fields, dedupeBy: 'url', limit: 3, maxScrolls: 3, ...extra });
  const tpl = {
    id: 'e2e-merge', version: '0.1.0', title: 'merge pages', site: ['127.0.0.1', 'localhost'],
    inputs: { base: { type: 'string', required: true } },
    steps: [
      { id: 'pages', action: 'forEach', in: ['agent', 'agent'], as: 'kw', max: 2, flatten: true, collectFrom: '{{ vars.part }}', saveAs: 'flat', do: [
        { id: 'open', action: 'goto', url: '{{inputs.base}}/search.html?q={{kw}}&f=top' },
        page('grab', { saveAs: 'part', appendTo: { var: 'all', dedupeBy: 'url' } }),
      ] },
    ],
    outputs: { from: '{{ vars }}' },
  };
  const file = path.join(HOME, 'merge.json');
  fs.writeFileSync(file, JSON.stringify(tpl));
  const r = await cli('run', file, '-i', `base=${srv.url}`, '-p', 'demo/e2e', '--no-handoff');
  assert.equal(r.json.status, 'success', r.stdout + r.stderr);
  const out = JSON.parse(fs.readFileSync(r.json.output, 'utf8'));
  assert.equal(out.flat.length, 6, 'forEach.flatten gives one flat list of 2 pages x 3');
  assert.ok(out.flat.every((x) => !Array.isArray(x)));
  assert.equal(out.all.length, 3, 'appendTo with dedupeBy drops the repeated page');

  const act = await cli('act', 'collect', '-p', 'demo/e2e', '--step', JSON.stringify(page('peek', {})));
  assert.equal(act.json.status, 'success', act.stdout);
  assert.equal(act.json.count, 3);
  assert.equal(act.json.items.length, 3);
  assert.ok(act.json.items[0].url && act.json.stats.stoppedBecause, act.stdout);
  assert.match(act.stderr, /collect: 3 item\(s\) kept/);
});

test('broken locator → dossier → patch → resume succeeds', { skip }, async () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/demo/local-feed.json'), 'utf8'));
  tpl.id = 'demo/e2e-broken';
  tpl.steps.find((s) => s.id === 'collect-posts').item = [{ testid: 'post-card' }, { css: 'div.card' }];
  tpl.defaults.timeoutMs = 3000;
  const file = path.join(HOME, 'broken.json');
  fs.writeFileSync(file, JSON.stringify(tpl, null, 2));
  const r = await cli('run', file, '-i', `base=${srv.url}`, '-i', 'count=2', '-i', 'maxComments=2', '-p', 'demo/e2e', '--no-handoff');
  assert.equal(r.json.error.code, 'LOCATOR_NOT_FOUND');
  assert.equal(r.json.error.stepId, 'collect-posts');
  const d = (await cli('heal', r.json.runDir)).json;
  assert.equal(d.failedStepId, 'collect-posts');
  assert.ok(fs.existsSync(path.join(r.json.runDir, 'failure', 'snapshot.txt')));
  const patch = path.join(HOME, 'patch.json');
  fs.writeFileSync(patch, JSON.stringify({ stepId: 'collect-posts', ops: [{ op: 'replace', path: '/item', value: [{ testid: 'tweet' }, { role: 'article' }] }] }));
  assert.equal((await cli('patch', file, patch, '--write')).json.version, '0.1.1');
  const r2 = await cli('run', file, '--resume', r.json.runDir, '-p', 'demo/e2e', '--no-handoff');
  assert.match(r2.stderr, /↻ resuming at top-level step \d+\/\d+ "/, r2.stderr);
  assert.equal(r2.json.status, 'success', r2.stderr);
});

test('runScript whitelist works and rejects tampering', { skip }, async () => {
  const step = JSON.stringify({ action: 'runScript', script: 'page-info', args: { countLinks: true } });
  const r = await cli('act', 'runScript', '--step', step, '-p', 'demo/e2e');
  assert.equal(r.json.status, 'success', r.stdout);
  const bad = await cli('act', 'runScript', '--step', JSON.stringify({ action: 'runScript', script: 'nope' }), '-p', 'demo/e2e');
  assert.notEqual(bad.json.status, 'success');
});

test('batch: skip expired login, resume does not repeat', { skip }, async () => {
  const spec = {
    name: 'e2e', template: 'demo/local-feed', headless: true, spacingMs: 100, onLoginRequired: 'skip',
    inputs: { base: srv.url, count: 1, maxComments: 1 },
    accounts: [{ id: 'ok', profile: 'demo/e2e' }, { id: 'nologin', profile: 'demo/e2e-nologin' }],
  };
  const f = path.join(HOME, 'batch.json');
  fs.writeFileSync(f, JSON.stringify(spec));
  const r = await cli('batch', f);
  assert.deepEqual(r.json.counts, { success: 1, skipped_login: 1 }, r.stderr);
  assert.deepEqual(r.json.loginExpired, ['nologin']);
  const again = await cli('batch', '--resume', r.json.batchDir);
  assert.match(again.stderr, /ok#1 already success/);
});

test('resume skips forEach items that already finished', { skip }, async () => {
  const tpl = {
    id: 'e2e-loop', version: '0.1.0', title: 'loop resume', site: ['127.0.0.1', 'localhost'],
    inputs: { base: { type: 'string', required: true }, failAt: { type: 'integer', default: 0 } },
    steps: [
      { id: 'open', action: 'goto', url: '{{inputs.base}}/home.html' },
      { id: 'each', action: 'forEach', in: [1, 2, 3], as: 'n', max: 3, collectFrom: '{{ n }}', saveAs: 'got', do: [
        { id: 'look', action: 'wait', ms: 50 },
        { id: 'chk', action: 'assert', that: { ne: ['{{n}}', '{{inputs.failAt}}'] } },
      ] },
    ],
    outputs: { from: '{{ vars.got }}' },
  };
  const file = path.join(HOME, 'loop.json');
  fs.writeFileSync(file, JSON.stringify(tpl));
  const r1 = await cli('run', file, '-i', `base=${srv.url}`, '-i', 'failAt=2', '-p', 'demo/e2e', '--headless', '--no-handoff');
  assert.notEqual(r1.json.status, 'success');
  const r2 = await cli('run', file, '--resume', r1.json.runDir, '-i', 'failAt=0', '--headless', '--no-handoff');
  assert.equal(r2.json.status, 'success', r2.stderr);
  assert.match(r2.stderr, /1 of 3 item\(s\) already done, continuing at item 2/);
  const steps = fs.readFileSync(path.join(r2.json.runDir, 'steps.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(!steps.some((s) => s.path === 'each[0].look'), 'item 1 must not be redone');
  assert.ok(steps.some((s) => s.path === 'each[1].look'));
  assert.deepEqual(JSON.parse(fs.readFileSync(r2.json.output, 'utf8')), [1, 2, 3]);
});

test('launch tolerates a page that never finishes loading; act/screenshot save PNGs', { skip }, async () => {
  const slow = await cli('launch', '--headless', '-p', 'demo/e2e', '--url', `${srv.url}/slow.html`);
  assert.equal(slow.json.status, 'ok', slow.stdout + slow.stderr);
  assert.match(slow.json.warning, /did not finish loading/);
  const shot = await cli('screenshot', '-p', 'demo/e2e', '-o', path.join(HOME, 'slow.png'));
  assert.equal(shot.json.status, 'ok', shot.stdout + shot.stderr);
  assert.ok(fs.statSync(shot.json.file).size > 1000);
  const act = await cli('act', 'goto', '--url', `${srv.url}/home.html`, '--screenshot', '-p', 'demo/e2e');
  assert.equal(act.json.status, 'success', act.stdout);
  assert.ok(act.json.screenshot && fs.existsSync(act.json.screenshot), act.stdout);
});

test('login fills template inputs into the login URL', { skip }, async () => {
  const bad = await cli('login', 'demo/local-feed', '-i', 'base=', '-p', 'demo/e2e');
  assert.equal(bad.json.error.code, 'INPUT_INVALID', bad.stdout);
  await cli('launch', '--headless', '-p', 'demo/e2e');
  const r = await cli('login', 'demo/local-feed', '-i', `base=${srv.url}`, '-p', 'demo/e2e');
  assert.equal(r.json.status, 'ok', r.stdout + r.stderr);
  assert.equal(r.json.loggedIn, true);
  assert.match(r.stderr, new RegExp(`${srv.url.replace(/[.:/]/g, '\\$&')}/home\\.html`));
});


// the user (or the page) changes things while the robot works: the click must not land on whatever
// took the old spot, and typed text must not end up in another field
const readResult = async () => {
  const r = await cli('act', 'read', '-p', 'demo/e2e', '--step', JSON.stringify({ action: 'read', target: [{ css: '#result' }], text: true }));
  return JSON.stringify(r.json);
};

test('click re-aims when the target moves during the mouse move', { skip }, async () => {
  await cli('launch', '--headless', '-p', 'demo/e2e');
  assert.equal((await cli('act', 'goto', '--url', `${srv.url}/interfere.html?move=1`, '-p', 'demo/e2e')).json.status, 'success');
  const act = await cli('act', 'click', '--target', JSON.stringify([{ css: '#target' }]), '-p', 'demo/e2e');
  assert.equal(act.json.status, 'success', act.stdout + act.stderr);
  const res = await readResult();
  assert.match(res, /clicks=target\|/, res);
  assert.doesNotMatch(res, /trap/, res);
  assert.match(act.stderr, /aiming again/);
});

test('typing keeps its focus when something else grabs it', { skip }, async () => {
  assert.equal((await cli('act', 'goto', '--url', `${srv.url}/interfere.html?steal=1`, '-p', 'demo/e2e')).json.status, 'success');
  const act = await cli('act', 'type', '--target', JSON.stringify([{ css: '#box' }]), '--text', 'hello world', '-p', 'demo/e2e');
  assert.equal(act.json.status, 'success', act.stdout + act.stderr);
  const res = await readResult();
  assert.match(res, /box=hello world\|other=(?!\w)/, res);
  assert.match(act.stderr, /lost focus while typing/);
});
