/**
 * The executor: validate → (login check) → run steps one by one → write a record per step →
 * on failure write a dossier for the AI → validate outputs.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import type { Page } from 'patchright';
import { connect, closeSession, disconnect, siteKey, type Connected } from './browser.js';
import { render, Scope, FILTERS, parseCount } from './render.js';
import { evalCond, type PageProbe, type CondResult } from './conditions.js';
import { resolveTarget, countTarget, textOfTarget, waitPresent } from './locator.js';
import { inpageCall, inpageElementFn } from './inpage.js';
import * as human from './human.js';
import { preview } from './events.js';
import { RunRecorder, StepRecord, ERROR_HINTS, errorCategory, lastSuccessFor, locatorDrift, readSteps } from './records.js';
import { checkSchema } from './jsonschema.js';
import { loadScriptCode, hostMatches } from './scripts.js';
import { validateTemplate } from './validate.js';
import { appendTargets } from './schema.js';
import { coerceAnswer, readPendingAsk, ASK_FILE, type PendingAsk } from './ask.js';
import { recordUsage, itemsOf } from './usage.js';
import { resolveRecipe, checkRecipeCalls, MAX_RECIPE_DEPTH } from './flow.js';
import type { LoadedTemplate } from './library.js';
import { RecipeError, sleep, pickMs, log, truncateForRecord, readJson, writeJson, ENV_ERROR_CODES } from './util.js';

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
  /** what an ask step does when no answer is stored yet: pause for the agent (default), use its default, or fail */
  onAsk?: 'pause' | 'default' | 'fail';
  /** continue a run that is paused at an ask step, in the same run directory (the answer is in its state.json) */
  continueRun?: string;
  /** alert / confirm / prompt dialogs: dismiss (default) or accept. Overrides the template's defaults.dialogs */
  dialogs?: 'dismiss' | 'accept';
}

export interface DialogPolicy {
  action: 'dismiss' | 'accept';
  promptText?: string;
}
export function dialogPolicy(fromTemplate: any, override?: 'dismiss' | 'accept'): DialogPolicy {
  const t: DialogPolicy = typeof fromTemplate === 'string' ? { action: fromTemplate as any } : fromTemplate?.action ? fromTemplate : { action: 'dismiss' };
  return override ? { ...t, action: override } : t;
}

export interface RunResult {
  status: 'success' | 'failed' | 'paused';
  runDir: string;
  output: any;
  outputPath: string;
  error?: { code: string; message: string; stepId: string | null; path: string | null; category: 'env' | 'template' };
  dossier?: string;
  /** set when status is "paused": the question the agent has to answer */
  ask?: PendingAsk;
}

/** Thrown by an ask step that has no answer yet: unwinds the run without failing it. */
class AskPause extends RecipeError {
  ask: PendingAsk;
  constructor(ask: PendingAsk) {
    super('ASK_PENDING', `waiting for the agent to answer: ${ask.question}`);
    this.ask = ask;
  }
}

class StepFailure extends RecipeError {
  stepId: string;
  stepPath: string;
  constructor(err: RecipeError, stepId: string, stepPath: string) {
    super(err.code, err.message, err.details);
    this.stepId = stepId;
    this.stepPath = stepPath;
  }
}

const CONTROL = new Set(['if', 'forEach', 'while', 'group', 'recipe']);
const RAW_KEYS = new Set(['expect', 'filter', 'until', 'that', 'when', 'do', 'then', 'else', 'steps', 'collectFrom', 'fields', 'item', 'in']);

/** Same rule as resolveProfile step 2: <recipe site>/default ("*" → default/default). */
export function defaultProfile(tpl: any): string {
  return `${siteKey(tpl.site?.[0]) || 'default'}/default`;
}

export function coerceInputs(tpl: any, raw: Record<string, any> = {}): Record<string, any> {
  const defs = tpl.inputs || {};
  const out: Record<string, any> = {};
  for (const k of Object.keys(raw)) if (!(k in defs)) throw new RecipeError('INPUT_INVALID', `unknown input "${k}" (template accepts: ${Object.keys(defs).join(', ') || 'none'})`);
  for (const [k, d] of Object.entries<any>(defs)) {
    let v = raw[k] !== undefined ? raw[k] : d.default;
    if (v === undefined) {
      if (d.required === false) continue;
      throw new RecipeError('INPUT_INVALID', `missing required input "${k}"${d.description ? ` (${d.description})` : ''}. Pass --input ${k}=...`);
    }
    if (d.type === 'integer' || d.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || (d.type === 'integer' && !Number.isInteger(n))) throw new RecipeError('INPUT_INVALID', `input "${k}" must be ${d.type}, got ${JSON.stringify(v)}`);
      v = n;
    } else if (d.type === 'boolean') v = v === true || v === 'true' || v === '1' || v === 1;
    else if ((d.type === 'array' || d.type === 'object') && typeof v === 'string') {
      try { v = JSON.parse(v); } catch { throw new RecipeError('INPUT_INVALID', `input "${k}" must be JSON ${d.type}`); }
    } else if (d.type === 'string') v = String(v);
    if (d.enum && !d.enum.includes(v)) throw new RecipeError('INPUT_INVALID', `input "${k}" must be one of ${JSON.stringify(d.enum)}`);
    out[k] = v;
  }
  return out;
}

export function maskInputs(tpl: any, inputs: Record<string, any>) {
  const out: any = { ...inputs };
  for (const [k, d] of Object.entries<any>(tpl.inputs || {})) if (d.secret && k in out) out[k] = '***';
  return out;
}

