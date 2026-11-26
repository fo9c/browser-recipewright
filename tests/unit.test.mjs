// Unit tests (no browser): node --test tests/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { validateTemplate } from '../dist/validate.js';
import { render, parseCount } from '../dist/render.js';
import { evalCond } from '../dist/conditions.js';
import { applyPatch } from '../dist/heal.js';
import { coerceInputs, postFields } from '../dist/engine.js';
import { parseCsv, planJobs } from '../dist/batch.js';
import { checkSchema } from '../dist/jsonschema.js';
import { buildJsonSchema } from '../dist/schema.js';
import { coerceAnswer } from '../dist/ask.js';
import { checkRecipeCalls } from '../dist/flow.js';

const load = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url)));

test('built-in templates are valid', () => {
  for (const p of ['../templates/selfcheck/basic.json', '../templates/demo/local-feed.json']) {
    const r = validateTemplate(load(p));
    assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
  }
});

test('validate finds every deliberate mistake', () => {
  const r = validateTemplate(load('./fixtures-broken.json'));
  const msgs = r.errors.map((e) => `${e.stepId}: ${e.message}`).join('\n');
  const expectMsg = (re) => assert.match(msgs, re);
  expectMsg(/open: host "evil.com" is not in site/);
  expectMsg(/duplicate step id "open"/);
  expectMsg(/unknown action "clik"/);
  expectMsg(/input "nope" is not declared/);
  expectMsg(/variable "later" is not produced by any earlier step/);
  expectMsg(/loop: .*maxIterations/);
  expectMsg(/unknown condition "greaterThan"/);
  expectMsg(/script "not-whitelisted" is not in any whitelist/);
  expectMsg(/runScript cannot be optional/);
  expectMsg(/two-keys: each locator candidate needs exactly one of/);
  const warns = r.warnings.map((w) => `${w.stepId}: ${w.message}`).join('\n');
  assert.match(warns, /later: xpath is the least stable/);
  assert.match(warns, /goto without expect/);
});

test('render: whole-value refs keep type, filters work', () => {
  const scope = { inputs: { q: 'a b', n: '5' }, vars: { list: [1, 2] }, post: { url: '/u/status/1' } };
  assert.deepEqual(render('{{vars.list}}', scope), [1, 2]);
  assert.equal(render('x?q={{inputs.q | urlencode}}', scope), 'x?q=a%20b');
  assert.equal(render('{{inputs.n | number}}', scope), 5);
  assert.equal(render('https://example.com{{post.url}}', scope), 'https://example.com/u/status/1');
  assert.equal(render('{{vars.list | length}}', scope), 2);
});

test('parseCount handles K/M/万 and commas', () => {
  assert.equal(parseCount('1.2K'), 1200);
  assert.equal(parseCount('3,456'), 3456);
  assert.equal(parseCount('1.5万'), 15000);
  assert.equal(parseCount('2M Likes'), 2000000);
  assert.equal(parseCount(null), 0);
});

test('conditions without page', async () => {
  const scope = { item: { likes: 120 }, inputs: { min: 50 }, self: [1, 2, 3] };
  assert.equal((await evalCond({ gte: ['{{item.likes}}', '{{inputs.min}}'] }, scope)).pass, true);
  assert.equal((await evalCond({ countGte: ['{{self}}', 5] }, scope)).pass, false);
  assert.equal((await evalCond({ and: [{ eq: [1, 1] }, { not: { matches: ['abc', '^z'] } }] }, scope)).pass, true);
  assert.equal((await evalCond({ or: [{ lt: [3, 1] }, { contains: ['hello', 'ell'] }] }, scope)).pass, true);
});

test('postFields applies pattern/as/optional', () => {
  const fields = { likes: { attr: 'aria-label', pattern: '^([\\d,.]+\\s*[KM]?)', as: 'count', optional: true, default: 0 }, url: { attr: 'href' }, t: { text: true, optional: true } };
  const r = postFields({ likes: { found: true, raw: '1.2K Likes. Like' }, url: { found: true, raw: '/a/status/1' }, t: { found: false, raw: null } }, fields);
  assert.deepEqual(r.values, { likes: 1200, url: '/a/status/1', t: null });
  const r2 = postFields({ likes: { found: true, raw: 'Like' }, url: { found: false } }, fields);
  assert.deepEqual(r2.missing, ['url']);
  assert.equal(r2.values.likes, 0);
});

