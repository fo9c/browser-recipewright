/**
 * Multi-account batch: accounts × template × per-account params, with spacing, run/item caps per site+account,
 * login-health handling, per-account run records, one merged result table, resume, and optionally several
 * browsers at once (one per profile).
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
 *   "dailyCapPerAccount": 5,                          // = caps.runsPerDay
 *   "caps": { "runsPerDay": 5, "runsPerHour": 2, "itemsPerDay": 200, "itemsPerHour": 60 },  // per site+account; accounts[].caps override
 *   "capInput": "count",                              // optional: lower this input so a run never goes past the item caps
 *   "parallel": 1,                                    // browsers at once (1-8), never two for the same profile
 *   "dialogs": "dismiss" | "accept",
 *   "onLoginRequired": "skip" | "handoff",
 *   "onChallenge": "stop" | "skip",
 *   "onAsk": "default" | "fail",                      // ask steps (breakpoints): use their default answer (default), or fail the job
 *   "headless": false
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs, ensureDir, readJson, writeJson, safeName, timestampId, pickMs, sleep, log, RecipeError } from './util.js';
import { checkCaps, usageOf, type Caps } from './usage.js';
import { loadTemplate } from './library.js';
import { Runner } from './engine.js';
import { siteKey } from './browser.js';

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

/** Today's runs for a profile (site/account). Kept for callers of the old per-account counter. */
export function usageToday(profile: string): number {
  return usageOf(profile).runsToday;
}

/** Caps for one account: batch "caps" (dailyCapPerAccount = caps.runsPerDay) overridden by the account's own "caps". */
export function capsFor(spec: any, account: any): Caps {
  const c: Caps = { ...(spec.dailyCapPerAccount ? { runsPerDay: spec.dailyCapPerAccount } : {}), ...(spec.caps || {}), ...(account.caps || {}) };
  for (const [k, v] of Object.entries(c)) if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0)) throw new RecipeError('BATCH_INVALID', `caps.${k} must be a whole number ≥ 0`);
  return c;
}