function normalizeError(e: any): RecipeError {
  if (e instanceof RecipeError) return e;
  const msg = String(e?.message || e);
  if (/has been closed|Target closed|Browser closed|browser has disconnected/i.test(msg)) return new RecipeError('BROWSER_ERROR', 'browser or page was closed: ' + msg.split('\n')[0]);
  if (/intercepts pointer events|not visible|not stable|not enabled|element is outside of the viewport|detached from the DOM/i.test(msg))
    return new RecipeError('ELEMENT_NOT_ACTIONABLE', msg.split('\n').slice(0, 6).join(' | '));
  if (e?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(msg)) return new RecipeError('ACTION_TIMEOUT', msg.split('\n')[0]);
  if (/net::ERR_/.test(msg)) return new RecipeError('NAVIGATION_FAILED', msg.split('\n')[0]);
  return new RecipeError('STEP_ERROR', msg.split('\n').slice(0, 4).join(' | '));
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
  dialogs: DialogPolicy;
  private dialogListener?: (d: any) => void;
  onAsk: 'pause' | 'default' | 'fail';
  site: string[];
  /** the recipe whose steps are running now: the top template, or a fragment called by a `recipe` step */
  cur: { tpl: any; path: string };
  private depth = 0;
  private dossierWritten = false;

  constructor(opts: RunOptions) {
    this.opts = opts;
    this.tpl = opts.loaded.template;
    const d = this.tpl.defaults || {};
    this.humanize = opts.humanize ?? d.humanize ?? true;
    this.timeout = d.timeoutMs ?? 10000;
    this.screenshots = opts.screenshots ?? d.screenshots ?? 'failure';
    this.handoffMode = opts.headless ? 'never' : opts.handoff ?? 'auto';
    this.onAsk = opts.onAsk ?? (opts.connected ? 'fail' : 'pause');
    this.dialogs = dialogPolicy(d.dialogs, opts.dialogs);
    this.site = this.tpl.site || [];
    this.cur = { tpl: this.tpl, path: opts.loaded.path };
    this.scope = { inputs: {}, vars: {}, account: opts.account || {} };
  }

  // ---------- checkpoint (state.json) ----------
  private nextTop = 0;
  /** forEach progress by step path, so a resume skips iterations that already finished */
  private loops: Record<string, { next: number; fp: string; results: any[]; failures: any[] }> = {};
  private resumeLoops: Record<string, any> = {};
  /**
   * Finer progress inside the current top-level step, used only to continue a run paused at an ask step:
   * which nested steps already finished, which if-branch was taken, which while round we were in.
   * A failed run resumed with --resume ignores these and redoes the top-level step (the page may have changed).
   */
  private done = new Set<string>();
  private resumeDone = new Set<string>();
  private branches: Record<string, 'then' | 'else'> = {};
  private resumeBranches: Record<string, 'then' | 'else'> = {};
  private whileAt: Record<string, number> = {};
  private resumeWhileAt: Record<string, number> = {};
  /** answers given by the agent, by step path (written into state.json by `answer`) */
  private answers: Record<string, any> = {};
  private answeredSince: Record<string, string> = {};
  /** close Chrome when the run really ends (it was started by this run and --keep-open was not given) */
  private ownsBrowser = false;
  private persist() {
    this.rec.saveState({
      nextStep: this.nextTop, nextStepId: this.tpl.steps[this.nextTop]?.id ?? null, vars: this.scope.vars, inputs: this.scope.inputs, loops: this.loops,
      done: [...new Set([...this.resumeDone, ...this.done])], branches: { ...this.resumeBranches, ...this.branches }, whileAt: { ...this.resumeWhileAt, ...this.whileAt },
      answers: this.answers, ownsBrowser: this.ownsBrowser,
      frames: Object.fromEntries(Object.entries({ ...this.resumeFrames, ...this.frames }).map(([k, f]: [string, any]) => [k, { inputs: f.inputs, vars: f.vars }])),
    });
  }
  /** variables of recipe fragments that are running now (by step path), so a pause inside one can continue */
  private frames: Record<string, Scope> = {};
  private resumeFrames: Record<string, { inputs: any; vars: any }> = {};
  private clearInner() {
    this.done.clear();
    this.resumeDone.clear();
    this.branches = {};
    this.resumeBranches = {};
    this.whileAt = {};
    this.resumeWhileAt = {};
    this.frames = {};
    this.resumeFrames = {};
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
    if (!this.site.some((d) => hostMatches(host, d))) throw new RecipeError('NAVIGATION_BLOCKED', `page is on "${host}", outside site [${this.site.join(', ')}]`);
  }

  async detectEnv(err: RecipeError): Promise<RecipeError | null> {
    if (ENV_ERROR_CODES.has(err.code) || err.code === 'HANDOFF_REQUIRED') return err;
    try {
      const ch = await this.evalIso<string | null>(inpageCall('detectChallenge'));
      if (ch) return new RecipeError('CHALLENGE_DETECTED', `captcha / risk-control page detected (${ch})`);
      const url = this.page.url();
      if (/\/(login|signin|sign-in|sign_in)\b|\/flow\/login|passport\./i.test(url)) {
        const lc = this.cur.tpl.account?.loginCheck;
        if (!lc || !(await this.cond(lc, this.scope)).pass) return new RecipeError('LOGIN_REQUIRED', `redirected to a login page: ${url}`);
      }
    } catch {}
    return null;
  }

  // ---------- human handoff ----------
  async handoff(reason: string, until: any | null, code: string): Promise<number> {
    if (this.handoffMode === 'never') throw new RecipeError(code, `${reason} (human needed, but this run is non-interactive)`);
    const started = Date.now();
    const timeoutMs = this.opts.handoffTimeoutMs ?? 15 * 60 * 1000;
    const flag = path.join(this.rec.dir, 'CONTINUE');
    writeJson(path.join(this.rec.dir, 'HANDOFF.json'), { reason, since: new Date().toISOString(), continueFile: flag, until });
    this.rec.events.emit('handoff.start', { reason, code, timeoutMs });
    let resolved = false;
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
      if (Date.now() - started >= timeoutMs) throw new RecipeError(code, `${reason} (no human action within ${Math.round(timeoutMs / 60000)} min)`);
      resolved = true;
    } finally {
      this.rec.events.emit('handoff.end', { code, waitedMs: Date.now() - started, resolved });
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
    if (!v.ok) throw new RecipeError('TEMPLATE_INVALID', `template is invalid:\n` + v.errors.map((e) => `  [${e.stepId ?? '-'}] ${e.path}: ${e.message}`).join('\n'));
    const calls = checkRecipeCalls(this.tpl, this.opts.loaded.path).filter((e) => e.level === 'error');
    if (calls.length) throw new RecipeError('TEMPLATE_INVALID', `recipe calls are invalid:\n` + calls.map((e) => `  [${e.stepId ?? '-'}] ${e.path}: ${e.message}`).join('\n'));
    let resumeState: any = null;
    let inputs = this.opts.inputs || {};
    let cont: { prev: any; ask: PendingAsk | null } | null = null;
    if (this.opts.continueRun) {
      const dir = this.opts.continueRun;
      const runFile = path.join(dir, 'run.json');
      if (!fs.existsSync(runFile)) throw new RecipeError('INPUT_INVALID', `${dir} is not a run directory (no run.json)`);
      const prev = readJson(runFile);
      if (prev.status !== 'paused') throw new RecipeError('INPUT_INVALID', `run ${dir} is "${prev.status}", not paused at a question; only a paused run can continue`);
      resumeState = readJson(path.join(dir, 'state.json'));
      inputs = { ...(resumeState.inputs || {}), ...inputs };
      this.opts.profile ??= prev.profile;
      cont = { prev, ask: readPendingAsk(dir) };
      if (prev.templateVersion !== this.tpl.version) log.info(`⚠️ the recipe changed since this run paused (${prev.templateVersion} → ${this.tpl.version}); continuing with the new version`);
    } else if (this.opts.resumeFrom) {
      const runFile = path.join(this.opts.resumeFrom, 'run.json');
      if (!fs.existsSync(runFile)) throw new RecipeError('INPUT_INVALID', `--resume: ${this.opts.resumeFrom} is not a run directory (no run.json). List runs with: browser-recipewright runs`);
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
    this.rec = new RunRecorder(this.tpl.id, this.opts.runsDir, this.opts.continueRun);
    if (cont) {
      const p = cont.ask?.path ?? this.tpl.steps[resumeState.nextStep || 0]?.id ?? '-';
      this.rec.resume({ path: p, stepId: cont.ask?.stepId });
      if (cont.ask) this.answeredSince[cont.ask.path] = cont.ask.since;
      fs.rmSync(path.join(this.rec.dir, ASK_FILE), { force: true });
      log.info(`▶ ${this.tpl.id}@${this.tpl.version}  continuing paused run ${this.rec.dir}`);
    } else this.rec.start({
      templateId: this.tpl.id,
      templateVersion: this.tpl.version,
      templatePath: this.opts.loaded.path,
      profile,
      account: this.opts.account?.id ?? null,
      inputs: maskInputs(this.tpl, this.scope.inputs),
      resumedFrom: this.opts.resumeFrom ?? null,
      options: { humanize: this.humanize, headless: !!this.opts.headless, handoff: this.handoffMode, screenshots: this.screenshots },
    }, this.tpl.steps);
    if (!cont) log.info(`▶ ${this.tpl.id}@${this.tpl.version}  profile=${profile}  run=${this.rec.dir}`);
    if (resumeState) {
      this.scope.vars = resumeState.vars || {};
      this.resumeLoops = resumeState.loops || {};
      this.loops = { ...this.resumeLoops };
      this.nextTop = resumeState.nextStep || 0;
    }
    if (cont) {
      this.resumeDone = new Set(resumeState.done || []);
      this.resumeBranches = resumeState.branches || {};
      this.resumeWhileAt = resumeState.whileAt || {};
      this.answers = resumeState.answers || {};
      this.resumeFrames = resumeState.frames || {};
      this.ownsBrowser = !!resumeState.ownsBrowser && !this.opts.keepOpen;
    }
    // checkpoint right away, so even a run that fails before step 1 can be resumed
    this.persist();

    let output: any = null;
    let error: RunResult['error'];
    let paused: PendingAsk | null = null;
    let startIdx = 0;
    try {
      this.conn = this.opts.connected ?? (await connect(profile, { headless: this.opts.headless }));
      if (!cont && !this.opts.connected) this.ownsBrowser = this.conn.launchedHere && !this.opts.keepOpen;
      this.page = this.conn.page;
      this.dialogListener = (d: any) => this.onDialog(d);
      this.page.on('dialog', this.dialogListener);
      this.watchPage(this.page);
      if (cont) {
        startIdx = this.nextTop;
        // the browser normally still shows the page where the question was asked; if it was closed meanwhile, go back there
        const url = cont.ask?.url;
        if (url && /^https?:/.test(url) && this.page.url() !== url) {
          log.info(`↻ the browser is not on the page of the question any more; opening ${url}`);
          this.checkSite(url);
          await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      } else if (resumeState) {
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
      } else {
        if (this.tpl.account?.loginCheck && !this.opts.skipLoginCheck) await this.loginCheck();
        await this.applyStartOn(this.tpl, this.scope, '');
      }
      const saveState = (next: number) => { this.nextTop = next; this.persist(); };
      for (const v of appendTargets(this.tpl.steps)) if (!Array.isArray(this.scope.vars[v])) this.scope.vars[v] = [];
      saveState(startIdx);
      for (let i = startIdx; i < this.tpl.steps.length; i++) {
        const st = this.tpl.steps[i];
        await this.execStep(st, st.id, this.scope);
        this.clearInner();
        saveState(i + 1);
      }
      output = this.tpl.outputs ? render(this.tpl.outputs.from, this.scope) : this.scope.vars;
      if (this.tpl.outputs?.schema) {
        const errs = checkSchema(output, this.tpl.outputs.schema);
        if (errs.length) throw Object.assign(new RecipeError('OUTPUT_INVALID', errs.join('; ')), { stepId: null });
      }
    } catch (e: any) {
      if (e instanceof AskPause) {
        paused = e.ask;
        return this.finishPaused(paused, output);
      }
      const err = normalizeError(e);
      error = { code: err.code, message: err.message, stepId: e.stepId ?? null, path: e.stepPath ?? null, category: errorCategory(err.code) };
      if (output === null && this.tpl.outputs) output = (() => { try { return render(this.tpl.outputs.from, this.scope); } catch { return null; } })();
      if (!this.dossierWritten) await this.writeDossier(null, err, error.path ?? '-', null).catch(() => {});
    } finally {
      if (this.page) this.unwatchPage(this.page);
      if (this.page && this.dialogListener) this.page.off('dialog', this.dialogListener);
      if (!paused) this.rec.writeOutput(output);
      if (this.conn && !this.opts.connected) {
        // a paused run always leaves the browser open on the page, so the agent's answer continues right there
        if (!paused && (this.ownsBrowser || this.opts.forceClose)) await closeSession(this.conn.session.profile, this.conn.browser).catch(() => {});
        else await disconnect(this.conn);
      }
    }
    const status = error ? 'failed' : 'success';
    // usage per site+account (for the batch reminder and `accounts`): every real run that ended counts; act (connected) and runs that never got
    // past the login check do not
    if (!this.opts.connected && error?.code !== 'LOGIN_REQUIRED') {
      try { recordUsage(this.opts.profile || defaultProfile(this.tpl), itemsOf(status, output)); } catch {}
    }
    this.rec.finish({ status, error: error ?? null, outputCount: Array.isArray(output) ? output.length : undefined });
    const res: RunResult = { status, runDir: this.rec.dir, output, outputPath: path.join(this.rec.dir, 'output.json'), error };
    if (error) res.dossier = path.join(this.rec.dir, 'failure', 'dossier.json');
    log.info(error ? `✗ failed at ${error.stepId ?? '-'}: ${error.code} ${error.message}` : `✓ success → ${res.outputPath}`);
    return res;
  }

  /** The run stopped at an ask step: record it as paused (not finished) and tell the caller what is asked. */
  private finishPaused(ask: PendingAsk, output: any): RunResult {
    this.rec.writeOutput(output ?? null);
    this.rec.pause({ path: ask.path, stepId: ask.stepId, question: ask.question });
    log.info(`⏸  paused at ${ask.path}: ${ask.question}`);
    log.info(`   answer with: ${ask.how}`);
    return { status: 'paused', runDir: this.rec.dir, output: null, outputPath: path.join(this.rec.dir, 'output.json'), ask };
  }

  async loginCheck() {
    const a = this.tpl.account;
    const url = a.checkUrl ? String(render(a.checkUrl, this.scope)) : `https://${this.site[0].replace(/^\*\./, '')}/`;
    const seq = this.rec.nextSeq();
    const started = Date.now();
    const urlBefore = this.page.url();
    this.rec.events.emit('step.start', { step: seq, path: '_login-check', stepId: '_login-check', action: 'loginCheck', url: urlBefore });
    // a fragment called while the browser is already on its start page checks the login right there, without leaving
    const inPlace = !this.page.url().startsWith(url) && (await this.startOnHolds(this.tpl, this.scope));
    if (!this.page.url().startsWith(url) && !inPlace) await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    let r = await this.waitCond(a.loginCheck, this.scope, inPlace ? 3000 : 8000);
    if (!r.pass && inPlace) {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      r = await this.waitCond(a.loginCheck, this.scope, 8000);
    }
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

  // ---------- fragments ----------
  async startOnHolds(tpl: any, scope: Scope): Promise<boolean> {
    if (!tpl.startOn?.when || !/^https?:/.test(this.page.url())) return false;
    return (await this.cond(tpl.startOn.when, scope).catch(() => ({ pass: false }))).pass;
  }

  /**
   * startOn: a recipe is a fragment that may be called in the middle of a task, on a page the browser already shows.
   * If the page fits `when`, start right here; else open `goto`; else fail with START_PAGE_MISMATCH.
   */
  async applyStartOn(tpl: any, scope: Scope, prefix: string) {
    const so = tpl.startOn;
    if (!so) return;
    const p = prefix ? `${prefix}._start-on` : '_start-on';
    const seq = this.rec.nextSeq();
    const started = Date.now();
    const urlBefore = this.page.url();
    this.rec.events.emit('step.start', { step: seq, path: p, stepId: '_start-on', action: 'startOn', url: urlBefore });
    const record = (status: 'ok' | 'failed', expect: any, extra: any = {}) =>
      this.rec.step({ seq, stepId: '_start-on', path: p, action: 'startOn', status, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, urlBefore, urlAfter: this.page.url(), locator: null, expect, attempts: 1, output: null, artifacts: [], ...extra });
    let r = /^https?:/.test(urlBefore) ? await this.waitCond(so.when, scope, 1500) : { pass: false, why: 'no page open yet' };
    if (r.pass) {
      record('ok', { result: 'pass', why: r.why }, { note: 'already on the start page' });
      log.info(`  ✓ ${p}: already on the start page, starting here (${urlBefore})`);
      return;
    }
    try {
      if (!so.goto) throw new RecipeError('START_PAGE_MISMATCH', `recipe "${tpl.id}" must start on a page where ${r.why}, but the browser is on ${urlBefore}. Run the fragment that leads there first (or give the recipe startOn.goto).`);
      const url = String(render(so.goto, scope));
      this.checkSite(url);
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(this.timeout, 30000) });
      r = await this.waitCond(so.when, scope, this.timeout);
      if (!r.pass) throw new RecipeError('START_PAGE_MISMATCH', `opened ${url} for recipe "${tpl.id}", but its start condition is not met: ${r.why}`);
    } catch (e: any) {
      const err = normalizeError(e);
      record('failed', { result: 'fail', why: r.why }, { error: { code: err.code, message: err.message, category: errorCategory(err.code) } });
      throw new StepFailure(err, '_start-on', p);
    }
    record('ok', { result: 'pass', why: r.why }, { note: `opened ${so.goto}` });
    log.info(`  ✓ ${p}: opened the start page`);
  }

  /** recipe step: run another recipe (a fragment) here, on the same page, in this run; returns its outputs. */
  async runFragment(step: any, stepPath: string, scope: Scope, rec: StepRecord): Promise<any> {
    const sub = resolveRecipe(String(render(step.recipe, scope)), this.cur.path);
    const tpl = sub.template;
    if (this.depth + 1 >= MAX_RECIPE_DEPTH) throw new RecipeError('TEMPLATE_INVALID', `recipe calls are nested more than ${MAX_RECIPE_DEPTH} deep`);
    const v = validateTemplate(tpl);
    if (!v.ok) throw new RecipeError('TEMPLATE_INVALID', `called recipe "${tpl.id}" is invalid: ` + v.errors.map((e) => `[${e.stepId ?? '-'}] ${e.message}`).join('; '));
    const saved = this.resumeFrames[stepPath];
    delete this.resumeFrames[stepPath];
    const child: Scope = {
      inputs: saved?.inputs ?? coerceInputs(tpl, step.inputs ? render(step.inputs, scope) : {}),
      vars: saved?.vars ?? {},
      account: scope.account,
    };
    for (const name of appendTargets(tpl.steps)) if (!Array.isArray(child.vars[name])) child.vars[name] = [];
    this.frames[stepPath] = child;
    rec.recipe = { id: tpl.id, version: tpl.version, path: sub.path };
    rec.note = `${tpl.id}@${tpl.version}`;
    this.rec.events.emit('recipe.enter', { path: stepPath, recipeId: tpl.id, recipeVersion: tpl.version, inputs: maskInputs(tpl, child.inputs), ...(saved ? { resumed: true } : {}) });
    log.info(`  ▸ ${stepPath}: recipe ${tpl.id}@${tpl.version}`);
    const prev = { cur: this.cur, site: this.site, timeout: this.timeout };
    this.cur = { tpl, path: sub.path };
    this.site = tpl.site || [];
    this.timeout = tpl.defaults?.timeoutMs ?? 10000;
    this.depth++;
    try {
      if (!saved) await this.applyStartOn(tpl, child, stepPath);
      for (const st of tpl.steps) await this.execStep(st, `${stepPath}.${st.id}`, child);
      const out = tpl.outputs ? render(tpl.outputs.from, child) : child.vars;
      if (tpl.outputs?.schema) {
        const errs = checkSchema(out, tpl.outputs.schema);
        if (errs.length) throw new RecipeError('OUTPUT_INVALID', `recipe "${tpl.id}": ${errs.join('; ')}`);
      }
      delete this.frames[stepPath];
      return out;
    } finally {
      this.cur = prev.cur;
      this.site = prev.site;
      this.timeout = prev.timeout;
      this.depth--;
    }
  }

  async screenshot(name: string, rec?: StepRecord) {
    const p = this.rec.artifactPath(`${String(rec?.seq ?? 0).padStart(4, '0')}-${name}.png`);
    await this.page.screenshot({ path: p, timeout: 5000 }).catch(() => {});
    if (fs.existsSync(p)) {
      const rel = path.relative(this.rec.dir, p);
      rec?.artifacts.push(rel);
      this.rec.artifact(rel, 'screenshot', rec?.seq);
    }
  }

  async writeDossier(step: any | null, err: RecipeError, stepPath: string, rec: StepRecord | null) {
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
    // a failure inside a called recipe points at that recipe: it is the file to patch
    const tplPath = this.cur.path;
    const dossier = {
      runDir: this.rec.dir,
      templateId: this.cur.tpl.id,
      templateVersion: this.cur.tpl.version,
      ...(this.cur.tpl !== this.tpl ? { calledFrom: { templateId: this.tpl.id, templatePath: this.opts.loaded.path } } : {}),
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
          ? ['Environment problem: do not edit the template. Ask the human to fix login / captcha, then resume:', `browser-recipewright run "${this.opts.loaded.path}" --resume "${this.rec.dir}"`]
          : [
              '1. Read failure/snapshot.txt (refs in snapshot.refs.json give ready-made locator candidates).',
              `2. Write a patch for step "${step?.id ?? '?'}" only, then: browser-recipewright patch "${tplPath}" patch.json --write`,
              `3. Verify from the failed top-level step: browser-recipewright run "${this.opts.loaded.path}" --resume "${this.rec.dir}"`,
            ],
    };
    writeJson(path.join(fdir, 'dossier.json'), dossier);
    if (fs.existsSync(path.join(fdir, 'screenshot.png'))) this.rec.artifact('failure/screenshot.png', 'failure-screenshot', rec?.seq);
    this.rec.artifact('failure/dossier.json', 'dossier', rec?.seq);
  }

  // ---------- run data events (for viewer plugins; see docs/run-data-format.md) ----------
  private navListener?: (f: any) => void;
  watchPage(page: Page) {
    const ev = this.rec.events;
    human.observeInput(page, {
      move: (to, from, ms) => ev.emit('pointer.move', { x: Math.round(to.x), y: Math.round(to.y), fromX: Math.round(from.x), fromY: Math.round(from.y), durationMs: ms }),
      click: (at, button, count) => ev.emit('pointer.click', { x: Math.round(at.x), y: Math.round(at.y), button, count }),
      wheel: (dy, at) => ev.emit('pointer.wheel', { dy, ...(at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}) }),
      type: (chars) => ev.emit('key.type', { chars }),
    });
    // the viewport size lets a viewer place pointer.* coordinates; a real Chrome window has no fixed viewport,
    // so it is measured (in the isolated world) after each navigation and reported only when it changed
    let lastVp = '';
    const measure = () => {
      const fixed = page.viewportSize();
      const p = fixed ? Promise.resolve(fixed) : this.evalIso<any>('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
      p.then((vp) => {
        const k = JSON.stringify(vp);
        if (vp && k !== lastVp && this.navListener) { lastVp = k; ev.emit('page.viewport', vp); }
      }).catch(() => {});
    };
    const nav = (frame: any) => {
      if (frame !== page.mainFrame()) return;
      ev.emit('page.navigated', { url: frame.url() });
      measure();
    };
    this.navListener = nav;
    page.on('framenavigated', nav);
    ev.emit('page.navigated', { url: page.url() });
    measure();
  }
  /** Answer a JS dialog by the policy (an unanswered dialog would freeze the page) and record it. */
  onDialog(d: any) {
    const { action, promptText } = this.dialogs;
    const type = d.type();
    const message = String(d.message() || '').slice(0, 500);
    const p = action === 'accept' ? d.accept(type === 'prompt' ? promptText ?? d.defaultValue() : undefined) : d.dismiss();
    p.catch(() => {});
    log.info(`  💬 ${type} dialog "${message.slice(0, 80)}" → ${action}`);
    this.rec?.events.emit('dialog', { dialogType: type, message, action, ...(action === 'accept' && type === 'prompt' ? { promptText: promptText ?? d.defaultValue() } : {}) });
  }
  unwatchPage(page: Page) {
    human.observeInput(page, null);
    if (this.navListener) page.off('framenavigated', this.navListener);
    this.navListener = undefined;
  }
  /** One "data" event when a step stores what it extracted (saveAs / appendTo / collect). */
  emitData(step: any, stepPath: string, rec: StepRecord, value: any) {
    if (!step.saveAs && !step.appendTo && step.action !== 'collect') return;
    const mode = step.appendTo ? 'append' : step.action === 'collect' ? 'collect' : 'save';
    const added = rec.appended ? rec.appended.added : value == null ? 0 : Array.isArray(value) ? value.length : 1;
    const e: any = { step: rec.seq, path: stepPath, mode, added, preview: preview(rec.appended && !Array.isArray(value) ? (value == null ? [] : [value]) : value) };
    if (step.saveAs) e.var = step.saveAs;
    if (rec.appended) Object.assign(e, { var: rec.appended.var, total: rec.appended.total, duplicates: rec.appended.duplicates });
    this.rec.events.emit('data', e);
  }

  // ---------- step execution ----------
  async execStep(step: any, stepPath: string, scope: Scope): Promise<any> {
    if (this.resumeDone.has(stepPath)) {
      // continuing after a question: this step already finished before the pause
      this.done.add(stepPath);
      log.info(`  · ${stepPath} (${step.action}) already done before the pause`);
      return step.saveAs ? scope.vars[step.saveAs] ?? null : null;
    }
    const rec: StepRecord = {
      seq: this.rec.nextSeq(), stepId: step.id, path: stepPath, action: step.action, status: 'ok',
      startedAt: new Date().toISOString(), durationMs: 0, urlBefore: this.page.url(), urlAfter: null,
      locator: null, expect: null, attempts: 0, output: null, artifacts: [],
    };
    this.rec.events.emit('step.start', { step: rec.seq, path: stepPath, stepId: step.id, action: step.action, url: rec.urlBefore, ...(step.description ? { description: step.description } : {}) });
    const t0 = Date.now();
    const finish = () => {
      rec.durationMs = Date.now() - t0;
      rec.urlAfter = this.page.url();
      this.rec.step(rec);
    };

    if (step.action === 'ask') return this.execAsk(step, stepPath, scope, rec, finish);

    if (CONTROL.has(step.action)) {
      rec.attempts = 1;
      try {
        const out = await this.control(step, stepPath, scope, rec);
        rec.output = truncateForRecord(out, 600);
        if (step.saveAs) scope.vars[step.saveAs] = out;
        if (step.appendTo) rec.appended = appendTo(scope, step.appendTo, out);
        this.emitData(step, stepPath, rec, out);
        finish();
        this.done.add(stepPath);
        return out;
      } catch (e: any) {
        if (e instanceof AskPause) {
          rec.status = 'paused';
          finish();
          throw e;
        }
        const err = normalizeError(e);
        rec.status = 'failed';
        rec.error = { code: err.code, message: err.message, category: errorCategory(err.code) };
        finish();
        throw e instanceof StepFailure ? e : new StepFailure(err, step.id, stepPath);
      }
    }

    const retries = step.retries ?? this.cur.tpl.defaults?.retries ?? 0;
    const timeout = step.timeoutMs ?? this.timeout;
    let value: any;
    let lastErr: RecipeError | null = null;
    let handoffUsed = false;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      rec.attempts++;
      try {
        value = await this.atomic(step, scope, rec, timeout);
        if (step.expect) {
          const r = await this.waitCond(step.expect, scope, timeout);
          rec.expect = { result: r.pass ? 'pass' : 'fail', why: r.why };
          if (!r.pass) throw new RecipeError('EXPECT_FAILED', `expect not met: ${r.why}`);
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
              rec.handoffMs = await this.handoff(env.code === 'LOGIN_REQUIRED' ? '登录已失效，请在浏览器里重新登录' : '检测到验证码/风控页，请手动完成', env.code === 'CHALLENGE_DETECTED' ? { not: { urlMatches: 'captcha|challenge|account/access' } } : this.cur.tpl.account?.loginCheck ?? null, env.code);
              attempt--;
              continue;
            } catch (he: any) {
              lastErr = normalizeError(he);
            }
          }
          break;
        }
        if (lastErr.code === 'NAVIGATION_BLOCKED' || lastErr.code === 'SCRIPT_REJECTED' || lastErr.code === 'TEMPLATE_INVALID') break;
        if (attempt <= retries) {
          this.rec.events.emit('step.retry', { step: rec.seq, path: stepPath, attempt: attempt + 1, error: { code: lastErr.code, message: lastErr.message } });
          await sleep(600 * attempt);
        }
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
        this.done.add(stepPath);
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
    this.emitData(step, stepPath, rec, value);
    if (this.screenshots === 'every' || step.screenshot) await this.screenshot(step.id, rec);
    finish();
    this.done.add(stepPath);
    log.info(`  ✓ ${stepPath} (${step.action}) ${rec.durationMs}ms${rec.locator?.hit > 0 ? ` [fallback locator #${rec.locator.hit}]` : ''}`);
    if (!['wait'].includes(step.action)) {
      const gap = pickMs(this.cur.tpl.defaults?.stepGapMs, 0);
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
            if (e instanceof AskPause) throw e;
            if (a >= tries || errorCategory(e.code) === 'env') {
              if (step.optional && errorCategory(e.code) === 'template') { rec.status = 'soft-failed'; return null; }
              throw e;
            }
            this.dossierWritten = false;
            await sleep(800);
          }
        }
      }
      case 'recipe':
        return this.runFragment(step, stepPath, scope, rec);
      case 'if': {
        let taken = this.resumeBranches[stepPath];
        if (taken) {
          delete this.resumeBranches[stepPath];
          rec.expect = { branch: taken, why: 'same branch as before the pause' };
        } else {
          const r = await this.cond(step.when, scope);
          taken = r.pass ? 'then' : 'else';
          rec.expect = { branch: taken, why: r.why };
        }
        this.branches[stepPath] = taken;
        const branch = taken === 'then' ? step.then : step.else || [];
        for (const s of branch) await this.execStep(s, `${stepPath}.${s.id}`, scope);
        return null;
      }
      case 'while': {
        let i = 0;
        // continuing after a question asked inside this loop: go back into the same round without re-checking
        let inRound = stepPath in this.resumeWhileAt;
        if (inRound) {
          i = this.resumeWhileAt[stepPath];
          delete this.resumeWhileAt[stepPath];
        }
        for (; i < step.maxIterations; i++) {
          if (!inRound && !(await this.cond(step.when, scope)).pass) break;
          inRound = false;
          this.whileAt[stepPath] = i;
          this.rec.events.emit('loop.iteration', { path: stepPath, index: i, max: step.maxIterations });
          for (const s of step.do) await this.execStep(s, `${stepPath}[${i}].${s.id}`, scope);
        }
        rec.note = `${i} iteration(s)`;
        return null;
      }
      case 'forEach': {
        const list = typeof step.in === 'string' ? render(step.in, scope) : step.in;
        if (!Array.isArray(list)) throw new RecipeError('STEP_ERROR', `forEach "in" is not an array (got ${typeof list})`);
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
        const prefix = (i: number) => `${stepPath}[${i}].`;
        for (let i = from; i < Math.min(list.length, max); i++) {
          // a round interrupted by a question keeps the values its finished steps saved
          const partlyDone = i === from && [...this.resumeDone].some((p) => p.startsWith(prefix(i)));
          if (!partlyDone) for (const k of innerSaves) delete scope.vars[k];
          const s2: Scope = { ...scope, [step.as]: list[i], index: i };
          this.rec.events.emit('loop.iteration', { path: stepPath, index: i, total: Math.min(list.length, max), item: preview(list[i], 1, 200) });
          try {
            for (const s of step.do) await this.execStep(s, `${stepPath}[${i}].${s.id}`, s2);
            if (step.collectFrom !== undefined) results.push(render(step.collectFrom, s2));
          } catch (e: any) {
            if (e instanceof AskPause || !step.continueOnError || errorCategory(e.code) === 'env') throw e;
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

  // ---------- breakpoints ----------
  /**
   * ask: use the agent's stored answer, or the default in unattended runs; otherwise stop here (browser stays on
   * the page), write ask.json with the question and data, and let the agent answer with `browser-recipewright answer`.
   */
  async execAsk(step: any, stepPath: string, scope: Scope, rec: StepRecord, finish: () => void): Promise<any> {
    rec.attempts = 1;
    const fail = (err: RecipeError) => {
      rec.status = 'failed';
      rec.error = { code: err.code, message: err.message, category: errorCategory(err.code) };
      finish();
      log.info(`  ✗ ${stepPath} (ask) ${err.code}: ${err.message}`);
      return new StepFailure(err, step.id, stepPath);
    };
    const question = String(render(step.question, scope));
    const data = step.data === undefined ? null : render(step.data, scope);
    const spec = { ...(step.answer || {}), type: step.answer?.type ?? 'text' };
    let raw: any;
    let source: 'agent' | 'default' | null = null;
    if (Object.prototype.hasOwnProperty.call(this.answers, stepPath)) {
      raw = this.answers[stepPath];
      delete this.answers[stepPath];
      source = 'agent';
    } else if (this.onAsk === 'default' && step.default !== undefined) {
      raw = render(step.default, scope);
      source = 'default';
    }
    if (source === null) {
      if (this.onAsk !== 'pause') {
        throw fail(new RecipeError('ASK_UNANSWERED', `step asks the agent "${question}", but this run cannot stop for an answer (on-ask: ${this.onAsk})${step.default === undefined ? ' and the step has no default' : ''}`));
      }
      const ask: PendingAsk = {
        runDir: this.rec.dir, templateId: this.tpl.id, templatePath: this.opts.loaded.path, stepId: step.id, path: stepPath,
        question, answer: spec, data, ...(step.default !== undefined ? { default: render(step.default, scope) } : {}),
        url: this.page.url(), since: new Date().toISOString(),
        how: `browser-recipewright answer "${this.rec.dir}" --value '<JSON>'${spec.type === 'pick' ? '   (pick: item numbers starting at 0, e.g. [0,2,5])' : spec.type === 'choice' ? `   (one of ${JSON.stringify(spec.options)})` : ''}`,
      };
      writeJson(path.join(this.rec.dir, ASK_FILE), ask);
      this.rec.events.emit('ask.start', {
        step: rec.seq, path: stepPath, stepId: step.id, question, answerType: spec.type,
        ...(spec.options ? { options: spec.options } : {}), ...(Array.isArray(data) ? { items: data.length } : {}),
        ...(data != null ? { data: preview(data, 5, 300) } : {}), ...(step.default !== undefined ? { hasDefault: true } : {}),
      });
      rec.status = 'paused';
      rec.note = 'waiting for the agent';
      finish();
      this.persist();
      throw new AskPause(ask);
    }
    let value: any;
    try {
      value = coerceAnswer(spec, raw, data);
    } catch (e: any) {
      throw fail(normalizeError(e));
    }
    const since = this.answeredSince[stepPath];
    delete this.answeredSince[stepPath];
    this.rec.events.emit('ask.answered', {
      step: rec.seq, path: stepPath, stepId: step.id, source, value: preview(value, 5, 300),
      ...(spec.type === 'pick' && Array.isArray(raw) ? { picked: raw } : {}), ...(since ? { waitedMs: Date.now() - Date.parse(since) } : {}),
    });
    rec.output = truncateForRecord(value);
    rec.answeredBy = source;
    rec.question = question;
    if (step.saveAs) scope.vars[step.saveAs] = value;
    if (step.appendTo) rec.appended = appendTo(scope, step.appendTo, value);
    this.emitData(step, stepPath, rec, value);
    finish();
    this.done.add(stepPath);
    log.info(`  ✓ ${stepPath} (ask) answered by ${source}: ${JSON.stringify(preview(value, 3, 120))}`);
    return value;
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
      case 'back': {
        // A page restored from the back/forward cache fires no new DOMContentLoaded, so waiting for it can hang
        // until the timeout even though the browser is already showing the previous page. Wait for the commit,
        // then give the load state a bounded chance; the step's `expect` decides whether we landed right.
        const before = page.url();
        const res = await page.goBack({ waitUntil: 'commit', timeout: Math.max(timeout, 30000) });
        if (!res && page.url() === before) throw new RecipeError('NAVIGATION_FAILED', 'there is no previous page to go back to');
        // res is null for a cache restore: that page is already loaded, so only wait after a real network load
        if (res) await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout, 5000) }).catch(() => {});
        return null;
      }
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
            if (!r.pass) throw new RecipeError('ACTION_TIMEOUT', `element still present after ${timeout}ms`);
          } else {
            // presence only: one or many matches both count as "there"
            const info = await waitPresent(page, render(step.target, scope), timeout);
            rec.locator = { tried: info.tried, hit: info.hit };
          }
        }
        if (s.url) {
          const r = await this.waitCond({ urlContains: s.url }, scope, timeout);
          if (!r.pass) throw new RecipeError('ACTION_TIMEOUT', r.why);
        }
        if (s.text) {
          const r = await this.waitCond({ exists: [{ text: s.text }] }, scope, timeout);
          if (!r.pass) throw new RecipeError('ACTION_TIMEOUT', `text "${s.text}" not visible after ${timeout}ms`);
        }
        if (step.until) {
          const r = await this.waitCond(step.until, scope, timeout);
          if (!r.pass) throw new RecipeError('ACTION_TIMEOUT', r.why);
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
        if (missing.length) throw new RecipeError('LOCATOR_NOT_FOUND', `field(s) not found inside the element: ${missing.join(', ')}`, { locator: rec.locator });
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
        this.rec.artifact(path.relative(this.rec.dir, dest), 'download', rec.seq);
        return dest;
      }
      case 'runScript': {
        const code = loadScriptCode(s.script, this.site);
        return await this.evalIso(`(${code.trim().replace(/;\s*$/, '')})(${JSON.stringify(s.args ?? null)})`);
      }
      case 'assert': {
        const r = await this.cond(step.that, scope);
        rec.expect = { result: r.pass ? 'pass' : 'fail', why: r.why };
        if (!r.pass) throw new RecipeError(s.code || 'ASSERT_FAILED', s.message || `assert failed: ${r.why}`);
        return true;
      }
      case 'handoff': {
        if (step.until && (await this.cond(step.until, scope)).pass) return { skipped: true };
        rec.handoffMs = await this.handoff(String(s.reason), step.until ?? null, 'HANDOFF_REQUIRED');
        return null;
      }
    }
    throw new RecipeError('TEMPLATE_INVALID', `unknown action ${s.action}`);
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
    if (first.total === 0) throw new RecipeError('LOCATOR_NOT_FOUND', `collect: no item matched after ${timeout}ms`, { locator: { tried: item.map((_: any, i: number) => ({ candidate: i, matches: 0 })), hit: null } });
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
