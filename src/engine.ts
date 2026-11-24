/**
 * The executor: validate → (login check) → run steps one by one → write a record per step →
 * on failure write a dossier for the AI → validate outputs.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import type { Page } from 'patchright';
import { connect, closeSession, disconnect, type Connected } from './browser.js';
import { render, Scope, FILTERS, parseCount } from './render.js';
import { evalCond, type PageProbe, type CondResult } from './conditions.js';
import { resolveTarget, countTarget, textOfTarget } from './locator.js';
import { inpageCall, inpageElementFn } from './inpage.js';
import * as human from './human.js';
import { RunRecorder, StepRecord, ERROR_HINTS, errorCategory, lastSuccessFor, locatorDrift, readSteps } from './records.js';
import { checkSchema } from './jsonschema.js';
import { loadScriptCode, hostMatches } from './scripts.js';
import { validateTemplate } from './validate.js';
import { appendTargets } from './schema.js';
import type { LoadedTemplate } from './library.js';
import { RpaError, sleep, pickMs, log, truncateForRecord, readJson, writeJson, ENV_ERROR_CODES } from './util.js';

export interface RunOptions {
  loaded: LoadedTemplate;
  inputs?: Record<string, any>;
  profile?: string;
  account?: Record<string, any>;
  headless?: boolean;
  keepOpen?: boolean;
  humanize?: boolean;
  screenshots?: 'failure' | 'every' | 'none';
  handoff?: 'auto' | 'never';
  handoffTimeoutMs?: number;
  resumeFrom?: string;
  runsDir?: string;
  connected?: Connected; // reuse an existing connection (act)
  skipLoginCheck?: boolean;
  forceClose?: boolean; // close the browser after the run even if it was already running (batch)
}

export interface RunResult {
  status: 'success' | 'failed';
  runDir: string;
  output: any;
  outputPath: string;
  error?: { code: string; message: string; stepId: string | null; path: string | null; category: 'env' | 'template' };
  dossier?: string;
}

class StepFailure extends RpaError {
  stepId: string;
  stepPath: string;
  constructor(err: RpaError, stepId: string, stepPath: string) {
    super(err.code, err.message, err.details);
    this.stepId = stepId;
    this.stepPath = stepPath;
  }
}

const CONTROL = new Set(['if', 'forEach', 'while', 'group']);
const RAW_KEYS = new Set(['expect', 'filter', 'until', 'that', 'when', 'do', 'then', 'else', 'steps', 'collectFrom', 'fields', 'item', 'in']);

export function defaultProfile(tpl: any): string {
  return `${(tpl.site?.[0] || 'default').replace(/^\*\./, '')}/default`;
}

export function coerceInputs(tpl: any, raw: Record<string, any> = {}): Record<string, any> {
  const defs = tpl.inputs || {};
  const out: Record<string, any> = {};
  for (const k of Object.keys(raw)) if (!(k in defs)) throw new RpaError('INPUT_INVALID', `unknown input "${k}" (template accepts: ${Object.keys(defs).join(', ') || 'none'})`);
  for (const [k, d] of Object.entries<any>(defs)) {
    let v = raw[k] !== undefined ? raw[k] : d.default;
    if (v === undefined) {
      if (d.required === false) continue;
      throw new RpaError('INPUT_INVALID', `missing required input "${k}"${d.description ? ` (${d.description})` : ''}. Pass --input ${k}=...`);
    }
    if (d.type === 'integer' || d.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || (d.type === 'integer' && !Number.isInteger(n))) throw new RpaError('INPUT_INVALID', `input "${k}" must be ${d.type}, got ${JSON.stringify(v)}`);
      v = n;
    } else if (d.type === 'boolean') v = v === true || v === 'true' || v === '1' || v === 1;
    else if ((d.type === 'array' || d.type === 'object') && typeof v === 'string') {
      try { v = JSON.parse(v); } catch { throw new RpaError('INPUT_INVALID', `input "${k}" must be JSON ${d.type}`); }
    } else if (d.type === 'string') v = String(v);
    if (d.enum && !d.enum.includes(v)) throw new RpaError('INPUT_INVALID', `input "${k}" must be one of ${JSON.stringify(d.enum)}`);
    out[k] = v;
  }
  return out;
}

export function maskInputs(tpl: any, inputs: Record<string, any>) {
  const out: any = { ...inputs };
  for (const [k, d] of Object.entries<any>(tpl.inputs || {})) if (d.secret && k in out) out[k] = '***';
  return out;
}

function normalizeError(e: any): RpaError {
  if (e instanceof RpaError) return e;
  const msg = String(e?.message || e);
  if (/has been closed|Target closed|Browser closed|browser has disconnected/i.test(msg)) return new RpaError('BROWSER_ERROR', 'browser or page was closed: ' + msg.split('\n')[0]);
  if (/intercepts pointer events|not visible|not stable|not enabled|element is outside of the viewport|detached from the DOM/i.test(msg))
    return new RpaError('ELEMENT_NOT_ACTIONABLE', msg.split('\n').slice(0, 6).join(' | '));
  if (e?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(msg)) return new RpaError('ACTION_TIMEOUT', msg.split('\n')[0]);
  if (/net::ERR_/.test(msg)) return new RpaError('NAVIGATION_FAILED', msg.split('\n')[0]);
  return new RpaError('STEP_ERROR', msg.split('\n').slice(0, 4).join(' | '));
}

export class Runner {
  tpl: any;
  opts: RunOptions;
  rec!: RunRecorder;
  conn!: Connected;
  page!: Page;
  scope: Scope;
  humanize: boolean;
  timeout: number;
  screenshots: 'failure' | 'every' | 'none';
  handoffMode: 'auto' | 'never';
  site: string[];
  private dossierWritten = false;

  constructor(opts: RunOptions) {
    this.opts = opts;
    this.tpl = opts.loaded.template;
    const d = this.tpl.defaults || {};
    this.humanize = opts.humanize ?? d.humanize ?? true;
    this.timeout = d.timeoutMs ?? 10000;
    this.screenshots = opts.screenshots ?? d.screenshots ?? 'failure';
    this.handoffMode = opts.headless ? 'never' : opts.handoff ?? 'auto';
    this.site = this.tpl.site || [];
    this.scope = { inputs: {}, vars: {}, account: opts.account || {} };
  }

  // ---------- checkpoint (state.json) ----------
  private nextTop = 0;
  /** forEach progress by step path, so a resume skips iterations that already finished */
  private loops: Record<string, { next: number; fp: string; results: any[]; failures: any[] }> = {};
  private resumeLoops: Record<string, any> = {};
  private persist() {
    this.rec.saveState({ nextStep: this.nextTop, nextStepId: this.tpl.steps[this.nextTop]?.id ?? null, vars: this.scope.vars, inputs: this.scope.inputs, loops: this.loops });
  }

  // ---------- page probes ----------
  probe(): PageProbe {
    return {
      url: () => this.page.url(),
      count: (target) => countTarget(this.page, target),
      text: (target) => textOfTarget(this.page, target),
    };
  }
  cond(c: any, scope: Scope) {
    return evalCond(c, scope, this.probe());
  }
  async waitCond(c: any, scope: Scope, timeoutMs: number): Promise<CondResult> {
    const deadline = Date.now() + timeoutMs;
    let r: CondResult;
    for (;;) {
      r = await this.cond(c, scope).catch((e) => ({ pass: false, why: String(e.message || e) }));
      if (r.pass || Date.now() >= deadline) return r;
      await sleep(250);
    }
  }
  evalIso<T = any>(expr: string): Promise<T> {
    return (this.page as any).evaluate(expr, undefined, undefined, true);
  }

  checkSite(url = this.page.url()) {
    if (!/^https?:/.test(url)) return;
    const host = new URL(url).hostname;
    if (!this.site.some((d) => hostMatches(host, d))) throw new RpaError('NAVIGATION_BLOCKED', `page is on "${host}", outside site [${this.site.join(', ')}]`);
  }

  async detectEnv(err: RpaError): Promise<RpaError | null> {
    if (ENV_ERROR_CODES.has(err.code) || err.code === 'HANDOFF_REQUIRED') return err;
    try {
      const ch = await this.evalIso<string | null>(inpageCall('detectChallenge'));
      if (ch) return new RpaError('CHALLENGE_DETECTED', `captcha / risk-control page detected (${ch})`);
      const url = this.page.url();
      if (/\/(login|signin|sign-in|sign_in)\b|\/flow\/login|passport\./i.test(url)) {
        const lc = this.tpl.account?.loginCheck;
        if (!lc || !(await this.cond(lc, this.scope)).pass) return new RpaError('LOGIN_REQUIRED', `redirected to a login page: ${url}`);
      }
    } catch {}
    return null;
  }

  // ---------- human handoff ----------
  async handoff(reason: string, until: any | null, code: string): Promise<number> {
    if (this.handoffMode === 'never') throw new RpaError(code, `${reason} (human needed, but this run is non-interactive)`);
    const started = Date.now();
    const timeoutMs = this.opts.handoffTimeoutMs ?? 15 * 60 * 1000;
    const flag = path.join(this.rec.dir, 'CONTINUE');
    writeJson(path.join(this.rec.dir, 'HANDOFF.json'), { reason, since: new Date().toISOString(), continueFile: flag, until });
    await this.page.bringToFront().catch(() => {});
    log.info('\n' + '='.repeat(64));
    log.info(`🙋 需要人工处理 / HUMAN NEEDED: ${reason}`);
    log.info(until ? '   请在弹出的 Chrome 窗口里完成操作，完成后会自动继续。' : '   请在 Chrome 窗口里完成操作，然后在这里按回车继续。');
    log.info(`   (也可以创建文件继续: touch "${flag}")`);
    log.info('='.repeat(64) + '\n');
    let enter = false;
    let rl: readline.Interface | null = null;
    if (process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin });
      rl.once('line', () => (enter = true));
    }
    try {
      while (Date.now() - started < timeoutMs) {
        if (enter || fs.existsSync(flag)) break;
        if (until && (await this.cond(until, this.scope).catch(() => ({ pass: false }))).pass) break;
        await sleep(1000);
      }
      if (Date.now() - started >= timeoutMs) throw new RpaError(code, `${reason} (no human action within ${Math.round(timeoutMs / 60000)} min)`);
    } finally {
      rl?.close();
      fs.rmSync(flag, { force: true });
      fs.rmSync(path.join(this.rec.dir, 'HANDOFF.json'), { force: true });
    }
    log.info('▶️  继续执行 / resuming');
    return Date.now() - started;
  }

  // ---------- main ----------
  async run(): Promise<RunResult> {
    const v = validateTemplate(this.tpl);
    if (!v.ok) throw new RpaError('TEMPLATE_INVALID', `template is invalid:\n` + v.errors.map((e) => `  [${e.stepId ?? '-'}] ${e.path}: ${e.message}`).join('\n'));
    let resumeState: any = null;
    let inputs = this.opts.inputs || {};
    if (this.opts.resumeFrom) {
      const runFile = path.join(this.opts.resumeFrom, 'run.json');
      if (!fs.existsSync(runFile)) throw new RpaError('INPUT_INVALID', `--resume: ${this.opts.resumeFrom} is not a run directory (no run.json). List runs with: browser-recipewright runs`);
      const prev = readJson(runFile);
      const stateFile = path.join(this.opts.resumeFrom, 'state.json');
      if (fs.existsSync(stateFile)) {
        resumeState = readJson(stateFile);
      } else {
        // the run stopped before any step (e.g. login check or browser start): nothing to skip, start over with its inputs
        const known = Object.fromEntries(Object.entries<any>(prev.inputs || {}).filter(([, v]) => v !== '***'));
        resumeState = { nextStep: 0, vars: {}, inputs: known, loops: {} };
        log.info(`↻ the previous run stopped before its first step (${prev.error?.code ?? 'no checkpoint'}); starting again from step 1 with the same inputs`);
      }
      inputs = { ...(resumeState.inputs || {}), ...inputs };
      this.opts.profile ??= prev.profile;
    }
    this.scope.inputs = coerceInputs(this.tpl, inputs);
    const profile = this.opts.profile || defaultProfile(this.tpl);
    this.rec = new RunRecorder(this.tpl.id, this.opts.runsDir);
    this.rec.start({
      templateId: this.tpl.id,
      templateVersion: this.tpl.version,
      templatePath: this.opts.loaded.path,
      profile,
      account: this.opts.account?.id ?? null,
      inputs: maskInputs(this.tpl, this.scope.inputs),
      resumedFrom: this.opts.resumeFrom ?? null,
      options: { humanize: this.humanize, headless: !!this.opts.headless, handoff: this.handoffMode, screenshots: this.screenshots },
    });
    log.info(`▶ ${this.tpl.id}@${this.tpl.version}  profile=${profile}  run=${this.rec.dir}`);
    if (resumeState) {
      this.scope.vars = resumeState.vars || {};
      this.resumeLoops = resumeState.loops || {};
      this.loops = { ...this.resumeLoops };
      this.nextTop = resumeState.nextStep || 0;
    }
    // checkpoint right away, so even a run that fails before step 1 can be resumed
    this.persist();

    let output: any = null;
    let error: RunResult['error'];
    let startIdx = 0;
    try {
      this.conn = this.opts.connected ?? (await connect(profile, { headless: this.opts.headless }));
      this.page = this.conn.page;
      this.page.on('dialog', (d) => d.dismiss().catch(() => {}));
      if (resumeState) {
        startIdx = this.nextTop;
        log.info(`↻ resuming at top-level step ${startIdx + 1}/${this.tpl.steps.length} "${this.tpl.steps[startIdx]?.id}" (skipping ${startIdx} finished step(s); from ${this.opts.resumeFrom})`);
        if (this.tpl.account?.loginCheck && !this.opts.skipLoginCheck) await this.loginCheck();
        // put the browser back on the page where the failed step started
        const stepId = this.tpl.steps[startIdx]?.id;
        const prevRec = readSteps(this.opts.resumeFrom!).find((r) => r.path === stepId);
        if (prevRec?.urlBefore && /^https?:/.test(prevRec.urlBefore) && this.page.url() !== prevRec.urlBefore) {
          this.checkSite(prevRec.urlBefore);
          await this.page.goto(prevRec.urlBefore, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      } else if (this.tpl.account?.loginCheck && !this.opts.skipLoginCheck) {
        await this.loginCheck();
      }
      const saveState = (next: number) => { this.nextTop = next; this.persist(); };
      for (const v of appendTargets(this.tpl.steps)) if (!Array.isArray(this.scope.vars[v])) this.scope.vars[v] = [];
      saveState(startIdx);
      for (let i = startIdx; i < this.tpl.steps.length; i++) {
        const st = this.tpl.steps[i];
        await this.execStep(st, st.id, this.scope);
        saveState(i + 1);
      }
      output = this.tpl.outputs ? render(this.tpl.outputs.from, this.scope) : this.scope.vars;
      if (this.tpl.outputs?.schema) {
        const errs = checkSchema(output, this.tpl.outputs.schema);
        if (errs.length) throw Object.assign(new RpaError('OUTPUT_INVALID', errs.join('; ')), { stepId: null });
      }
    } catch (e: any) {
      const err = normalizeError(e);
      error = { code: err.code, message: err.message, stepId: e.stepId ?? null, path: e.stepPath ?? null, category: errorCategory(err.code) };
      if (output === null && this.tpl.outputs) output = (() => { try { return render(this.tpl.outputs.from, this.scope); } catch { return null; } })();
      if (!this.dossierWritten) await this.writeDossier(null, err, error.path ?? '-', null).catch(() => {});
    } finally {
      this.rec.writeOutput(output);
      if (this.conn && !this.opts.connected) {
        if ((this.conn.launchedHere && !this.opts.keepOpen) || this.opts.forceClose) await closeSession(this.conn.session.profile, this.conn.browser).catch(() => {});
        else await disconnect(this.conn);
      }
    }
    const status = error ? 'failed' : 'success';
    this.rec.finish({ status, error: error ?? null, outputCount: Array.isArray(output) ? output.length : undefined });
    const res: RunResult = { status, runDir: this.rec.dir, output, outputPath: path.join(this.rec.dir, 'output.json'), error };
    if (error) res.dossier = path.join(this.rec.dir, 'failure', 'dossier.json');
    log.info(error ? `✗ failed at ${error.stepId ?? '-'}: ${error.code} ${error.message}` : `✓ success → ${res.outputPath}`);
    return res;
  }

  async loginCheck() {
    const a = this.tpl.account;
    const url = a.checkUrl ? String(render(a.checkUrl, this.scope)) : `https://${this.site[0].replace(/^\*\./, '')}/`;
    const seq = this.rec.nextSeq();
    const started = Date.now();
    const urlBefore = this.page.url();
    if (!this.page.url().startsWith(url)) await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    let r = await this.waitCond(a.loginCheck, this.scope, 8000);
    let handoffMs = 0;
    if (!r.pass) {
      const ch = await this.evalIso<string | null>(inpageCall('detectChallenge')).catch(() => null);
      const code = ch ? 'CHALLENGE_DETECTED' : 'LOGIN_REQUIRED';
      const reason = ch ? '检测到验证码/风控页，请手动处理' : `账号未登录，请在浏览器里登录 ${this.site[0]}（登录一次后会保存在这个账号的 Profile 里）`;
      if (a.loginUrl && !ch) await this.page.goto(String(render(a.loginUrl, this.scope)), { waitUntil: 'domcontentloaded' }).catch(() => {});
      try {
        handoffMs = await this.handoff(reason, a.loginCheck, code);
      } catch (e: any) {
        this.rec.step({ seq, stepId: '_login-check', path: '_login-check', action: 'loginCheck', status: 'failed', startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, urlBefore, urlAfter: this.page.url(), locator: null, expect: { result: 'fail', why: r.why }, attempts: 1, output: null, artifacts: [], error: { code: e.code, message: e.message, category: 'env' } });
        throw e;
      }
      r = await this.cond(a.loginCheck, this.scope);
    }
    this.rec.step({ seq, stepId: '_login-check', path: '_login-check', action: 'loginCheck', status: 'ok', startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, urlBefore, urlAfter: this.page.url(), locator: null, expect: { result: 'pass', why: r.why }, attempts: 1, output: null, artifacts: [], handoffMs });
  }

  async screenshot(name: string, rec?: StepRecord) {
    const p = this.rec.artifactPath(`${String(rec?.seq ?? 0).padStart(4, '0')}-${name}.png`);
    await this.page.screenshot({ path: p, timeout: 5000 }).catch(() => {});
    if (rec && fs.existsSync(p)) rec.artifacts.push(path.relative(this.rec.dir, p));
  }

  async writeDossier(step: any | null, err: RpaError, stepPath: string, rec: StepRecord | null) {
    this.dossierWritten = true;
    const fdir = this.rec.failureDir();
    let snap: any = null;
    if (this.page) {
      await this.page.screenshot({ path: path.join(fdir, 'screenshot.png'), timeout: 5000 }).catch(() => {});
      snap = await this.evalIso(inpageCall('snapshot', { max: 500 })).catch(() => null);
      if (snap) {
        fs.writeFileSync(path.join(fdir, 'snapshot.txt'), `# ${snap.title}\n# ${snap.url}\n${snap.text}\n`);
        writeJson(path.join(fdir, 'snapshot.refs.json'), snap.refs);
      }
    }
    const tplPath = this.opts.loaded.path;
    const dossier = {
      runDir: this.rec.dir,
      templateId: this.tpl.id,
      templateVersion: this.tpl.version,
      templatePath: tplPath,
      failedStepId: step?.id ?? null,
      path: stepPath,
      failedStep: step,
      error: { code: err.code, message: err.message, category: errorCategory(err.code) },
      hint: ERROR_HINTS[err.code] ?? null,
      locator: rec?.locator ?? err.details?.locator ?? null,
      expect: rec?.expect ?? null,
      url: this.page?.url() ?? null,
      title: snap?.title ?? null,
      files: { screenshot: 'failure/screenshot.png', snapshot: snap ? 'failure/snapshot.txt' : null, snapshotRefs: snap ? 'failure/snapshot.refs.json' : null, steps: 'steps.jsonl' },
      lastSuccess: step ? lastSuccessFor(this.tpl.id, step.id, this.rec.dir) : null,
      locatorDrift: locatorDrift(this.tpl.id),
      next:
        errorCategory(err.code) === 'env'
          ? ['Environment problem: do not edit the template. Ask the human to fix login / captcha, then resume:', `browser-recipewright run "${tplPath}" --resume "${this.rec.dir}"`]
          : [
              '1. Read failure/snapshot.txt (refs in snapshot.refs.json give ready-made locator candidates).',
              `2. Write a patch for step "${step?.id ?? '?'}" only, then: browser-recipewright patch "${tplPath}" patch.json --write`,
              `3. Verify from the failed top-level step: browser-recipewright run "${tplPath}" --resume "${this.rec.dir}"`,
            ],
    };
    writeJson(path.join(fdir, 'dossier.json'), dossier);
  }

  // ---------- step execution ----------
  async execStep(step: any, stepPath: string, scope: Scope): Promise<any> {
    const rec: StepRecord = {
      seq: this.rec.nextSeq(), stepId: step.id, path: stepPath, action: step.action, status: 'ok',
      startedAt: new Date().toISOString(), durationMs: 0, urlBefore: this.page.url(), urlAfter: null,
      locator: null, expect: null, attempts: 0, output: null, artifacts: [],
    };
    const t0 = Date.now();
    const finish = () => {
      rec.durationMs = Date.now() - t0;
      rec.urlAfter = this.page.url();
      this.rec.step(rec);
    };

    if (CONTROL.has(step.action)) {
      rec.attempts = 1;
      try {
        const out = await this.control(step, stepPath, scope, rec);
        rec.output = truncateForRecord(out, 600);
        if (step.saveAs) scope.vars[step.saveAs] = out;
        if (step.appendTo) rec.appended = appendTo(scope, step.appendTo, out);
        finish();
        return out;
      } catch (e: any) {
        const err = normalizeError(e);
        rec.status = 'failed';
        rec.error = { code: err.code, message: err.message, category: errorCategory(err.code) };
        finish();
        throw e instanceof StepFailure ? e : new StepFailure(err, step.id, stepPath);
      }
    }

    const retries = step.retries ?? this.tpl.defaults?.retries ?? 0;
    const timeout = step.timeoutMs ?? this.timeout;
    let value: any;
    let lastErr: RpaError | null = null;
    let handoffUsed = false;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      rec.attempts++;
      try {
        value = await this.atomic(step, scope, rec, timeout);
        if (step.expect) {
          const r = await this.waitCond(step.expect, scope, timeout);
          rec.expect = { result: r.pass ? 'pass' : 'fail', why: r.why };
          if (!r.pass) throw new RpaError('EXPECT_FAILED', `expect not met: ${r.why}`);
        }
        this.checkSite();
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = normalizeError(e);
        const env = await this.detectEnv(lastErr);
        if (env) {
          lastErr = env;
          const canRetry = (env.code === 'CHALLENGE_DETECTED' || env.code === 'LOGIN_REQUIRED') && this.handoffMode === 'auto' && !handoffUsed;
          if (canRetry) {
            handoffUsed = true;
            try {
              rec.handoffMs = await this.handoff(env.code === 'LOGIN_REQUIRED' ? '登录已失效，请在浏览器里重新登录' : '检测到验证码/风控页，请手动完成', env.code === 'CHALLENGE_DETECTED' ? { not: { urlMatches: 'captcha|challenge|account/access' } } : this.tpl.account?.loginCheck ?? null, env.code);
              attempt--;
              continue;
            } catch (he: any) {
              lastErr = normalizeError(he);
            }
          }
          break;
        }
        if (lastErr.code === 'NAVIGATION_BLOCKED' || lastErr.code === 'SCRIPT_REJECTED' || lastErr.code === 'TEMPLATE_INVALID') break;
        if (attempt <= retries) await sleep(600 * attempt);
      }
    }

    if (lastErr) {
      const cat = errorCategory(lastErr.code);
      rec.error = { code: lastErr.code, message: lastErr.message, category: cat };
      if (lastErr.details?.locator && !rec.locator) rec.locator = lastErr.details.locator;
      if (step.optional && cat === 'template') {
        rec.status = 'soft-failed';
        if (step.saveAs) scope.vars[step.saveAs] = null;
        finish();
        log.info(`  ~ ${stepPath} (${step.action}) optional step failed: ${lastErr.code}`);
        return null;
      }
      rec.status = 'failed';
      if (this.screenshots !== 'none') await this.screenshot(step.id, rec);
      finish();
      if (!this.dossierWritten) await this.writeDossier(step, lastErr, stepPath, rec);
      log.info(`  ✗ ${stepPath} (${step.action}) ${lastErr.code}: ${lastErr.message}`);
      throw new StepFailure(lastErr, step.id, stepPath);
    }

    rec.output = truncateForRecord(value);
    if (step.saveAs) scope.vars[step.saveAs] = value;
    if (step.appendTo) rec.appended = appendTo(scope, step.appendTo, value);
    if (this.screenshots === 'every' || step.screenshot) await this.screenshot(step.id, rec);
    finish();
    log.info(`  ✓ ${stepPath} (${step.action}) ${rec.durationMs}ms${rec.locator?.hit > 0 ? ` [fallback locator #${rec.locator.hit}]` : ''}`);
    if (!['wait'].includes(step.action)) {
      const gap = pickMs(this.tpl.defaults?.stepGapMs, 0);
      if (gap) await sleep(gap);
    }
    return value;
  }

  async control(step: any, stepPath: string, scope: Scope, rec: StepRecord): Promise<any> {
    switch (step.action) {
      case 'group': {
        const tries = (step.retries ?? 0) + 1;
        for (let a = 1; ; a++) {
          rec.attempts = a;
          try {
            for (const s of step.steps) await this.execStep(s, `${stepPath}.${s.id}`, scope);
            return null;
          } catch (e: any) {
            if (a >= tries || errorCategory(e.code) === 'env') {
              if (step.optional && errorCategory(e.code) === 'template') { rec.status = 'soft-failed'; return null; }
              throw e;
            }
            this.dossierWritten = false;
            await sleep(800);
          }
        }
      }
      case 'if': {
        const r = await this.cond(step.when, scope);
        rec.expect = { branch: r.pass ? 'then' : 'else', why: r.why };
        const branch = r.pass ? step.then : step.else || [];
        for (const s of branch) await this.execStep(s, `${stepPath}.${s.id}`, scope);
        return null;
      }
      case 'while': {
        let i = 0;
        for (; i < step.maxIterations; i++) {
          if (!(await this.cond(step.when, scope)).pass) break;
          for (const s of step.do) await this.execStep(s, `${stepPath}[${i}].${s.id}`, scope);
        }
        rec.note = `${i} iteration(s)`;
        return null;
      }
      case 'forEach': {
        const list = typeof step.in === 'string' ? render(step.in, scope) : step.in;
        if (!Array.isArray(list)) throw new RpaError('STEP_ERROR', `forEach "in" is not an array (got ${typeof list})`);
        const max = Number(render(step.max, scope)) || list.length;
        const innerSaves = collectSaves(step.do);
        let results: any[] = [];
        let failures: any[] = [];
        const fp = createHash('sha1').update(JSON.stringify(list)).digest('hex').slice(0, 12);
        let from = 0;
        const saved = this.resumeLoops[stepPath];
        if (saved && saved.fp === fp && saved.next > 0) {
          from = saved.next;
          results = [...(saved.results || [])];
          failures = [...(saved.failures || [])];
          rec.resumedAtIteration = from;
          log.info(`    ↻ ${stepPath}: ${from} of ${Math.min(list.length, max)} item(s) already done, continuing at item ${from + 1}`);
        }
        delete this.resumeLoops[stepPath];
        for (let i = from; i < Math.min(list.length, max); i++) {
          for (const k of innerSaves) delete scope.vars[k];
          const s2: Scope = { ...scope, [step.as]: list[i], index: i };
          try {
            for (const s of step.do) await this.execStep(s, `${stepPath}[${i}].${s.id}`, s2);
            if (step.collectFrom !== undefined) results.push(render(step.collectFrom, s2));
          } catch (e: any) {
            if (!step.continueOnError || errorCategory(e.code) === 'env') throw e;
            this.dossierWritten = false; // allow a fresh dossier for a later fatal error
            failures.push({ index: i, code: e.code, message: e.message });
            if (step.collectFrom !== undefined) results.push({ ...(render(step.collectFrom, s2) || {}), _error: { code: e.code, message: e.message } });
          }
          this.loops[stepPath] = { next: i + 1, fp, results, failures };
          this.persist();
        }
        delete this.loops[stepPath];
        rec.note = `${Math.min(list.length, max)} item(s), ${failures.length} failed`;
        if (failures.length) rec.failures = failures;
        if (step.collectFrom === undefined) return null;
        return step.flatten ? results.flatMap((x) => (Array.isArray(x) ? x : [x])) : results;
      }
    }
  }

  // ---------- atomic actions ----------
  async atomic(step: any, scope: Scope, rec: StepRecord, timeout: number): Promise<any> {
    const s: any = {};
    for (const [k, v] of Object.entries(step)) s[k] = RAW_KEYS.has(k) ? v : render(v, scope);
    const page = this.page;
    const resolve = async (t: any[]) => {
      const r = await resolveTarget(page, render(t, scope), timeout);
      rec.locator = r.info;
      return r.locator;
    };
    switch (s.action) {
      case 'goto': {
        const url = String(s.url);
        this.checkSite(url);
        await page.goto(url, { waitUntil: s.waitUntil || 'domcontentloaded', timeout: Math.max(timeout, 30000) });
        return null;
      }
      case 'back':
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 30000) });
        return null;
      case 'click': {
        const loc = await resolve(s.target);
        await human.click(page, loc, { humanize: this.humanize, timeout, button: s.button, clickCount: s.clickCount });
        return null;
      }
      case 'fill': {
        const loc = await resolve(s.target);
        if (this.humanize) {
          await human.click(page, loc, { humanize: true, timeout });
          const guard = await human.focusForTyping(page, loc, { humanize: true, timeout });
          try {
            await human.selectAllAndDelete(page, guard);
            await human.typeText(page, String(s.value), undefined, true, guard);
          } finally {
            await guard.dispose();
          }
        } else await loc.fill(String(s.value), { timeout });
        return null;
      }
      case 'type': {
        const loc = await resolve(s.target);
        await human.click(page, loc, { humanize: this.humanize, timeout });
        const guard = await human.focusForTyping(page, loc, { humanize: this.humanize, timeout });
        try {
          if (s.clear) await human.selectAllAndDelete(page, guard);
          await human.typeText(page, String(s.text), s.delayMs, this.humanize, guard);
        } finally {
          await guard.dispose();
        }
        return null;
      }
      case 'press': {
        if (s.target) {
          const loc = await resolve(s.target);
          await loc.press(s.key, { timeout });
        } else await page.keyboard.press(s.key);
        return null;
      }
      case 'hover': {
        const loc = await resolve(s.target);
        await human.hover(page, loc, { humanize: this.humanize, timeout });
        return null;
      }
      case 'select': {
        const loc = await resolve(s.target);
        return await loc.selectOption(s.option, { timeout });
      }
      case 'check': {
        const loc = await resolve(s.target);
        const want = s.checked ?? true;
        if ((await loc.isChecked({ timeout })) !== want) await human.click(page, loc, { humanize: this.humanize, timeout });
        return want;
      }
      case 'upload': {
        const loc = await resolve(s.target);
        const files = (Array.isArray(s.files) ? s.files : [s.files]).map((f: string) => path.resolve(f));
        await loc.setInputFiles(files, { timeout });
        return files;
      }
      case 'waitFor': {
        if (s.target) {
          if (s.state === 'hidden' || s.state === 'detached') {
            const r = await this.waitCond({ notExists: render(step.target, scope) }, scope, timeout);
            if (!r.pass) throw new RpaError('ACTION_TIMEOUT', `element still present after ${timeout}ms`);
          } else await resolve(s.target);
        }
        if (s.url) {
          const r = await this.waitCond({ urlContains: s.url }, scope, timeout);
          if (!r.pass) throw new RpaError('ACTION_TIMEOUT', r.why);
        }
        if (s.text) {
          const r = await this.waitCond({ exists: [{ text: s.text }] }, scope, timeout);
          if (!r.pass) throw new RpaError('ACTION_TIMEOUT', `text "${s.text}" not visible after ${timeout}ms`);
        }
        if (step.until) {
          const r = await this.waitCond(step.until, scope, timeout);
          if (!r.pass) throw new RpaError('ACTION_TIMEOUT', r.why);
        }
        return null;
      }
      case 'wait':
        await sleep(pickMs(s.ms));
        return null;
      case 'scroll': {
        const times = s.times ?? 1;
        if (s.target && s.by === undefined && !s.to) {
          const loc = await resolve(s.target);
          await loc.scrollIntoViewIfNeeded({ timeout });
          return null;
        }
        if (s.target) {
          const loc = await resolve(s.target);
          const box = await loc.boundingBox();
          if (box) await human.moveMouse(page, box.x + box.width / 2, box.y + box.height / 2);
        }
        for (let i = 0; i < times; i++) {
          if (s.to === 'bottom' || s.to === 'top') {
            const info: any = await this.evalIso(inpageCall('scrollInfo'));
            const dy = s.to === 'bottom' ? info.h - info.y : -info.y;
            await human.wheel(page, dy, this.humanize);
          } else {
            const info: any = await this.evalIso(inpageCall('scrollInfo'));
            const dy = s.by === 'page' || s.by === undefined ? Math.round(info.vh * 0.85) : Number(s.by);
            await human.wheel(page, dy, this.humanize);
          }
          await sleep(this.humanize ? 300 + Math.random() * 500 : 150);
        }
        return null;
      }
      case 'read': {
        const loc = await resolve(s.target);
        const fields = step.fields ? render(step.fields, scope) : { value: { text: s.attr ? undefined : true, attr: s.attr, pattern: s.pattern, as: s.as } };
        const raw = await (loc as any).evaluate(inpageElementFn('extractFrom'), fields, undefined, true);
        const { values, missing } = postFields(raw, fields);
        if (missing.length) throw new RpaError('LOCATOR_NOT_FOUND', `field(s) not found inside the element: ${missing.join(', ')}`, { locator: rec.locator });
        return step.fields ? values : values.value;
      }
      case 'queryAll': {
        const target = render(step.target, scope);
        const fields = step.fields ? render(step.fields, scope) : null;
        const limit = s.limit !== undefined ? Number(s.limit) : 200;
        const res: any = await this.waitItems(target, fields, limit, timeout);
        rec.locator = { tried: target.map((_: any, i: number) => ({ candidate: i, matches: i === res.candidate ? res.total : 0 })).slice(0, Math.max(res.candidate + 1, 1)), hit: res.candidate >= 0 ? res.candidate : null };
        const items = res.items.map((it: any) => postFields(it, fields || { text: { text: true } })).filter((r: any) => !r.missing.length).map((r: any) => (fields ? r.values : r.values.text));
        return items;
      }
      case 'collect':
        return this.collect(step, scope, rec, timeout);
      case 'download': {
        const target = render(step.trigger, scope);
        const r = await resolveTarget(page, target, timeout);
        rec.locator = r.info;
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: Math.max(timeout, 60000) }), human.click(page, r.locator, { humanize: this.humanize, timeout })]);
        const dir = path.join(this.rec.dir, 'artifacts', 'downloads');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, s.filename || dl.suggestedFilename());
        await dl.saveAs(dest);
        rec.artifacts.push(path.relative(this.rec.dir, dest));
        return dest;
      }
      case 'runScript': {
        const code = loadScriptCode(s.script, this.site);
        return await this.evalIso(`(${code.trim().replace(/;\s*$/, '')})(${JSON.stringify(s.args ?? null)})`);
      }
      case 'assert': {
        const r = await this.cond(step.that, scope);
        rec.expect = { result: r.pass ? 'pass' : 'fail', why: r.why };
        if (!r.pass) throw new RpaError(s.code || 'ASSERT_FAILED', s.message || `assert failed: ${r.why}`);
        return true;
      }
      case 'handoff': {
        if (step.until && (await this.cond(step.until, scope)).pass) return { skipped: true };
        rec.handoffMs = await this.handoff(String(s.reason), step.until ?? null, 'HANDOFF_REQUIRED');
        return null;
      }
    }
    throw new RpaError('TEMPLATE_INVALID', `unknown action ${s.action}`);
  }

  async waitItems(target: any[], fields: any, max: number, timeout: number) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const res: any = await this.evalIso(inpageCall('extractItems', { item: target, fields, max }));
      if (res.total > 0 || Date.now() >= deadline) return res;
      await sleep(300);
    }
  }

  async collect(step: any, scope: Scope, rec: StepRecord, timeout: number) {
    const item = render(step.item, scope);
    const fields = render(step.fields, scope);
    const limit = step.limit !== undefined ? Number(render(step.limit, scope)) : Infinity;
    const offset = step.offset ?? 0;
    const stopAfterNoNew = step.stopAfterNoNew ?? 4;
    const results: any[] = [];
    const seen = new Set<string>();
    let order = 0, scanned = 0, dropped = 0, filteredOut = 0, scrolls = 0, noNew = 0;
    let stop = 'maxScrolls';
    let hit: number | null = null;
    const first = await this.waitItems(item, fields, 0, timeout);
    if (first.total === 0) throw new RpaError('LOCATOR_NOT_FOUND', `collect: no item matched after ${timeout}ms`, { locator: { tried: item.map((_: any, i: number) => ({ candidate: i, matches: 0 })), hit: null } });
    let res = first;
    for (;;) {
      if (hit === null && res.candidate >= 0) hit = res.candidate;
      let fresh = 0;
      for (const it of res.items) {
        const { values, missing } = postFields(it, fields);
        if (missing.length) { dropped++; continue; }
        const key = step.dedupeBy ? String(values[step.dedupeBy]) : JSON.stringify(values);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh++;
        scanned++;
        if (order++ < offset) continue;
        if (step.filter && !(await evalCond(step.filter, { ...scope, item: values })).pass) { filteredOut++; continue; }
        results.push(values);
        if (results.length >= limit) break;
      }
      const untilCond = step.until;
      if (results.length >= limit) { stop = 'limit'; break; }
      if (untilCond && (await evalCond(untilCond, { ...scope, self: results }, this.probe())).pass) { stop = 'until'; break; }
      noNew = fresh ? 0 : noNew + 1;
      if (noNew >= stopAfterNoNew && res.scroll.atBottom) { stop = 'endOfList'; break; }
      if (scrolls >= step.maxScrolls) { stop = 'maxScrolls'; break; }
      const vh = res.scroll.vh || 800;
      const by = step.scrollBy === 'page' || step.scrollBy === undefined ? Math.round(vh * (0.7 + Math.random() * 0.2)) : Number(step.scrollBy);
      await human.wheel(this.page, by, this.humanize);
      scrolls++;
      await sleep(pickMs(step.scrollWaitMs, this.humanize ? 0 : 0) || (this.humanize ? 700 + Math.random() * 900 : 500));
      res = await this.evalIso(inpageCall('extractItems', { item, fields, max: 0 }));
    }
    rec.locator = { tried: item.map((_: any, i: number) => ({ candidate: i, matches: i === hit ? first.total : 0 })).slice(0, (hit ?? 0) + 1), hit };
    rec.collect = { kept: results.length, scanned, dropped, filteredOut, scrolls, stoppedBecause: stop };
    log.info(`    collect: kept ${results.length}, scanned ${scanned}, filtered ${filteredOut}, scrolls ${scrolls}, stop=${stop}`);
    return results;
  }
}