test('coerceInputs: defaults, types, required', () => {
  const feed = load('../templates/demo/local-feed.json');
  // an input without a default is required
  const tpl = { ...feed, inputs: { ...feed.inputs, keyword: { type: 'string', description: 'required here' } } };
  assert.throws(() => coerceInputs(tpl, {}), /missing required input "keyword"/);
  const v = coerceInputs(tpl, { keyword: 'ai', count: '3' });
  assert.equal(v.count, 3);
  assert.equal(v.minLikes, 100);
  assert.throws(() => coerceInputs(tpl, { keyword: 'ai', tab: 'nope' }), /must be one of/);
  assert.throws(() => coerceInputs(tpl, { keyword: 'ai', bogus: 1 }), /unknown input/);
});

test('applyPatch: step-scoped ops + version bump + provenance', () => {
  const tpl = load('../templates/demo/local-feed.json');
  const { template } = applyPatch(tpl, [
    { stepId: 'collect-posts', op: 'merge', value: { maxScrolls: 60 }, note: 'more scrolling' },
    { stepId: 'read-main', ops: [{ op: 'replace', path: '/target/0', value: { testid: 'post', nth: 0 } }] },
    { stepId: 'rest', op: 'remove' },
  ]);
  assert.equal(template.version, '0.1.1');
  assert.equal(template.steps[2].maxScrolls, 60);
  assert.equal(template.steps[4].do.length, 3);
  assert.equal(template.provenance.repairs.at(-1).steps.length, 3);
  assert.equal(validateTemplate(template).ok, true);
  assert.throws(() => applyPatch(tpl, { stepId: 'nope', op: 'remove' }), /not found/);
});

test('batch planning: accounts × jobs, csv', () => {
  assert.deepEqual(parseCsv('id,profile,keyword\na,demo/a,"hello, world"\nb,,\n'), [
    { id: 'a', profile: 'demo/a', keyword: 'hello, world' },
    { id: 'b', profile: '', keyword: '' },
  ]);
  const jobs = planJobs({ _site: 'demo', inputs: { count: 5 }, accounts: [{ id: 'a', inputs: { keyword: 'k1' } }, { id: 'b' }] }, '.');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].account.profile, 'demo/a');
  assert.deepEqual(jobs[0].inputs, { count: 5, keyword: 'k1' });
  const j2 = planJobs({ _site: 'demo', accounts: [{ id: 'a' }], jobs: [{ account: 'a', inputs: { keyword: 1 } }, { account: 'a', inputs: { keyword: 2 } }] }, '.');
  assert.deepEqual(j2.map((j) => j.key), ['a#1', 'a#2']);
});

test('output schema check', () => {
  assert.deepEqual(checkSchema([{ a: 1 }], { type: 'array', minItems: 1, items: { required: ['a'] } }), []);
  assert.equal(checkSchema([], { type: 'array', minItems: 1 }).length, 1);
  assert.equal(checkSchema([{}], { type: 'array', items: { required: ['a'] } }).length, 1);
});

test('JSON Schema export builds', () => {
  const s = buildJsonSchema();
  assert.ok(s.$defs.step.oneOf.length >= 24);
  assert.ok(s.$defs.step_collect.properties.maxScrolls);
});

test('merge pages: flatten filter, forEach.flatten and appendTo validate', () => {
  assert.deepEqual(render('{{ vars.p | flatten }}', { vars: { p: [[1, 2], [3], 4] } }), [1, 2, 3, 4]);
  assert.deepEqual(render('{{ vars.p | compact }}', { vars: { p: [1, null, 2] } }), [1, 2]);
  const base = { id: 't', version: '0.1.0', title: 't', site: ['example.com'] };
  const ok = validateTemplate({
    ...base,
    steps: [
      { id: 'pages', action: 'while', maxIterations: 5, when: { countLte: ['{{ vars.all }}', 9] }, do: [
        { id: 'grab', action: 'queryAll', target: [{ css: 'li' }], appendTo: { var: 'all', dedupeBy: 'url' } },
      ] },
      { id: 'each', action: 'forEach', in: [1, 2], as: 'p', max: 2, flatten: true, collectFrom: '{{ vars.part }}', saveAs: 'merged', do: [
        { id: 'q', action: 'queryAll', target: [{ css: 'li' }], saveAs: 'part' },
      ] },
    ],
    outputs: { from: '{{ vars.all }}' },
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors, null, 2));
  const clash = validateTemplate({ ...base, steps: [
    { id: 'a', action: 'queryAll', target: [{ css: 'li' }], saveAs: 'x' },
    { id: 'b', action: 'queryAll', target: [{ css: 'li' }], appendTo: 'x' },
  ] });
  assert.match(clash.errors.map((e) => e.message).join('\n'), /appendTo list|also written by saveAs/);
});

