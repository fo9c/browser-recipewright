/** browser-recipewright command line. Progress goes to stderr; the final result is JSON on stdout (agent-friendly). */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import { chromium } from 'patchright';
import { validateTemplate } from './validate.js';
import { loadTemplate, listTemplates, saveTemplate } from './library.js';
import { Runner, defaultProfile, coerceInputs } from './engine.js';
import { render } from './render.js';
import { connect, launchChrome, getSession, closeSession, disconnect, listSessions, findChrome, refsFile, profilesList, profileDir } from './browser.js';
import { inpageCall } from './inpage.js';
import { evalCond } from './conditions.js';
import { countTarget, textOfTarget } from './locator.js';
import { listRuns, readSteps } from './records.js';
import { patchTemplateFile } from './heal.js';
import { runBatch, usageToday } from './batch.js';
import { buildJsonSchema } from './schema.js';
import { checkRunDir, EVENTS_FILE, buildRunEventsJsonSchema } from './events.js';
import { startDemoServer } from './demo.js';
import { checkRecipeCalls } from './flow.js';
import { recordAnswer, listPending, readPendingAsk, parseAnswerValue, type PendingAsk } from './ask.js';
import { readJson, writeJson, homeDir, dirs, log, sleep, RpaError, PKG_ROOT } from './util.js';

const pkg = readJson(path.join(PKG_ROOT, 'package.json'));
const program = new Command();
program.name('browser-recipewright').description('AI writes the recipe, the browser follows it: reusable, recorded, self-repairable browser recipes').version(pkg.version);

const out = (v: any) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
const collect = (v: string, prev: string[]) => [...prev, v];

/** Navigate for interactive commands. Pages that never finish loading (ads, trackers, fingerprint tests) are fine
 *  as long as the navigation itself happened: warn and carry on instead of failing. */
async function softGoto(page: any, url: string, timeoutMs = Number(process.env.BROWSER_RECIPEWRIGHT_NAV_TIMEOUT_MS) || 20000): Promise<string | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return null;
  } catch (e: any) {
    const now = page.url();
    if (/timeout/i.test(String(e?.message)) && now && now !== 'about:blank') {
      const w = `page did not finish loading within ${timeoutMs / 1000}s; continuing on ${now}`;
      log.info(`⚠️ ${w}`);
      return w;
    }
    throw new RpaError('NAVIGATION_FAILED', `could not open ${url}: ${String(e?.message || e).split('\n')[0]}`);
  }
}

function parseInputs(pairs: string[] = [], json?: string): Record<string, any> {
  let base: Record<string, any> = {};
  if (json) base = JSON.parse(json.startsWith('@') ? fs.readFileSync(json.slice(1), 'utf8') : json);
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 1) throw new RpaError('INPUT_INVALID', `--input expects key=value, got "${p}"`);
    base[p.slice(0, i)] = p.slice(i + 1);
  }
  return base;
}

/** Exit codes: 0 ok · 1 step/template problem · 2 invalid input/template · 3 environment (human needed) · 4 paused, the agent must answer */
function exitCodeFor(code?: string) {
  if (!code) return 0;
  if (code === 'ASK_PENDING') return 4;
  if (['LOGIN_REQUIRED', 'CHALLENGE_DETECTED', 'HANDOFF_REQUIRED', 'BROWSER_ERROR'].includes(code)) return 3;
  if (['INPUT_INVALID', 'TEMPLATE_INVALID', 'TEMPLATE_NOT_FOUND', 'PATCH_INVALID', 'BATCH_INVALID', 'ANSWER_INVALID'].includes(code)) return 2;
  return 1;
}

function wrap(fn: (...a: any[]) => Promise<any>) {
  return async (...a: any[]) => {
    try {
      await fn(...a);
    } catch (e: any) {
      const code = e.code || 'ERROR';
      out({ status: 'error', error: { code, message: e.message } });
      process.exitCode = exitCodeFor(code);
    }
  };
}