function readResults(dir: string): any[] {
  const f = path.join(dir, 'results.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function runBatch(opts: { file?: string; resumeDir?: string; retryFailed?: boolean; dryRun?: boolean; headless?: boolean; parallel?: number }) {
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
  spec._site = siteKey(loaded.template.site?.[0]) || 'default';
  const jobs: Job[] = spec._jobs || planJobs(spec, spec._baseDir);
  spec._jobs = jobs;
  const parallel = Number(opts.parallel ?? spec.parallel ?? 1);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new RecipeError('BATCH_INVALID', 'parallel must be a whole number from 1 to 8');
  for (const j of jobs) capsFor(spec, j.account); // fail early on bad caps
  if (spec.capInput && !(spec.capInput in (loaded.template.inputs || {}))) throw new RecipeError('BATCH_INVALID', `capInput "${spec.capInput}" is not an input of ${loaded.template.id}`);
  writeJson(path.join(dir, 'batch.json'), spec);
  if (opts.dryRun) return { batchDir: dir, jobs, parallel, dryRun: true };

  const prev = readResults(dir);
  const done = new Map<string, any>();
  for (const r of prev) done.set(r.key, r);
  const resultsFile = path.join(dir, 'results.jsonl');
  const headless = opts.headless ?? spec.headless ?? false;
  const append = (r: any) => fs.appendFileSync(resultsFile, JSON.stringify(r) + '\n');
  let stopped: string | null = null;
  log.info(`▶ batch ${dir}  jobs=${jobs.length}  template=${loaded.template.id}${parallel > 1 ? `  parallel=${parallel}` : ''}`);

  const todo = jobs.filter((job) => {
    const p = done.get(job.key);
    if (p && (p.status !== 'failed' || !opts.retryFailed) && p.status !== 'paused') {
      log.info(`  ↷ ${job.key} already ${p.status}, skipping`);
      return false;
    }
    return true;
  });

  const runJob = async (job: Job, inputs: Record<string, any>) => {
    const tag = parallel > 1 ? `[${job.account.id}] ` : '';
    log.info(`\n=== ${tag}job ${job.key} (profile ${job.account.profile}) ===`);
    try {
      const runner = new Runner({
        loaded, inputs, profile: job.account.profile, account: job.account, headless,
        handoff: spec.onLoginRequired === 'handoff' ? 'auto' : 'never', forceClose: true,
        // a batch runs unattended: breakpoints take their default answer instead of stopping every job
        onAsk: spec.onAsk === 'fail' ? 'fail' : 'default',
        dialogs: spec.dialogs === 'accept' || spec.dialogs === 'dismiss' ? spec.dialogs : undefined,
      });
      const res = await runner.run();
      let status = res.status as string;
      if (res.error?.code === 'LOGIN_REQUIRED') status = 'skipped_login';
      else if (res.error?.code === 'CHALLENGE_DETECTED') status = spec.onChallenge === 'skip' ? 'skipped_challenge' : 'paused';
      return { key: job.key, account: job.account.id, profile: job.account.profile, status, runDir: res.runDir, error: res.error ?? null, outputCount: Array.isArray(res.output) ? res.output.length : null, at: new Date().toISOString() };
    } catch (e: any) {
      return { key: job.key, account: job.account.id, profile: job.account.profile, status: 'failed', runDir: null, error: { code: e.code || 'ERROR', message: e.message }, at: new Date().toISOString() };
    }
  };

  // Scheduler. Up to `parallel` browsers at once, each with its own profile; one profile never runs two jobs at
  // the same time (Chrome cannot open one user-data-dir twice, and one account doing two things at once is not
  // human). Starts are spaced by spacingMs: after the previous job ended when sequential, after the previous
  // start when parallel, so browsers never all start in the same second.
  const running = new Set<Promise<void>>();
  const busy = new Set<string>();
  let started = 0;
  while (todo.length || running.size) {
    const idx = !stopped && running.size < parallel ? todo.findIndex((j) => !busy.has(j.account.profile)) : -1;
    if (idx === -1) {
      if (!running.size) break;
      await Promise.race(running);
      continue;
    }
    const job = todo.splice(idx, 1)[0];
    const caps = capsFor(spec, job.account);
    const capOk = checkCaps(job.account.profile, caps);
    if (!capOk.ok || capOk.itemsLeft === 0) {
      append({ key: job.key, account: job.account.id, profile: job.account.profile, status: 'skipped_cap', at: new Date().toISOString(), message: capOk.reason ?? 'item cap reached' });
      log.info(`  ⏸ ${job.key} skipped: ${capOk.reason ?? 'item cap reached'}`);
      continue;
    }
    const inputs = { ...job.inputs };
    if (spec.capInput && capOk.itemsLeft !== undefined) {
      const want = Number(inputs[spec.capInput] ?? loaded.template.inputs?.[spec.capInput]?.default ?? Infinity);
      if (!(want <= capOk.itemsLeft)) {
        inputs[spec.capInput] = capOk.itemsLeft;
        log.info(`  ✂ ${job.key}: ${spec.capInput} lowered to ${capOk.itemsLeft} (item cap)`);
      }
    }
    if (started > 0) {
      const wait = pickMs(spec.spacingMs, 0);
      if (wait) {
        log.info(`  … waiting ${Math.round(wait / 1000)}s before the next ${parallel > 1 ? 'browser starts' : 'account'}`);
        await sleep(wait);
      }
      if (stopped) { todo.unshift(job); continue; }
    }
    started++;
    busy.add(job.account.profile);
    const p: Promise<void> = runJob(job, inputs).then((result) => {
      append(result);
      if (result.status === 'paused' && !stopped) stopped = `challenge on account ${job.account.id}; batch paused. Fix it in the browser, then: browser-recipewright batch --resume "${dir}"`;
    }).finally(() => {
      busy.delete(job.account.profile);
      running.delete(p);
    });
    running.add(p);
    // sequential: wait for this job before spacing the next one
    if (parallel === 1) await p;
  }
  return { batchDir: dir, ...writeSummary(dir, jobs), stopped };
}

/**
 * One table with every account's results: each output item becomes a row, tagged with the job, account and
 * profile it came from. Array outputs give one row per item; any other output gives one row ({ value } unless it
 * is an object). Written as merged.json and merged.csv (columns: _job, _account, _profile, then the union of the
 * item fields; nested values as JSON).
 */
export function writeMerged(dir: string, rows: any[]) {
  const merged: any[] = [];
  for (const r of rows) {
    if (r.status !== 'success' || !r.runDir) continue;
    const f = path.join(r.runDir, 'output.json');
    if (!fs.existsSync(f)) continue;
    let out: any;
    try { out = readJson(f); } catch { continue; }
    const items = Array.isArray(out) ? out : out == null ? [] : [out];
    for (const it of items) merged.push({ _job: r.key, _account: r.account, _profile: r.profile, ...(it && typeof it === 'object' && !Array.isArray(it) ? it : { value: it }) });
  }
  writeJson(path.join(dir, 'merged.json'), merged);
  const cols: string[] = ['_job', '_account', '_profile'];
  for (const m of merged) for (const k of Object.keys(m)) if (!cols.includes(k)) cols.push(k);
  fs.writeFileSync(path.join(dir, 'merged.csv'), '﻿' + [cols.join(','), ...merged.map((m) => cols.map((c) => csvCell(m[c])).join(','))].join('\n') + '\n');
  const byAccount: Record<string, number> = {};
  for (const m of merged) byAccount[m._account] = (byAccount[m._account] || 0) + 1;
  return { rows: merged.length, byAccount, json: path.join(dir, 'merged.json'), csv: path.join(dir, 'merged.csv') };
}

export function writeSummary(dir: string, jobs: Job[]) {
  const latest = new Map<string, any>();
  for (const r of readResults(dir)) latest.set(r.key, r);
  const rows = jobs.map((j) => latest.get(j.key) || { key: j.key, account: j.account.id, profile: j.account.profile, status: 'pending' });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const merged = writeMerged(dir, rows);
  const summary = { total: jobs.length, counts, loginExpired: rows.filter((r) => r.status === 'skipped_login').map((r) => r.account), merged, rows };
  writeJson(path.join(dir, 'summary.json'), summary);
  const cols = ['key', 'account', 'profile', 'status', 'outputCount', 'runDir', 'error', 'at'];
  fs.writeFileSync(path.join(dir, 'summary.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(c === 'error' ? r.error?.code : r[c])).join(','))].join('\n') + '\n');
  return summary;
}
