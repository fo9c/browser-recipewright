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
  // run data format v1: events.jsonl is complete and valid, so a viewer plugin can replay the run
  const chk = await cli('check-run', r.json.runDir);
  assert.equal(chk.json.status, 'ok', chk.stderr);
  assert.equal(chk.json.finished, true);
  const ev = await cli('events');
  const types = ev.stdout.trim().split('\n').map((l) => JSON.parse(l).type);
  assert.equal(types[0], 'run.start');
  assert.equal(types.at(-1), 'run.end');
  for (const t of ['step.start', 'step.end', 'loop.iteration', 'data', 'page.navigated', 'pointer.move']) assert.ok(types.includes(t), t);
  assert.equal(types.filter((t) => t === 'step.start').length, types.filter((t) => t === 'step.end').length);
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
  fs.writeFileSync(patch, JSON.stringify({ stepId: 'collect-posts', ops: [{ op: 'replace', path: '/item', value: [{ testid: 'post' }, { role: 'article' }] }] }));
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

test('selfcheck: built-in recipe exercises every core action on the local page', { skip }, async () => {
  const r = await cli('selfcheck', '--headless');
  assert.equal(r.json.status, 'pass', r.stdout + r.stderr);
  assert.ok(r.json.checks.length >= 15);
  for (const c of r.json.checks) assert.equal(c.status, 'pass', JSON.stringify(c));
  assert.equal(r.json.observed.trusted, 'yes');
  assert.equal(r.json.observed.rowsLoaded, 40);
  assert.equal(r.json.observed.webdriver, 'false');
  assert.match(r.stderr, /自检通过/);
});

