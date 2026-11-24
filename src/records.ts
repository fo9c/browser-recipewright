/**
 * Run records: runs/<id>/run.json + events.jsonl + steps.jsonl + output.json + state.json + artifacts/ + failure/
 * The layout is the public "run data format" (docs/run-data-format.md) that viewer plugins read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs, ensureDir, writeJson, readJson, safeName, timestampId, shortRand, ENV_ERROR_CODES } from './util.js';
import { RunEvents, RUN_FORMAT, RUN_FORMAT_VERSION, stepOutline } from './events.js';

export interface StepRecord {
  seq: number;
  stepId: string;
  path: string;
  action: string;
  status: 'ok' | 'failed' | 'soft-failed' | 'skipped';
  startedAt: string;
  durationMs: number;
  urlBefore: string | null;
  urlAfter: string | null;
  locator: any;
  expect: any;
  attempts: number;
  output: any;
  artifacts: string[];
  error?: { code: string; message: string; category: 'env' | 'template' };
  note?: string;
  [k: string]: any;
}

export const ERROR_HINTS: Record<string, string> = {
  LOCATOR_NOT_FOUND: 'No candidate found the element. Read failure/snapshot.txt, pick a better locator (prefer testid or role+name), patch only this step.',
  LOCATOR_AMBIGUOUS: 'A candidate matched several elements. Add "nth" or "within" to narrow it.',
  ELEMENT_NOT_ACTIONABLE: 'Element found but covered / hidden / animating. Add a waitFor, or close the popup first (optional click step).',
  EXPECT_FAILED: 'The action ran but the page did not reach the expected state. Check that the right element was used and the expect is correct.',
  ACTION_TIMEOUT: 'Timed out. Increase timeoutMs or wait for a more specific condition.',
  NAVIGATION_BLOCKED: 'Page left the allowed site domains. Confirm with the human whether to add the domain to "site".',
  LOGIN_REQUIRED: 'Environment problem: the account is not logged in. Do NOT edit the template; ask the human to log in (browser-recipewright login).',
  CHALLENGE_DETECTED: 'Environment problem: captcha / risk-control page. Do NOT edit the template; hand off to the human.',
  HANDOFF_REQUIRED: 'Environment problem: human action was required but no one was available (non-interactive run).',
  NOT_ENOUGH_RESULTS: 'Fewer items than requested. Relax the filter or raise maxScrolls.',
  OUTPUT_INVALID: 'Steps succeeded but the result does not match outputs.schema. Check the field extraction.',
  SCRIPT_REJECTED: 'Script not whitelisted or hash mismatch. Do not bypass; ask the human to review the script.',
  BROWSER_ERROR: 'Browser could not start or crashed. Run "browser-recipewright doctor".',
  ASSERT_FAILED: 'An assert step failed.',
  INPUT_INVALID: 'Missing or wrongly typed input.',
};

export const errorCategory = (code: string): 'env' | 'template' => (ENV_ERROR_CODES.has(code) || code === 'HANDOFF_REQUIRED' ? 'env' : 'template');

export class RunRecorder {
  dir: string;
  runId: string;
  seq = 0;
  meta: any;
  /** events.jsonl: the stream viewer plugins read (live or afterwards) */
  events: RunEvents;
  private stepsFile: string;
  private baseDir: string;
  constructor(templateId: string, baseDir = dirs.runs()) {
    this.baseDir = baseDir;
    this.runId = `${timestampId()}_${safeName(templateId.replace(/\//g, '-'))}_${shortRand()}`;
    this.dir = ensureDir(path.join(baseDir, this.runId));
    ensureDir(path.join(this.dir, 'artifacts'));
    this.stepsFile = path.join(this.dir, 'steps.jsonl');
    fs.writeFileSync(this.stepsFile, '');
    this.events = new RunEvents(this.dir);
  }
  start(meta: any, steps: any[] = []) {
    this.meta = { format: { name: RUN_FORMAT, version: RUN_FORMAT_VERSION }, runId: this.runId, ...meta, status: 'running', startedAt: new Date().toISOString(), runDir: this.dir };
    writeJson(path.join(this.dir, 'run.json'), this.meta);
    const { format, runDir, status, ...rest } = this.meta;
    this.events.emit('run.start', { ...rest, steps: stepOutline(steps) });
    this.pointLatest();
  }
  /** runs/_latest.json tells a viewer which run is the newest (and whether it is still running) without scanning. */
  private pointLatest() {
    try {
      const m = this.meta;
      writeJson(path.join(this.baseDir, '_latest.json'), { runId: this.runId, runDir: this.dir, templateId: m.templateId, status: m.status, startedAt: m.startedAt, finishedAt: m.finishedAt ?? null });
    } catch {}
  }
  nextSeq() {
    return ++this.seq;
  }
  step(rec: StepRecord) {
    fs.appendFileSync(this.stepsFile, JSON.stringify(rec) + '\n');
    const e: any = { step: rec.seq, path: rec.path, stepId: rec.stepId, action: rec.action, status: rec.status, durationMs: rec.durationMs, attempts: rec.attempts, urlAfter: rec.urlAfter };
    if (rec.locator?.hit != null) e.locatorHit = rec.locator.hit;
    if (rec.error) e.error = rec.error;
    if (rec.note) e.note = rec.note;
    if (rec.handoffMs) e.handoffMs = rec.handoffMs;
    if (rec.artifacts?.length) e.artifacts = rec.artifacts;
    this.events.emit('step.end', e);
  }
  /** Record a file saved under the run directory (relative path), e.g. a screenshot or a download. */
  artifact(relPath: string, kind: string, step?: number) {
    this.events.emit('artifact', { path: relPath, kind, ...(step != null ? { step } : {}) });
  }
  artifactPath(name: string) {
    return path.join(this.dir, 'artifacts', safeName(name));
  }
  saveState(state: any) {
    writeJson(path.join(this.dir, 'state.json'), state);
  }
  finish(update: any) {
    this.meta = { ...this.meta, ...update, finishedAt: new Date().toISOString() };
    this.meta.durationMs = Date.parse(this.meta.finishedAt) - Date.parse(this.meta.startedAt);
    writeJson(path.join(this.dir, 'run.json'), this.meta);
    const m = this.meta;
    this.events.emit('run.end', { status: m.status, durationMs: m.durationMs, error: m.error ?? null, ...(m.outputCount != null ? { outputCount: m.outputCount } : {}), output: 'output.json' });
    this.pointLatest();
  }
  writeOutput(output: any) {
    writeJson(path.join(this.dir, 'output.json'), output ?? null);
  }
  failureDir() {
    return ensureDir(path.join(this.dir, 'failure'));
  }
}