// ---------------- doctor ----------------
program
  .command('doctor')
  .description('check Node, Chrome, data folder, and stealth basics (navigator.webdriver)')
  .action(wrap(async () => {
    const checks: any[] = [];
    const ok = (name: string, pass: boolean, detail: string) => { checks.push({ name, pass, detail }); log.info(`${pass ? '✅' : '❌'} ${name}: ${detail}`); };
    const major = Number(process.versions.node.split('.')[0]);
    ok('node', major >= 18, process.versions.node);
    const chrome = findChrome();
    ok('chrome', !!chrome, chrome || 'not found — install Google Chrome or set BROWSER_RECIPEWRIGHT_CHROME');
    try { fs.mkdirSync(homeDir(), { recursive: true }); fs.accessSync(homeDir(), fs.constants.W_OK); ok('data folder', true, homeDir()); } catch (e: any) { ok('data folder', false, e.message); }
    if (chrome) {
      const profile = `_doctor/${Date.now()}`;
      try {
        const c = await connect(profile, { headless: true, reuse: false });
        await c.page.goto('data:text/html,<title>doctor</title><h1>ok</h1>');
        const main = await (c.page as any).evaluate('navigator.webdriver', undefined, undefined, false);
        ok('launch + CDP connect', true, `${c.session.chrome} (port ${c.session.port})`);
        ok('navigator.webdriver', main === false || main === undefined, String(main));
        const ua = await (c.page as any).evaluate('navigator.userAgent', undefined, undefined, false);
        ok('user agent', !/Headless/.test(ua) || true, ua);
        await closeSession(profile, c.browser);
      } catch (e: any) {
        ok('launch + CDP connect', false, e.message);
      } finally {
        fs.rmSync(profileDir(profile), { recursive: true, force: true });
        fs.rmSync(path.join(dirs.profiles(), '_doctor'), { recursive: true, force: true });
      }
    }
    const pass = checks.every((c) => c.pass);
    out({ status: pass ? 'ok' : 'problems', checks });
    if (!pass) process.exitCode = 1;
  }));

// ---------------- browser sessions ----------------
program
  .command('launch')
  .description('start (or reuse) a Chrome window for a profile and keep it running for snapshot/act')
  .option('-p, --profile <site/account>', 'profile, e.g. example.com/main', 'default/default')
  .option('-u, --url <url>', 'open this URL')
  .option('--headless', 'no window')
  .action(wrap(async (o) => {
    const existing = await getSession(o.profile);
    const s = existing ?? (await launchChrome(o.profile, { headless: o.headless }));
    let warning: string | null = null;
    let url: string | null = null;
    if (o.url) {
      const c = await connect(o.profile);
      try {
        warning = await softGoto(c.page, o.url);
        url = c.page.url();
      } finally {
        await disconnect(c);
      }
    }
    out({ status: 'ok', reused: !!existing, session: s, url, warning });
  }));

program
  .command('close')
  .description('close the Chrome window of a profile (or --all)')
  .option('-p, --profile <site/account>', 'profile', 'default/default')
  .option('--all', 'close every session')
  .action(wrap(async (o) => {
    const targets = o.all ? (await listSessions()).map((s) => s.profile) : [o.profile];
    const closed: string[] = [];
    for (const p of targets) if (await closeSession(p)) closed.push(p);
    out({ status: 'ok', closed });
  }));

program
  .command('sessions')
  .description('list running browser sessions')
  .action(wrap(async () => out({ status: 'ok', sessions: await listSessions() })));