test('breakpoints: ask pauses (exit 4), answer continues the same run at that exact step, even inside a loop', { skip }, async () => {
  const tpl = path.join(ROOT, 'tests', 'fixtures-ask.json');
  const r = await cli('run', tpl, '-i', `base=${srv.url}`, '--headless', '-p', 'test/ask');
  assert.equal(r.code, 4, r.stderr);
  assert.equal(r.json.status, 'paused');
  assert.equal(r.json.ask.step, 'pick');
  assert.equal(r.json.ask.answer.type, 'pick');
  assert.equal(r.json.ask.data.length, 6);
  assert.equal(r.json.ask.data[2]['#'], 2);
  const runDir = r.json.runDir;
  // the browser stays open on the page while the agent thinks
  assert.ok((await cli('sessions')).json.sessions.some((s) => s.profile === 'test/ask'));
  const pend = await cli('pending');
  assert.equal(pend.json.pending.length, 1);
  assert.equal(pend.json.pending[0].runDir, runDir);
  // a wrong answer is refused and the run stays paused
  const bad = await cli('answer', runDir, '--value', '[9]');
  assert.equal(bad.code, 2);
  assert.equal(bad.json.error.code, 'ANSWER_INVALID');
  // pick → stops again inside the loop
  const a1 = await cli('answer', runDir, '--value', '[1,3]', '--headless');
  assert.equal(a1.code, 4, a1.stderr);
  assert.equal(a1.json.runDir, runDir);
  assert.equal(a1.json.ask.step, 'each[0].keep');
  assert.equal(a1.json.ask.question, 'Keep 条目 2?');
  const a2 = await cli('answer', runDir, '--value', 'yes', '--headless');
  assert.equal(a2.json.ask.step, 'each[1].keep', a2.stderr);
  assert.match(a2.stderr, /each\[0\]\.heading \(read\) already done before the pause/);
  const a3 = await cli('answer', runDir, '--value', 'false', '--headless');
  assert.equal(a3.json.ask.step, 'maybe.confirm', a3.stderr);
  const a4 = await cli('answer', runDir, '--value', 'more', '--headless');
  assert.equal(a4.code, 0, a4.stderr);
  assert.equal(a4.json.status, 'success');
  const out = JSON.parse(fs.readFileSync(path.join(runDir, 'output.json'), 'utf8'));
  assert.deepEqual(out.map((x) => [x.title, x.keep]), [['条目 2', true], ['条目 4', false]]);
  // the value read before the pause in the same round survived the pause
  for (const x of out) assert.equal(x.heading, 'browser-recipewright 自检页');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(state.vars.decision, 'more');
  // one run directory, one record: finished steps were not repeated, every pause has a resume
  const steps = fs.readFileSync(path.join(runDir, 'steps.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(steps.filter((s) => s.path === 'each[0].heading').length, 1);
  assert.equal(steps.filter((s) => s.path === 'rows').length, 1);
  assert.equal(steps.filter((s) => s.stepId === 'keep' && s.answeredBy === 'agent').length, 2);
  const chk = await cli('check-run', runDir);
  assert.equal(chk.json.status, 'ok', chk.stderr);
  assert.equal(chk.json.finished, true);
  const types = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  assert.equal(types.filter((t) => t === 'run.pause').length, 4);
  assert.equal(types.filter((t) => t === 'run.resume').length, 4);
  assert.equal(types.filter((t) => t === 'ask.answered').length, 4);
  assert.equal(types.at(-1), 'run.end');
  assert.equal((await cli('pending')).json.pending.length, 0);
  // the run started the browser and nobody asked to keep it: it is closed at the real end
  assert.ok(!(await cli('sessions')).json.sessions.some((s) => s.profile === 'test/ask'));
});

test('breakpoints: unattended runs use the default answer, or fail with ASK_UNANSWERED', { skip }, async () => {
  const tpl = path.join(ROOT, 'tests', 'fixtures-ask.json');
  const d = await cli('run', tpl, '-i', `base=${srv.url}`, '--headless', '-p', 'test/ask', '--on-ask', 'default');
  assert.equal(d.json.status, 'success', d.stderr);
  const out = JSON.parse(fs.readFileSync(d.json.output, 'utf8'));
  assert.deepEqual(out.map((x) => x.title), ['条目 1', '条目 2']);
  const f = await cli('run', tpl, '-i', `base=${srv.url}`, '--headless', '-p', 'test/ask', '--on-ask', 'fail');
  assert.equal(f.code, 1);
  assert.equal(f.json.error.code, 'ASK_UNANSWERED');
});

test('fragments: a recipe starts on the page the browser already shows (startOn), or refuses the wrong page', { skip }, async () => {
  const next = path.join(ROOT, 'tests', 'fragments', 'sc-next.json');
  assert.equal((await cli('launch', '--headless', '-p', 'test/chain', '--url', `${srv.url}/selfcheck.html`)).json.status, 'ok');
  const r = await cli('run', next, '-p', 'test/chain', '--on-ask', 'default');
  assert.equal(r.json.status, 'success', r.stderr);
  assert.match(r.stderr, /_start-on: already on the start page/);
  assert.equal(JSON.parse(fs.readFileSync(r.json.output, 'utf8')), '自检第二页');
  // the agent moves the browser somewhere else; the fragment notices it is not on its start page
  assert.equal((await cli('act', 'goto', '--url', `${srv.url}/selfcheck-next.html`, '-p', 'test/chain')).json.status, 'success');
  const bad = await cli('run', next, '-p', 'test/chain', '--on-ask', 'default');
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error.code, 'START_PAGE_MISMATCH');
  // the browser was started by launch, so runs leave it open for the next fragment
  assert.ok((await cli('sessions')).json.sessions.some((s) => s.profile === 'test/chain'));
  await cli('close', '-p', 'test/chain');
});

test('flows: recipe steps call fragments in one browser and one record, with breakpoints in and between them', { skip }, async () => {
  const flow = path.join(ROOT, 'tests', 'fragments', 'flow.json');
  const v = await cli('validate', flow);
  assert.equal(v.json.status, 'ok', v.stderr);
  const r = await cli('run', flow, '-i', `base=${srv.url}`, '--headless', '-p', 'test/flow');
  assert.equal(r.code, 4, r.stderr);
  assert.equal(r.json.ask.step, 'pick');
  assert.equal(r.json.ask.data.length, 4);
  const runDir = r.json.runDir;
  const a1 = await cli('answer', runDir, '--value', '[1,2]', '--headless');
  assert.equal(a1.json.ask.step, 'visit.come-back', a1.stderr);
  assert.match(a1.stderr, /visit\._start-on: already on the start page/);
  const a2 = await cli('answer', runDir, '--value', 'false', '--headless');
  assert.equal(a2.json.status, 'success', a2.stderr);
  assert.match(a2.stderr, /visit\.page2 \(read\) already done before the pause/);
  // stayed on page 2, so the next fragment opened its own start page
  assert.match(a2.stderr, /again\._start-on: opened the start page/);
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(state.vars.page2, '自检第二页');
  assert.equal(state.vars.rows2.length, 2);
  assert.deepEqual(state.vars.picked.map((x) => x.title), ['条目 2', '条目 3']);
  const steps = fs.readFileSync(path.join(runDir, 'steps.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(steps.find((s) => s.path === 'collect.rows' && s.status === 'ok'));
  assert.ok(steps.find((s) => s.path === 'visit' && s.recipe?.id === 'test/sc-next' && s.status === 'ok'));
  assert.equal(steps.filter((s) => s.path === 'visit.go-next').length, 1);
  const chk = await cli('check-run', runDir);
  assert.equal(chk.json.status, 'ok', chk.stderr);
  const types = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  assert.equal(types.filter((t) => t === 'recipe.enter').length, 4); // collect, visit, visit again after the pause, again
});

test('tasks: act / run / notes go into one journal; task draft turns them into a flow that runs', { skip }, async () => {
  assert.equal((await cli('task', 'start', 'e2e-task', '--gap', '100-200')).json.status, 'ok');
  try {
    await cli('launch', '--headless', '-p', 'test/task');
    assert.equal((await cli('act', 'goto', '--url', `${srv.url}/selfcheck.html`, '-p', 'test/task')).json.status, 'success');
    assert.equal((await cli('act', 'type', '--target', '[{"testid":"sc-search"},{"placeholder":"输入后按回车"}]', '--text', 'self check', '-p', 'test/task')).json.status, 'success');
    assert.equal((await cli('task', 'note', 'rows 2 and 4 look relevant')).json.status, 'ok');
    const run = await cli('run', path.join(ROOT, 'tests', 'fragments', 'sc-collect.json'), '-i', `base=${srv.url}`, '-i', 'count=3', '-p', 'test/task');
    assert.equal(run.json.status, 'success', run.stderr);
    const show = await cli('task', 'show');
    assert.deepEqual(show.json.entries.map((e) => e.type), ['act', 'act', 'decision', 'run']);
    assert.ok(show.json.entries[3].runDir);
    const d = await cli('task', 'draft', '--param', 'q=self check', '--param', `base=${srv.url}`, '-o', path.join(HOME, 'draft.json'));
    assert.equal(d.json.status, 'ok', d.stderr);
    assert.equal(d.json.kind, 'flow');
    const draft = JSON.parse(fs.readFileSync(path.join(HOME, 'draft.json'), 'utf8'));
    assert.deepEqual(draft.steps.map((s) => s.action), ['goto', 'type', 'ask', 'recipe']);
    assert.equal(draft.steps[1].text, '{{inputs.q}}');
    assert.equal(draft.steps[0].url, '{{inputs.base}}/selfcheck.html');
    assert.equal(draft.steps[3].inputs.base, '{{inputs.base}}');
    assert.equal(draft.provenance.fromTask, 'e2e-task');
    // the draft runs: it stops at the decision you made by hand, and goes on with your answer
    const r = await cli('run', path.join(HOME, 'draft.json'), '-p', 'test/task');
    assert.equal(r.code, 4, r.stderr);
    assert.equal(r.json.ask.question, 'rows 2 and 4 look relevant');
    const a = await cli('answer', r.json.runDir, '--value', 'ok');
    assert.equal(a.json.status, 'success', a.stderr);
  } finally {
    await cli('task', 'end');
    await cli('close', '-p', 'test/task');
  }
});

test('waitFor a target that matches many elements passes (presence, not "exactly one")', { skip }, async () => {
  assert.equal((await cli('launch', '--headless', '-p', 'fix/e2e', '--url', `${srv.url}/selfcheck.html`)).json.status, 'ok');
  const r = await cli('act', 'waitFor', '--target', '[{"css":"section"}]', '-p', 'fix/e2e');
  assert.equal(r.json.status, 'success', r.stdout);
  assert.equal(r.json.locator.hit, 0);
  assert.ok(r.json.locator.tried[0].matches > 1, r.stdout);
  const miss = await cli('act', 'waitFor', '--target', '[{"css":"#nope"}]', '--step', '{"action":"waitFor","target":[{"css":"#nope"}],"timeoutMs":800}', '-p', 'fix/e2e');
  assert.equal(miss.json.error.code, 'LOCATOR_NOT_FOUND', miss.stdout);
});
