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
const BIN = path.join(ROOT, 'bin', 'browser-rpa.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'brpa-e2e-'));
const env = { ...process.env, BROWSER_RPA_HOME: HOME };
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