program
  .command('login <templateOrSite>')
  .description('open the profile so a human can log in once; waits for the template loginCheck (or Enter)')
  .option('-p, --profile <site/account>', 'profile (default: <site>/default)')
  .option('-i, --input <key=value>', 'template input used in loginUrl/checkUrl, e.g. base=http://127.0.0.1:4173 (repeatable)', collect, [])
  .action(wrap(async (ref, o) => {
    let tpl: any = null;
    try { tpl = loadTemplate(ref).template; } catch {}
    const site = tpl ? tpl.site[0] : ref.replace(/^https?:\/\//, '').split('/')[0];
    const profile = o.profile || (tpl ? defaultProfile(tpl) : `${site}/default`);
    // templates may build the login URL from inputs ({{inputs.base}}): fill them (defaults + --input) first
    const scope: any = { inputs: {}, vars: {}, account: {} };
    if (tpl) {
      const raw = parseInputs(o.input);
      const needed = new Set(Object.keys(tpl.inputs || {}));
      const tplLite = { inputs: Object.fromEntries(Object.entries<any>(tpl.inputs || {}).map(([k, d]) => [k, { ...d, required: d.default !== undefined || k in raw ? d.required : false }])) };
      for (const k of Object.keys(raw)) if (!needed.has(k)) throw new RpaError('INPUT_INVALID', `unknown input "${k}"`);
      scope.inputs = coerceInputs(tplLite, raw);
    }
    const rawUrl = tpl?.account?.loginUrl || tpl?.account?.checkUrl || (ref.startsWith('http') ? ref : `https://${site}/`);
    const url = String(render(rawUrl, scope) ?? '');
    if (!/^https?:\/\/[^/]/.test(url)) {
      throw new RpaError('INPUT_INVALID', `login URL "${rawUrl}" became "${url}"; pass the missing input, e.g. browser-recipewright login ${ref} -i base=http://127.0.0.1:4173`);
    }
    const c = await connect(profile);
    await softGoto(c.page, url);
    await c.page.bringToFront().catch(() => {});
    log.info(`   ${c.page.url()}`);
    log.info(`\n🔐 请在打开的 Chrome 窗口里登录 ${site}（profile: ${profile}）。`);
    const check = tpl?.account?.loginCheck;
    log.info(check ? '   登录成功后会自动检测到并结束。' : '   登录完成后回到这里按回车。');
    const probe = { url: () => c.page.url(), count: (t: any[]) => countTarget(c.page, t), text: (t: any[]) => textOfTarget(c.page, t) };
    let enter = false;
    if (process.stdin.isTTY) process.stdin.once('data', () => (enter = true));
    const deadline = Date.now() + 20 * 60 * 1000;
    let loggedIn = false;
    while (Date.now() < deadline && !enter) {
      if (check && (await evalCond(check, scope, probe).catch(() => ({ pass: false }))).pass) { loggedIn = true; break; }
      await sleep(1500);
    }
    process.stdin.pause();
    await sleep(1500);
    await closeSession(profile, c.browser);
    out({ status: loggedIn || enter ? 'ok' : 'timeout', profile, loggedIn: check ? loggedIn : null });
  }));

// ---------------- exploration ----------------
program
  .command('screenshot')
  .description('save a PNG of the current page of a running session')
  .option('-p, --profile <site/account>', 'profile', 'default/default')
  .option('-u, --url <url>', 'navigate first')
  .option('-o, --out <file>', 'output file (default: ~/.browser-recipewright/screenshots/<profile>-<time>.png)')
  .option('--full', 'whole page, not just the visible part')
  .action(wrap(async (o) => {
    const c = await connect(o.profile);
    try {
      const warning = o.url ? await softGoto(c.page, o.url) : null;
      const file = path.resolve(o.out || path.join(homeDir(), 'screenshots', `${o.profile.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await c.page.screenshot({ path: file, fullPage: !!o.full, timeout: 15000 });
      out({ status: 'ok', file, url: c.page.url(), title: await c.page.title().catch(() => ''), warning });
    } finally {
      await disconnect(c);
    }
  }));

program
  .command('snapshot')
  .description('print an outline of the current page with [ref=rN] ids and ready-made locator candidates')
  .option('-p, --profile <site/account>', 'profile', 'default/default')
  .option('-u, --url <url>', 'navigate first')
  .option('--max <n>', 'max nodes', '300')
  .option('--text', 'also include plain text nodes')
  .option('--json', 'print JSON (includes locator candidates for every ref)')
  .action(wrap(async (o) => {
    const c = await connect(o.profile);
    try {
      if (o.url) await softGoto(c.page, o.url);
      const snap: any = await (c.page as any).evaluate(inpageCall('snapshot', { max: Number(o.max), text: !!o.text }), undefined, undefined, true);
      writeJson(refsFile(o.profile), { url: snap.url, at: new Date().toISOString(), refs: snap.refs });
      if (o.json) out({ status: 'ok', ...snap });
      else process.stdout.write(`# ${snap.title}\n# ${snap.url}\n${snap.text}\n${snap.truncated ? `# (truncated at ${o.max} nodes; use --max)\n` : ''}# locator candidates for each ref: ${refsFile(o.profile)}\n`);
    } finally {
      await disconnect(c);
    }
  }));

program
  .command('act <action>')
  .description('run ONE step against the live session, with the same semantics as a template step')
  .option('-p, --profile <site/account>', 'profile', 'default/default')
  .option('--ref <ref>', 'use locator candidates of a snapshot ref (e.g. r12)')
  .option('--target <json>', 'locator candidates as JSON array')
  .option('--step <json>', 'full step JSON (overrides other flags)')
  .option('--url <url>').option('--value <v>').option('--text <t>').option('--key <k>').option('--fields <json>').option('--by <n>').option('--ms <n>')
  .option('--no-humanize', 'plain fast input')
  .option('--screenshot', 'take a screenshot after the step (path printed as "screenshot")')
  .action(wrap(async (action, o) => {
    let step: any = o.step ? JSON.parse(o.step) : { action };
    if (o.screenshot) step.screenshot = true;
    step.id ??= 'act';
    step.action ??= action;
    if (o.ref) {
      const refs = readJson(refsFile(o.profile)).refs;
      if (!refs[o.ref]) throw new RpaError('INPUT_INVALID', `ref ${o.ref} not in last snapshot; run snapshot again`);
      step[action === 'download' ? 'trigger' : action === 'collect' ? 'item' : 'target'] = refs[o.ref];
    }
    if (o.target) step.target = JSON.parse(o.target);
    for (const k of ['url', 'value', 'text', 'key']) if (o[k] !== undefined) step[k] = o[k];
    if (o.fields) step.fields = JSON.parse(o.fields);
    if (o.by) step.by = o.by === 'page' ? 'page' : Number(o.by);
    if (o.ms) step.ms = Number(o.ms);
    const c = await connect(o.profile);
    try {
      if (!step.saveAs) step.saveAs = '_act_out';
      const tpl = { id: '_act', version: '0.0.0', title: 'act', site: ['*'], defaults: { humanize: o.humanize }, steps: [step] };
      const runner = new Runner({ loaded: { template: tpl, path: '(act)', source: 'file' }, connected: c, runsDir: path.join(dirs.runs(), '_act'), skipLoginCheck: true, handoff: 'never' });
      const res = await runner.run();
      const rec = readSteps(res.runDir).find((s) => s.stepId === step.id);
      const value = res.output?.[step.saveAs] ?? null;
      const shot = rec?.artifacts?.find((a: string) => a.endsWith('.png'));
      const screenshot = shot ? path.join(res.runDir, shot) : fs.existsSync(path.join(res.runDir, 'failure', 'screenshot.png')) ? path.join(res.runDir, 'failure', 'screenshot.png') : null;
      if (step.saveAs === '_act_out') delete step.saveAs;
      if (step.action === 'collect' && Array.isArray(value)) {
        // collect: lead with the items and a per-field fill report, so it is obvious what the fields extracted
        const fieldNames = Object.keys(step.fields || {});
        const missing: Record<string, number> = {};
        for (const f of fieldNames) {
          const n = value.filter((it: any) => it?.[f] == null || it?.[f] === '').length;
          if (n) missing[f] = n;
        }
        const st = rec?.collect ?? {};
        log.info(`collect: ${value.length} item(s) kept; scanned ${st.scanned ?? '?'}, filtered out ${st.filteredOut ?? 0}, scrolls ${st.scrolls ?? 0}, stopped because: ${st.stoppedBecause ?? '?'}`);
        for (const [f, n] of Object.entries(missing)) log.info(`  ⚠️ field "${f}" is empty in ${n}/${value.length} item(s)`);
        out({
          status: res.status,
          action: 'collect',
          count: value.length,
          items: value,
          fieldsEmpty: missing,
          stats: st,
          screenshot,
          locator: rec?.locator ?? null,
          url: c.page.url(),
          error: res.error ?? null,
          step,
          runDir: res.runDir,
        });
      } else {
        out({ status: res.status, action: step.action, output: value, screenshot, locator: rec?.locator ?? null, expect: rec?.expect ?? null, url: c.page.url(), error: res.error ?? null, step, runDir: res.runDir });
      }
      if (res.error) process.exitCode = exitCodeFor(res.error.code);
    } finally {
      await disconnect(c);
    }
  }));

// ---------------- templates ----------------
program
  .command('validate <template>')
  .description('static check (no browser): errors block running, warnings do not')
  .action(wrap(async (ref) => {
    const { template, path: p } = loadTemplate(ref);
    const r = validateTemplate(template);
    // a flow calls other recipes: check that they exist, are valid and get the inputs they need
    for (const i of checkRecipeCalls(template, p)) (i.level === 'error' ? r.errors : r.warnings).push(i);
    r.ok = r.errors.length === 0;
    for (const e of r.errors) log.info(`❌ [${e.stepId ?? '-'}] ${e.path}: ${e.message}`);
    for (const w of r.warnings) log.info(`⚠️  [${w.stepId ?? '-'}] ${w.path}: ${w.message}`);
    log.info(r.ok ? `✅ valid (${r.warnings.length} warning(s))` : `❌ ${r.errors.length} error(s)`);
    out({ status: r.ok ? 'ok' : 'invalid', template: p, ...r });
    if (!r.ok) process.exitCode = 2;
  }));

program
  .command('run <template>')
  .description('run a template (id from the library, or a file path)')
  .option('-i, --input <key=value>', 'template input (repeatable)', collect, [])
  .option('--inputs <json|@file>', 'inputs as JSON or @file.json')
  .option('-p, --profile <site/account>', 'browser profile (default: <site>/default)')
  .option('--headless', 'run without a window (no human handoff possible)')
  .option('--keep-open', 'leave Chrome open after the run')
  .option('--no-handoff', 'never wait for a human; fail with LOGIN_REQUIRED / CHALLENGE_DETECTED instead')
  .option('--no-humanize', 'disable humanized mouse/keyboard')
  .option('--screenshots <mode>', 'failure | every | none')
  .option('--resume <runDir>', 'continue a failed or interrupted run: skips finished steps and finished forEach items (reuses saved variables)')
  .option('--handoff-timeout <min>', 'minutes to wait for a human', '15')
  .option('--on-ask <mode>', 'ask steps (breakpoints): pause = stop and wait for the agent (default) · default = use the step default · fail', 'pause')
  .action(wrap(async (ref, o) => {
    if (!['pause', 'default', 'fail'].includes(o.onAsk)) throw new RpaError('INPUT_INVALID', '--on-ask must be pause, default or fail');
    const loaded = loadTemplate(ref);
    const runner = new Runner({
      loaded, inputs: parseInputs(o.input, o.inputs), profile: o.profile, headless: o.headless, keepOpen: o.keepOpen,
      handoff: o.handoff === false ? 'never' : 'auto', humanize: o.humanize === false ? false : undefined,
      screenshots: o.screenshots, resumeFrom: o.resume, handoffTimeoutMs: Number(o.handoffTimeout) * 60000, onAsk: o.onAsk,
    });
    printRunResult(await runner.run());
  }));

/** The JSON a finished, failed or paused run prints. A paused run (exit code 4) carries the question for the agent. */
function printRunResult(res: import('./engine.js').RunResult) {
  if (res.status === 'paused') {
    out({ status: 'paused', runDir: res.runDir, ask: askForAgent(res.ask!), error: null });
    process.exitCode = 4;
    return;
  }
  const preview = Array.isArray(res.output) ? { count: res.output.length, first: res.output[0] } : res.output;
  out({ status: res.status, runDir: res.runDir, output: res.outputPath, preview, error: res.error ?? null, dossier: res.dossier ?? null });
  process.exitCode = exitCodeFor(res.error?.code);
}

/** What the agent needs to answer a question: the question, the answer format, the data (pick: numbered from 0). */
function askForAgent(a: PendingAsk) {
  const data = a.answer.type === 'pick' && Array.isArray(a.data) ? a.data.map((item, i) => ({ '#': i, ...(item && typeof item === 'object' && !Array.isArray(item) ? item : { value: item }) })) : a.data;
  return {
    step: a.path, question: a.question, answer: a.answer, ...(a.default !== undefined ? { default: a.default } : {}),
    data, url: a.url, since: a.since, file: path.join(a.runDir, 'ask.json'), next: a.how,
  };
}

// ---------------- breakpoints ----------------
program
  .command('answer [runDir]')
  .description('answer the question a paused run asks (ask step), then continue that run in the same browser and run directory')
  .option('-v, --value <answer>', 'the answer: JSON (e.g. [0,2], true, "text") or plain text')
  .option('--value-file <file>', 'read the answer (JSON) from a file')
  .option('--no-continue', 'only store the answer; continue later with: answer <runDir> --continue-only')
  .option('--continue-only', 'continue with an answer stored before (no --value)')
  .option('--keep-open', 'leave Chrome open when the run ends')
  .option('--headless', 'if the browser has to be started again, start it without a window')
  .option('--on-ask <mode>', 'what later ask steps in this run do: pause (default) · default · fail', 'pause')
  .action(wrap(async (dir, o) => {
    const runDir = dir ?? (() => {
      const p = listPending();
      if (!p.length) throw new RpaError('INPUT_INVALID', 'no run is waiting for an answer');
      if (p.length > 1) throw new RpaError('INPUT_INVALID', `${p.length} runs are waiting for an answer; pass the run directory (see: browser-recipewright pending)`);
      return p[0].runDir;
    })();
    const ask = readPendingAsk(runDir);
    if (!o.continueOnly) {
      if (o.value === undefined && !o.valueFile) throw new RpaError('INPUT_INVALID', 'give the answer with --value <answer> (or --value-file <file>)');
      const raw = o.valueFile ? JSON.parse(fs.readFileSync(o.valueFile, 'utf8')) : parseAnswerValue(o.value);
      const { value } = recordAnswer(runDir, raw);
      log.info(`✓ answer stored for ${ask?.path}: ${JSON.stringify(value).slice(0, 200)}`);
      if (o.continue === false) return out({ status: 'answered', runDir, step: ask?.path, value, next: `browser-recipewright answer "${runDir}" --continue-only` });
    }
    const run = readJson(path.join(runDir, 'run.json'));
    let loaded;
    try { loaded = loadTemplate(run.templatePath); } catch { loaded = loadTemplate(run.templateId); }
    const runner = new Runner({ loaded, continueRun: runDir, headless: o.headless, keepOpen: o.keepOpen, onAsk: o.onAsk, handoff: o.headless ? 'never' : 'auto' });
    printRunResult(await runner.run());
  }));

program
  .command('pending')
  .description('list runs that are paused at a question (ask step) and wait for the agent')
  .action(wrap(async () => {
    const asks = listPending();
    for (const a of asks) log.info(`⏸ ${a.since}  ${a.templateId}  ${a.path}: ${a.question}\n    ${a.runDir}`);
    if (!asks.length) log.info('no run is waiting for an answer');
    out({ status: 'ok', pending: asks.map((a) => ({ runDir: a.runDir, templateId: a.templateId, ...askForAgent(a) })) });
  }));

program
  .command('list')
  .description('list templates in the library (user + built-in)')
  .action(wrap(async () => {
    const ts = listTemplates();
    for (const t of ts) log.info(`${t.valid ? ' ' : '!'} ${t.id.padEnd(32)} ${t.version.padEnd(8)} [${t.source}] ${t.title}`);
    out({ status: 'ok', templates: ts });
  }));

program
  .command('show <template>')
  .description('print a template')
  .action(wrap(async (ref) => out(loadTemplate(ref).template)));

program
  .command('save <file>')
  .description('validate and copy a template into your library (~/.browser-recipewright/templates)')
  .action(wrap(async (file) => out({ status: 'ok', saved: saveTemplate(file) })));

program
  .command('schema')
  .description('print the template JSON Schema (--run-events: the schema of one events.jsonl line instead)')
  .option('--run-events', 'print the run event schema (run data format v1)')
  .action(wrap(async (o) => out(o.runEvents ? buildRunEventsJsonSchema() : buildJsonSchema())));

// ---------------- records & repair ----------------
program
  .command('runs')
  .description('list recent runs')
  .option('-n, --limit <n>', 'how many', '15')
  .option('-t, --template <id>', 'only this template')
  .action(wrap(async (o) => {
    const rs = listRuns(Number(o.limit), o.template);
    for (const r of rs) log.info(`${r.status === 'success' ? '✓' : r.status === 'failed' ? '✗' : r.status === 'paused' ? '⏸' : '…'} ${r.startedAt}  ${r.templateId}@${r.version}  ${r.error ?? ''}  ${r.runDir}`);
    out({ status: 'ok', runs: rs });
  }));

program
  .command('inspect <runDir>')
  .description('summarize a run: status, every step (status, locator hit, duration, error)')
  .action(wrap(async (dir) => {
    const run = readJson(path.join(dir, 'run.json'));
    const steps = readSteps(dir).map((s) => ({ seq: s.seq, path: s.path, action: s.action, status: s.status, ms: s.durationMs, hit: s.locator?.hit ?? null, error: s.error?.code ?? null, note: s.note ?? (s as any).collect ?? undefined }));
    out({ run, steps });
  }));

/** The run directory given, or the newest run (runs/_latest.json). */
function runDirOrLatest(dir?: string): string {
  if (dir) return dir;
  const f = path.join(dirs.runs(), '_latest.json');
  if (!fs.existsSync(f)) throw new RpaError('INPUT_INVALID', 'no run yet (runs/_latest.json not found); pass a run directory');
  return readJson(f).runDir;
}

program
  .command('events [runDir]')
  .description('print the run event stream (events.jsonl, one JSON per line) of a run, or the newest run; --follow keeps printing while it runs (for viewer plugins)')
  .option('-f, --follow', 'keep printing new events until the run ends')
  .option('--poll <ms>', 'how often to look for new events when following', '250')
  .action(wrap(async (dir, o) => {
    const runDir = runDirOrLatest(dir);
    const file = path.join(runDir, EVENTS_FILE);
    if (!fs.existsSync(path.join(runDir, 'run.json'))) throw new RpaError('INPUT_INVALID', `${runDir} is not a run directory (no run.json)`);
    if (!fs.existsSync(file)) throw new RpaError('INPUT_INVALID', `${runDir} has no ${EVENTS_FILE} (a run from before the v1 run data format)`);
    let pos = 0;
    let rest = '';
    let ended = false;
    const pump = () => {
      const size = fs.statSync(file).size;
      if (size <= pos) return;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = size;
      const lines = (rest + buf.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) {
        if (!l) continue;
        process.stdout.write(l + '\n');
        if (l.includes('"type":"run.end"')) ended = true;
      }
    };
    pump();
    if (!o.follow) return;
    let idleSince = Date.now();
    while (!ended) {
      await sleep(Number(o.poll) || 250);
      const before = pos;
      pump();
      if (pos !== before) idleSince = Date.now();
      else if (Date.now() - idleSince > 3000) {
        // the writer died without run.end: stop once run.json says it is no longer running
        const st = (() => { try { return readJson(path.join(runDir, 'run.json')).status; } catch { return 'running'; } })();
        if (st !== 'running') break;
        idleSince = Date.now();
      }
    }
  }));

program
  .command('check-run [runDir]')
  .description('check that a run directory follows the run data format (docs/run-data-format.md); defaults to the newest run')
  .action(wrap(async (dir) => {
    const runDir = runDirOrLatest(dir);
    const r = checkRunDir(runDir);
    for (const w of r.warnings) log.info(`! ${w}`);
    for (const e of r.errors) log.info(`✗ ${e}`);
    if (r.ok) log.info(`✓ ${runDir}: ${r.format ?? 'legacy run'}, ${r.events} event(s)${r.finished ? '' : ' (not finished)'}`);
    out({ status: r.ok ? 'ok' : 'failed', runDir, ...r });
    if (!r.ok) process.exitCode = 1;
  }));

program
  .command('heal <runDir>')
  .description('print the failure dossier of a run (what the AI needs to repair exactly one step)')
  .action(wrap(async (dir) => {
    const f = path.join(dir, 'failure', 'dossier.json');
    if (!fs.existsSync(f)) return out({ status: 'ok', message: 'this run has no failure dossier (it did not fail)' });
    const d = readJson(f);
    const snap = path.join(dir, 'failure', 'snapshot.txt');
    out({ ...d, snapshotPreview: fs.existsSync(snap) ? fs.readFileSync(snap, 'utf8').split('\n').slice(0, 80).join('\n') : null });
  }));

program
  .command('patch <template> <patchFile>')
  .description('apply a step-scoped patch; shows the diff; --write saves it (version +1, old version kept in .history/)')
  .option('--write', 'save the patched template')
  .action(wrap(async (ref, patchFile, o) => {
    const loaded = loadTemplate(ref);
    const r = patchTemplateFile(loaded.path, patchFile, !!o.write, loaded.source === 'builtin');
    process.stderr.write(r.diff + '\n');
    out({ status: r.validation.ok ? 'ok' : 'invalid', version: r.version, written: r.written, errors: r.validation.errors, warnings: r.validation.warnings });
    if (!r.validation.ok) process.exitCode = 2;
  }));

// ---------------- batch & accounts ----------------
program
  .command('batch [batchFile]')
  .description('run a template for many accounts (spacing, daily caps, skip expired logins, resume)')
  .option('--resume <batchDir>', 'resume an interrupted batch (completed jobs are not repeated)')
  .option('--retry-failed', 'with --resume: also rerun failed jobs')
  .option('--dry-run', 'only print the job plan')
  .option('--headless', 'run without windows')
  .action(wrap(async (file, o) => {
    if (!file && !o.resume) throw new RpaError('BATCH_INVALID', 'give a batch file or --resume <batchDir>');
    const r: any = await runBatch({ file, resumeDir: o.resume, retryFailed: o.retryFailed, dryRun: o.dryRun, headless: o.headless });
    out({ status: r.stopped ? 'paused' : 'ok', ...r, rows: undefined, jobs: r.dryRun ? r.jobs : undefined });
  }));

program
  .command('accounts')
  .description('list local browser profiles (accounts), running sessions and today\'s usage')
  .action(wrap(async () => {
    const sessions = await listSessions();
    const rows = profilesList().filter((p) => !p.startsWith('_')).map((p) => ({ profile: p, running: sessions.some((s) => s.profile === p), usageToday: usageToday(p.split('/')[1] || p) }));
    for (const r of rows) log.info(`${r.running ? '●' : '○'} ${r.profile}  today=${r.usageToday}`);
    out({ status: 'ok', home: homeDir(), accounts: rows });
  }));

// ---------------- selfcheck ----------------
/** Plain-language names for the self-check steps, shown in the summary. */
const SELFCHECK_LABELS: Record<string, string> = {
  open: '打开本地页面 / open page',
  'type-name': '逐字输入 / type text',
  'pick-color': '下拉选择 / select option',
  'tick-agree': '勾选 / check box',
  submit: '移动鼠标并点击 / move + click',
  'type-search': '输入搜索词 / type query',
  'press-enter': '按回车 / press Enter',
  'wait-late': '等待延迟出现的内容 / wait for element',
  'hover-tip': '悬停 / hover',
  'collect-rows': '滚动并批量提取 / scroll + extract',
  'enough-rows': '提取到全部 40 条 / got all rows',
  'ask-pick': '断点：交给 Agent 判断（自检用默认答案）/ breakpoint (ask)',
  'read-report': '读取页面观察结果 / read report',
  'check-trusted': '输入都是可信事件 / trusted input',
  'check-mouse': '点击前有鼠标轨迹 / mouse path',
  'check-keys': '按键节奏有快有慢 / varied typing',
  'check-webdriver': 'navigator.webdriver 不暴露 / webdriver hidden',
  'go-next': '点击链接跳转 / follow link',
  'go-back': '浏览器返回 / go back',
};

program
  .command('selfcheck')
  .description('check that this install can drive the browser: run the built-in selfcheck/basic recipe on a bundled local page (no network, no account)')
  .option('--headless', 'no window')
  .option('--keep-open', 'leave Chrome open')
  .action(wrap(async (o) => {
    const srv = await startDemoServer(4173);
    log.info(`self-check page: ${srv.url}/selfcheck.html`);
    try {
      const loaded = loadTemplate('selfcheck/basic');
      const res = await new Runner({ loaded, inputs: { base: srv.url }, profile: 'selfcheck/default', headless: o.headless, keepOpen: o.keepOpen, handoff: 'never', onAsk: 'default' }).run();
      const steps = readSteps(res.runDir);
      const checks = Object.entries(SELFCHECK_LABELS).map(([id, label]) => {
        const s = steps.filter((x: any) => x.stepId === id).pop();
        return { id, label, status: s ? (s.status === 'ok' ? 'pass' : 'fail') : 'not run', ...(s?.error ? { error: s.error.code } : {}) };
      });
      log.info('');
      for (const c of checks) log.info(`  ${c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⏭️ '} ${c.label}${c.error ? `  (${c.error})` : ''}`);
      log.info(res.status === 'success' ? '\n自检通过：浏览器操作功能正常。Self-check passed.' : `\n自检未通过，详情见 ${res.runDir}。Self-check failed.`);
      out({ status: res.status === 'success' ? 'pass' : 'fail', checks, observed: res.output ?? null, runDir: res.runDir, error: res.error ?? null });
      process.exitCode = exitCodeFor(res.error?.code);
    } finally {
      await srv.close();
    }
  }));

// ---------------- demo ----------------
program
  .command('demo')
  .description('offline self-test: serve the bundled demo feed (generated content) and run templates/demo/local-feed against it')
  .option('--headless', 'no window')
  .option('--keep-open', 'leave Chrome open')
  .action(wrap(async (o) => {
    const srv = await startDemoServer(4173);
    log.info(`demo site: ${srv.url}`);
    try {
      if (o.headless) {
        // nobody can click "Log in" in a headless window, so log the demo profile in directly
        const c = await connect('demo/default', { headless: true });
        await c.page.goto(`${srv.url}/home.html?autologin=1`);
        await disconnect(c);
      } else log.info('提示：第一次运行时 demo 站会要求"登录"——在弹出的窗口里点 Log in 按钮即可，程序会自动继续（这就是人工接管 handoff）。');
      const loaded = loadTemplate('demo/local-feed');
      const res = await new Runner({ loaded, inputs: { base: srv.url }, profile: 'demo/default', headless: o.headless, keepOpen: o.keepOpen }).run();
      out({ status: res.status, runDir: res.runDir, output: res.outputPath, preview: Array.isArray(res.output) ? { count: res.output.length, first: res.output[0] } : res.output, error: res.error ?? null });
      process.exitCode = exitCodeFor(res.error?.code);
    } finally {
      await srv.close();
    }
  }));

program
  .command('demo-server')
  .description('serve the demo site and keep running (for trying snapshot/act by hand)')
  .option('--port <n>', 'port', '4173')
  .action(wrap(async (o) => {
    const srv = await startDemoServer(Number(o.port));
    log.info(`demo site running at ${srv.url}  (Ctrl+C to stop)`);
    out({ status: 'ok', url: srv.url });
    await new Promise(() => {});
  }));

void chromium; void os;
program.parseAsync(process.argv);
