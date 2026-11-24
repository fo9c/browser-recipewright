// Unit tests (no browser): node --test tests/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateTemplate } from '../dist/validate.js';
import { render, parseCount } from '../dist/render.js';
import { evalCond } from '../dist/conditions.js';
import { applyPatch } from '../dist/heal.js';
import { coerceInputs, postFields } from '../dist/engine.js';
import { parseCsv, planJobs } from '../dist/batch.js';
import { checkSchema } from '../dist/jsonschema.js';
import { buildJsonSchema } from '../dist/schema.js';

const load = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url)));

test('built-in templates are valid', () => {
  for (const p of ['../templates/x.com/search-read-posts.json', '../templates/demo/local-feed.json']) {
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
  assert.equal(render('https://x.com{{post.url}}', scope), 'https://x.com/u/status/1');
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
  const tpl = load('../templates/x.com/search-read-posts.json');
  assert.throws(() => coerceInputs(tpl, {}), /missing required input "keyword"/);
  const v = coerceInputs(tpl, { keyword: 'ai', count: '3' });
  assert.equal(v.count, 3);
  assert.equal(v.minLikes, 50);
  assert.throws(() => coerceInputs(tpl, { keyword: 'ai', tab: 'nope' }), /must be one of/);
  assert.throws(() => coerceInputs(tpl, { keyword: 'ai', bogus: 1 }), /unknown input/);
});

test('applyPatch: step-scoped ops + version bump + provenance', () => {
  const tpl = load('../templates/x.com/search-read-posts.json');
  const { template } = applyPatch(tpl, [
    { stepId: 'collect-posts', op: 'merge', value: { maxScrolls: 60 }, note: 'more scrolling' },
    { stepId: 'read-main', ops: [{ op: 'replace', path: '/target/0', value: { testid: 'tweet', nth: 0 } }] },
    { stepId: 'rest', op: 'remove' },
  ]);
  assert.equal(template.version, '0.1.1');
  assert.equal(template.steps[1].maxScrolls, 60);
  assert.equal(template.steps[3].do.length, 3);
  assert.equal(template.provenance.repairs.at(-1).steps.length, 3);
  assert.equal(validateTemplate(template).ok, true);
  assert.throws(() => applyPatch(tpl, { stepId: 'nope', op: 'remove' }), /not found/);
});

test('batch planning: accounts × jobs, csv', () => {
  assert.deepEqual(parseCsv('id,profile,keyword\na,x.com/a,"hello, world"\nb,,\n'), [
    { id: 'a', profile: 'x.com/a', keyword: 'hello, world' },
    { id: 'b', profile: '', keyword: '' },
  ]);
  const jobs = planJobs({ _site: 'x.com', inputs: { count: 5 }, accounts: [{ id: 'a', inputs: { keyword: 'k1' } }, { id: 'b' }] }, '.');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].account.profile, 'x.com/a');
  assert.deepEqual(jobs[0].inputs, { count: 5, keyword: 'k1' });
  const j2 = planJobs({ _site: 'x.com', accounts: [{ id: 'a' }], jobs: [{ account: 'a', inputs: { keyword: 1 } }, { account: 'a', inputs: { keyword: 2 } }] }, '.');
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