/** appendTo: add a step's output to a list variable (arrays are spread), optionally skipping duplicates. */
function appendTo(scope: Scope, spec: string | { var: string; dedupeBy?: string }, out: any) {
  const name = typeof spec === 'string' ? spec : spec.var;
  const by = typeof spec === 'string' ? undefined : spec.dedupeBy;
  const list: any[] = Array.isArray(scope.vars[name]) ? scope.vars[name] : [];
  const incoming = out == null ? [] : Array.isArray(out) ? out : [out];
  let added = 0;
  let duplicates = 0;
  const seen = by ? new Set(list.map((x) => JSON.stringify(x?.[by]))) : null;
  for (const x of incoming) {
    if (seen) {
      const k = JSON.stringify(x?.[by!]);
      if (x?.[by!] != null && seen.has(k)) { duplicates++; continue; }
      seen.add(k);
    }
    list.push(x);
    added++;
  }
  scope.vars[name] = list;
  return { var: name, added, duplicates, total: list.length };
}

function collectSaves(steps: any[], acc: string[] = []): string[] {
  for (const s of steps || []) {
    if (s.saveAs) acc.push(s.saveAs);
    for (const k of ['do', 'then', 'else', 'steps']) if (Array.isArray(s[k])) collectSaves(s[k], acc);
  }
  return acc;
}

/** Turn raw in-page field values into typed values (pattern, as). */
export function postFields(raw: Record<string, { found: boolean; raw: any }>, fields: Record<string, any>) {
  const values: Record<string, any> = {};
  const missing: string[] = [];
  for (const [k, spec] of Object.entries<any>(fields)) {
    const r = raw?.[k];
    if (!r || !r.found) {
      if (spec.optional || spec.default !== undefined) values[k] = spec.default ?? null;
      else missing.push(k);
      continue;
    }
    const conv = (v: any) => {
      if (v != null && spec.pattern) {
        const m = String(v).match(new RegExp(spec.pattern));
        v = m ? (m[1] ?? m[0]) : null;
      }
      switch (spec.as) {
        case 'number': return v == null ? null : FILTERS.number(v);
        case 'count': return parseCount(v);
        case 'boolean': return v != null && v !== '' && v !== 'false' && v !== '0';
        default: return v;
      }
    };
    values[k] = Array.isArray(r.raw) ? r.raw.map(conv) : conv(r.raw);
  }
  return { values, missing };
}
