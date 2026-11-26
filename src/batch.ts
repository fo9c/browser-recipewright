/**
 * Multi-account batch: accounts × template × per-account params, with spacing, daily caps,
 * login-health handling, per-account run records and resume.
 *
 * batch.json
 * {
 *   "name": "x-daily-read",
 *   "template": "demo/local-feed",
 *   "inputs": { "count": 5 },                         // shared inputs
 *   "accounts": [ { "id": "main", "profile": "demo/main", "inputs": { "keyword": "agent" } } ],
 *   "accountsFile": "accounts.csv",                   // optional: columns id,profile,<input>...
 *   "jobs": [ { "account": "main", "inputs": { "keyword": "RPA" } } ],  // optional explicit job list (account × params)
 *   "jobsFile": "jobs.csv",                           // optional: columns account,<input>...
 *   "spacingMs": [60000, 180000],                     // random wait between jobs
 *   "dailyCapPerAccount": 5,
 *   "onLoginRequired": "skip" | "handoff",
 *   "onChallenge": "stop" | "skip",
 *   "onAsk": "default" | "fail",                      // ask steps (breakpoints): use their default answer (default), or fail the job
 *   "headless": false
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs, ensureDir, readJson, writeJson, safeName, timestampId, todayKey, pickMs, sleep, log, RecipeError } from './util.js';
import { loadTemplate } from './library.js';
import { Runner } from './engine.js';

export interface Job {
  key: string;
  account: { id: string; profile: string; [k: string]: any };
  inputs: Record<string, any>;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  const [head, ...rest] = rows;
  if (!head) return [];
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const csvCell = (v: any) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function planJobs(spec: any, baseDir: string): Job[] {
  const accounts: any[] = [...(spec.accounts || [])];
  if (spec.accountsFile) {
    for (const r of parseCsv(fs.readFileSync(path.resolve(baseDir, spec.accountsFile), 'utf8'))) {
      const { id, profile, ...inputs } = r;
      accounts.push({ id, profile, inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== '')) });
    }
  }
  if (!accounts.length) throw new RecipeError('BATCH_INVALID', 'batch has no accounts');
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const a of accounts) {
    if (!a.id) throw new RecipeError('BATCH_INVALID', 'every account needs an "id"');
    a.profile ||= `${spec._site}/${a.id}`;
  }
  let rawJobs: any[] = [...(spec.jobs || [])];
  if (spec.jobsFile) {
    for (const r of parseCsv(fs.readFileSync(path.resolve(baseDir, spec.jobsFile), 'utf8'))) {
      const { account, ...inputs } = r;
      rawJobs.push({ account, inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== '')) });
    }
  }
  if (!rawJobs.length) rawJobs = accounts.map((a) => ({ account: a.id, inputs: {} }));
  const counts: Record<string, number> = {};
  return rawJobs.map((j) => {
    const a = byId.get(j.account);
    if (!a) throw new RecipeError('BATCH_INVALID', `job references unknown account "${j.account}"`);
    counts[a.id] = (counts[a.id] || 0) + 1;
    const { inputs: accInputs, ...accountInfo } = a;
    return { key: `${a.id}#${counts[a.id]}`, account: accountInfo, inputs: { ...(spec.inputs || {}), ...(accInputs || {}), ...(j.inputs || {}) } };
  });
}

function usageFile(accountId: string) {
  return path.join(dirs.usage(), safeName(accountId) + '.json');
}
export function usageToday(accountId: string): number {
  const f = usageFile(accountId);
  return fs.existsSync(f) ? readJson(f)[todayKey()] || 0 : 0;
}
function addUsage(accountId: string) {
  const f = usageFile(accountId);
  const u = fs.existsSync(f) ? readJson(f) : {};
  u[todayKey()] = (u[todayKey()] || 0) + 1;
  writeJson(f, u);
}

function readResults(dir: string): any[] {
  const f = path.join(dir, 'results.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function runBatch(opts: { file?: string; resumeDir?: string; retryFailed?: boolean; dryRun?: boolean; headless?: boolean }) {
  let dir: string;
  let spec: any;
  if (opts.resumeDir) {
    dir = path.resolve(opts.resumeDir);
    spec = readJson(path.join(dir, 'batch.json'));
  } else {
    const file = path.resolve(opts.file!);
    spec = readJson(file);
    spec._baseDir = path.dirname(file);
    dir = ensureDir(path.join(dirs.batches(), `${timestampId()}_${safeName(spec.name || path.basename(file, '.json'))}`));
  }
  const loaded = loadTemplate(spec.template.startsWith('.') ? path.resolve(spec._baseDir, spec.template) : spec.template);
  spec._site = (loaded.template.site?.[0] || 'default').replace(/^\*\./, '');
  const jobs: Job[] = spec._jobs || planJobs(spec, spec._baseDir);
  spec._jobs = jobs;
  writeJson(path.join(dir, 'batch.json'), spec);
  if (opts.dryRun) return { batchDir: dir, jobs, dryRun: true };

  const prev = readResults(dir);
  const done = new Map<string, any>();
  for (const r of prev) done.set(r.key, r);
  const resultsFile = path.join(dir, 'results.jsonl');
  const headless = opts.headless ?? spec.headless ?? false;
  let stopped: string | null = null;
  let lastRan = false;
  log.info(`▶ batch ${dir}  jobs=${jobs.length}  template=${loaded.template.id}`);

  for (const job of jobs) {
    const p = done.get(job.key);
    if (p && (p.status !== 'failed' || !opts.retryFailed) && p.status !== 'paused') {
      log.info(`  ↷ ${job.key} already ${p.status}, skipping`);
      continue;
    }
    const cap = spec.dailyCapPerAccount;
    if (cap && usageToday(job.account.id) >= cap) {
      const r = { key: job.key, account: job.account.id, status: 'skipped_cap', at: new Date().toISOString(), message: `daily cap ${cap} reached` };
      fs.appendFileSync(resultsFile, JSON.stringify(r) + '\n');
      log.info(`  ⏸ ${job.key} skipped: daily cap reached`);
      continue;
    }
    if (lastRan) {
      const wait = pickMs(spec.spacingMs, 0);
      if (wait) {
        log.info(`  … waiting ${Math.round(wait / 1000)}s before next account`);
        await sleep(wait);
      }
    }
    log.info(`\n=== job ${job.key} (profile ${job.account.profile}) ===`);
    addUsage(job.account.id);
    lastRan = true;
    let result: any;
    try {
      const runner = new Runner({
        loaded, inputs: job.inputs, profile: job.account.profile, account: job.account, headless,
        handoff: spec.onLoginRequired === 'handoff' ? 'auto' : 'never', forceClose: true,
        // a batch runs unattended: breakpoints take their default answer instead of stopping every job
        onAsk: spec.onAsk === 'fail' ? 'fail' : 'default',
      });
      const res = await runner.run();
      let status = res.status as string;
      if (res.error?.code === 'LOGIN_REQUIRED') status = 'skipped_login';
      else if (res.error?.code === 'CHALLENGE_DETECTED') status = spec.onChallenge === 'skip' ? 'skipped_challenge' : 'paused';
      result = { key: job.key, account: job.account.id, profile: job.account.profile, status, runDir: res.runDir, error: res.error ?? null, outputCount: Array.isArray(res.output) ? res.output.length : null, at: new Date().toISOString() };
    } catch (e: any) {
      result = { key: job.key, account: job.account.id, profile: job.account.profile, status: 'failed', runDir: null, error: { code: e.code || 'ERROR', message: e.message }, at: new Date().toISOString() };
    }
    fs.appendFileSync(resultsFile, JSON.stringify(result) + '\n');
    if (result.status === 'paused') {
      stopped = `challenge on account ${job.account.id}; batch paused. Fix it in the browser, then: browser-recipewright batch --resume "${dir}"`;
      break;
    }
  }
  return { batchDir: dir, ...writeSummary(dir, jobs), stopped };
}

export function writeSummary(dir: string, jobs: Job[]) {
  const latest = new Map<string, any>();
  for (const r of readResults(dir)) latest.set(r.key, r);
  const rows = jobs.map((j) => latest.get(j.key) || { key: j.key, account: j.account.id, status: 'pending' });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const summary = { total: jobs.length, counts, loginExpired: rows.filter((r) => r.status === 'skipped_login').map((r) => r.account), rows };
  writeJson(path.join(dir, 'summary.json'), summary);
  const cols = ['key', 'account', 'profile', 'status', 'outputCount', 'runDir', 'error', 'at'];
  fs.writeFileSync(path.join(dir, 'summary.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(c === 'error' ? r.error?.code : r[c])).join(','))].join('\n') + '\n');
  return summary;
}