export function readSteps(runDir: string): StepRecord[] {
  const f = path.join(runDir, 'steps.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function listRuns(limit = 20, filterTemplate?: string): any[] {
  const root = dirs.runs();
  if (!fs.existsSync(root)) return [];
  const names = fs.readdirSync(root).filter((n) => !n.startsWith('_')).sort().reverse();
  const out: any[] = [];
  for (const n of names) {
    const f = path.join(root, n, 'run.json');
    if (!fs.existsSync(f)) continue;
    try {
      const r = readJson(f);
      if (filterTemplate && r.templateId !== filterTemplate) continue;
      out.push({ runDir: path.join(root, n), templateId: r.templateId, version: r.templateVersion, status: r.status, profile: r.profile, startedAt: r.startedAt, durationMs: r.durationMs, error: r.error?.code });
      if (out.length >= limit) break;
    } catch {}
  }
  return out;
}

/** The record of this step from the most recent successful run of the same template. */
export function lastSuccessFor(templateId: string, stepId: string, excludeDir?: string): { runDir: string; record: StepRecord } | null {
  const runs = listRuns(50, templateId);
  for (const r of runs) {
    if (r.runDir === excludeDir) continue;
    const rec = readSteps(r.runDir).reverse().find((s) => s.stepId === stepId && s.status === 'ok');
    if (rec) return { runDir: r.runDir, record: rec };
  }
  return null;
}

/** How often each step's locator needed a fallback candidate in recent runs: early warning of site changes. */
export function locatorDrift(templateId: string, n = 10) {
  const stats: Record<string, { runs: number; fallbackHits: number; lastHit: number | null }> = {};
  for (const r of listRuns(n, templateId)) {
    for (const s of readSteps(r.runDir)) {
      if (!s.locator || s.locator.hit == null) continue;
      const st = (stats[s.stepId] ??= { runs: 0, fallbackHits: 0, lastHit: null });
      st.runs++;
      if (s.locator.hit > 0) st.fallbackHits++;
      st.lastHit = s.locator.hit;
    }
  }
  return stats;
}