test('Chrome flags keep minimized / covered / background windows at full speed', async () => {
  const { chromeArgs } = await import('../dist/browser.js');
  const args = chromeArgs('/tmp/x', { url: 'about:blank' });
  for (const f of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-blink-features=AutomationControlled'])
    assert.ok(args.includes(f), f);
  assert.equal(args.at(-1), 'about:blank');
  assert.ok(!args.includes('--headless=new'));
  assert.ok(chromeArgs('/tmp/x', { headless: true }).includes('--headless=new'));
});

test('run data format: recorder writes run.json + events.jsonl that pass check-run', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { RunRecorder } = await import('../dist/records.js');
  const { checkRunDir, readEvents, stepOutline } = await import('../dist/events.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-fmt-'));
  try {
    const rec = new RunRecorder('demo/unit', base);
    const steps = [{ id: 'open', action: 'goto', url: 'x' }, { id: 'each', action: 'forEach', in: '{{ vars.a }}', as: 'it', do: [{ id: 'read', action: 'read', target: [{ css: 'a' }] }] }];
    rec.start({ templateId: 'demo/unit', templateVersion: '0.1.0' }, steps);
    const seq = rec.nextSeq();
    rec.events.emit('step.start', { step: seq, path: 'open', stepId: 'open', action: 'goto' });
    rec.events.emit('data', { step: seq, path: 'open', mode: 'save', added: 1, preview: { a: 1 } });
    rec.step({ seq, stepId: 'open', path: 'open', action: 'goto', status: 'ok', startedAt: new Date().toISOString(), durationMs: 5, urlBefore: null, urlAfter: 'about:blank', locator: null, expect: null, attempts: 1, output: null, artifacts: [] });
    let mid = checkRunDir(rec.dir);
    assert.equal(mid.ok, true, mid.errors.join('\n'));
    assert.equal(mid.finished, false);
    rec.writeOutput([]);
    rec.finish({ status: 'success', error: null, outputCount: 0 });
    const r = checkRunDir(rec.dir);
    assert.equal(r.ok, true, r.errors.join('\n'));
    assert.equal(r.finished, true);
    assert.equal(r.format, 'recipewright.run/1');
    const ev = readEvents(rec.dir);
    assert.deepEqual(ev.map((e) => e.type), ['run.start', 'step.start', 'data', 'step.end', 'run.end']);
    assert.deepEqual(ev.map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.equal(ev[0].steps[1].children.do[0].path, 'each[*].read');
    assert.equal(stepOutline(steps)[1].loop, true);
    const latest = JSON.parse(fs.readFileSync(path.join(base, '_latest.json'), 'utf8'));
    assert.equal(latest.runDir, rec.dir);
    assert.equal(latest.status, 'success');
    // an unfinished last line is ignored by readers; a broken envelope is reported
    fs.appendFileSync(path.join(rec.dir, 'events.jsonl'), '{"v":1,"seq":6');
    assert.equal(readEvents(rec.dir).length, 5);
    fs.appendFileSync(path.join(rec.dir, 'events.jsonl'), '\n');
    assert.equal(checkRunDir(rec.dir).ok, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('run data format: unknown event types and extra fields are allowed (forward compatible)', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { RunRecorder } = await import('../dist/records.js');
  const { checkRunDir } = await import('../dist/events.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-fmt-'));
  try {
    const rec = new RunRecorder('demo/unit', base);
    rec.start({ templateId: 'demo/unit', templateVersion: '0.1.0' }, []);
    rec.events.emit('future.thing', { anything: [1, 2] });
    rec.finish({ status: 'failed', error: { code: 'X', message: 'y' } });
    assert.equal(checkRunDir(rec.dir).ok, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ask: answers are checked and converted by their format', () => {
  assert.equal(coerceAnswer(undefined, 'hi'), 'hi');
  assert.equal(coerceAnswer({ type: 'number' }, '3.5'), 3.5);
  assert.equal(coerceAnswer({ type: 'boolean' }, 'yes'), true);
  assert.equal(coerceAnswer({ type: 'boolean' }, '否'), false);
  assert.equal(coerceAnswer({ type: 'choice', options: ['a', 'b'] }, 'b'), 'b');
  const data = [{ t: 'x' }, { t: 'y' }, { t: 'z' }];
  assert.deepEqual(coerceAnswer({ type: 'pick' }, [2, 0, 2], data), [{ t: 'x' }, { t: 'z' }]);
  assert.deepEqual(coerceAnswer({ type: 'pick' }, '1, 2', data), [{ t: 'y' }, { t: 'z' }]);
  assert.deepEqual(coerceAnswer({ type: 'pick' }, [], data), []);
  assert.deepEqual(coerceAnswer({ type: 'json', schema: { type: 'object', required: ['a'] } }, { a: 1 }), { a: 1 });
  const bad = (spec, v, d) => assert.throws(() => coerceAnswer(spec, v, d), (e) => e.code === 'ANSWER_INVALID');
  bad({ type: 'number' }, 'abc');
  bad({ type: 'boolean' }, 'maybe');
  bad({ type: 'choice', options: ['a'] }, 'c');
  bad({ type: 'pick' }, [3], data);
  bad({ type: 'pick', max: 1 }, [0, 1], data);
  bad({ type: 'pick', min: 1 }, [], data);
  bad({ type: 'pick' }, [0], 'not a list');
  bad({ type: 'json', schema: { type: 'array' } }, { a: 1 });
});

test('ask: validate checks the answer format, pick data and defaults', () => {
  const tpl = (step) => ({ id: 't/ask', version: '0.1.0', title: 't', site: ['example.com'], steps: [{ id: 'list', action: 'wait', ms: 1, saveAs: 'items' }, step] });
  const errs = (step) => validateTemplate(tpl(step)).errors.map((e) => e.message).join('\n');
  const warns = (step) => validateTemplate(tpl(step)).warnings.map((e) => e.message).join('\n');
  assert.equal(errs({ id: 'q', action: 'ask', question: 'ok?', answer: { type: 'boolean' }, default: true, saveAs: 'ok' }), '');
  assert.match(errs({ id: 'q', action: 'ask', question: 'which?', answer: { type: 'choice' }, saveAs: 'c' }), /needs "options"/);
  assert.match(errs({ id: 'q', action: 'ask', question: 'which?', answer: { type: 'pick' }, saveAs: 'c' }), /needs "data"/);
  assert.match(errs({ id: 'q', action: 'ask', question: 'which?', answer: { type: 'pick' }, data: 'abc', saveAs: 'c' }), /to be a list/);
  assert.equal(errs({ id: 'q', action: 'ask', question: 'which?', answer: { type: 'pick' }, data: '{{vars.items}}', default: [0], saveAs: 'c' }), '');
  assert.match(errs({ id: 'q', action: 'ask', question: 'n?', answer: { type: 'number' }, default: 'many', saveAs: 'n' }), /default .*expected a number/);
  assert.match(errs({ id: 'q', action: 'ask', question: '{{vars.nope}}?', saveAs: 'n' }), /variable "nope" is not produced/);
  assert.match(errs({ id: 'q', action: 'ask', question: 'x', answer: { type: 'guess' } }), /type/);
  assert.match(warns({ id: 'q', action: 'ask', question: 'x' }), /ask without saveAs/);
  assert.equal(validateTemplate(load('./fixtures-ask.json')).ok, true);
});

test('flows: recipe calls are checked (exists, inputs, circles) and startOn is validated', () => {
  const from = new URL('./fragments/flow.json', import.meta.url).pathname;
  const flow = (steps) => ({ id: 't/flow', version: '0.1.0', title: 't', kind: 'flow', site: ['127.0.0.1'], steps });
  assert.deepEqual(checkRecipeCalls(load('./fragments/flow.json'), from).filter((i) => i.level === 'error'), []);
  const msgs = (steps) => checkRecipeCalls(flow(steps), from).map((i) => i.message).join('\n');
  assert.match(msgs([{ id: 'a', action: 'recipe', recipe: './nope.json' }]), /not found/);
  assert.match(msgs([{ id: 'a', action: 'recipe', recipe: './sc-collect.json' }]), /needs input "base"/);
  assert.match(msgs([{ id: 'a', action: 'recipe', recipe: './sc-collect.json', inputs: { base: 'x', color: 1 } }]), /has no input "color"/);
  const circle = { ...flow([{ id: 'a', action: 'recipe', recipe: './flow.json', inputs: { base: 'x' } }]), id: 'test/flow' };
  assert.match(checkRecipeCalls(circle, from).map((i) => i.message).join('\n'), /circle: test\/flow → test\/flow/);
  assert.equal(validateTemplate(flow([{ id: 'a', action: 'recipe', recipe: 't/flow' }])).ok, false);
  const so = (startOn) => validateTemplate({ id: 't/x', version: '0.1.0', title: 't', site: ['example.com'], startOn, steps: [{ id: 'w', action: 'wait', ms: 1 }] });
  assert.equal(so({ when: { urlContains: '/search' }, goto: 'https://example.com/search' }).ok, true);
  assert.match(JSON.stringify(so({ when: { urlContains: '/s' }, goto: 'https://evil.com/' }).errors), /not in site/);
  assert.match(JSON.stringify(so({ when: { bogus: 1 } }).errors), /unknown condition/);
});

test('profiles: one rule picks the profile when -p is not given', async () => {
  const { siteKey, resolveProfile } = await import('../dist/browser.js');
  const { defaultProfile } = await import('../dist/engine.js');
  assert.equal(siteKey('https://www.Example.com:8080/a'), 'example.com');
  assert.equal(siteKey('*.example.com'), 'example.com');
  assert.equal(siteKey('*'), null);
  assert.equal(siteKey('data:text/html,x'), null);
  assert.equal(defaultProfile({ site: ['*.example.com'] }), 'example.com/default');
  assert.equal(defaultProfile({ site: ['*'] }), 'default/default');
  const prev = process.env.BROWSER_RECIPEWRIGHT_HOME;
  process.env.BROWSER_RECIPEWRIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-prof-'));
  try {
    assert.deepEqual(await resolveProfile({ explicit: 'a.com/x' }), { profile: 'a.com/x', why: '-p' });
    assert.equal((await resolveProfile({ site: 'www.a.com' })).profile, 'a.com/default');
    assert.equal((await resolveProfile({ url: 'https://b.com/p', urlFirst: true })).profile, 'b.com/default');
    // nothing running
    assert.equal((await resolveProfile({})).profile, 'default/default');
    assert.equal((await resolveProfile({ url: 'https://c.com' })).profile, 'c.com/default');
  } finally {
    if (prev === undefined) delete process.env.BROWSER_RECIPEWRIGHT_HOME; else process.env.BROWSER_RECIPEWRIGHT_HOME = prev;
  }
});

test('usage is counted per site+account, per day (used for reminders only)', async () => {
  const { recordUsage, usageOf, itemsOf, usageFile } = await import('../dist/usage.js');
  const prev = process.env.BROWSER_RECIPEWRIGHT_HOME;
  process.env.BROWSER_RECIPEWRIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'brw-usage-'));
  try {
    const now = new Date(2026, 10, 26, 15, 30);
    recordUsage('a.com/main', 10, new Date(2026, 10, 25, 23, 0)); // yesterday
    recordUsage('a.com/main', 5, new Date(2026, 10, 26, 9, 0));
    recordUsage('b.com/main', 7, new Date(2026, 10, 26, 9, 0)); // same account id, other site: counted apart
    assert.match(usageFile('a.com/main'), /a\.com__main\.json$/);
    assert.deepEqual(usageOf('a.com/main', now), { runsToday: 1, itemsToday: 5 });
    assert.deepEqual(usageOf('b.com/main', now), { runsToday: 1, itemsToday: 7 });
    assert.equal(itemsOf('success', [1, 2, 3]), 3);
    assert.equal(itemsOf('failed', [1]), 0);
    assert.equal(itemsOf('success', { a: 1 }), 1);
  } finally {
    if (prev === undefined) delete process.env.BROWSER_RECIPEWRIGHT_HOME; else process.env.BROWSER_RECIPEWRIGHT_HOME = prev;
  }
});
