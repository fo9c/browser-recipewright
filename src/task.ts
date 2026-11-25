/**
 * Tasks: one record for everything the agent does while working on one job.
 *
 * When the agent works live (no saved flow yet) it mixes recipe runs, ad-hoc `act` steps, answers to breakpoints
 * and its own decisions. A task ties them together: `task start <name>` makes it current, and from then on every
 * `act`, `run` and `answer` adds a line to tasks/<name>/journal.jsonl (with a link to its run directory), and
 * `task note` records a decision the agent made. Two uses:
 *  - a viewer can show the whole job, not just one recipe run;
 *  - `task draft` turns the journal into a recipe or flow draft, so work done by hand once or twice becomes a
 *    recipe: act steps become recipe steps, recipe runs become `recipe` calls, decisions become `ask` breakpoints.
 * A task can also set a rhythm: a random pause between fragments, so a live session does not move at machine speed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs, readJson, writeJson, safeName, RpaError, pickMs, sleep, log } from './util.js';
import { validateTemplate } from './validate.js';
import { checkRecipeCalls } from './flow.js';

export interface TaskInfo {
  name: string;
  startedAt: string;
  endedAt?: string;
  /** random pause between fragments (act / run / answer), e.g. [2000, 6000] */
  gapMs?: number | [number, number];
  note?: string;
}

export interface JournalEntry {
  seq: number;
  t: string;
  /** act: one ad-hoc step · run: a recipe run · answer: an answer to a breakpoint · decision: the agent's own note */
  type: 'act' | 'run' | 'answer' | 'decision';
  [k: string]: any;
}

const taskDir = (name: string) => path.join(dirs.tasks(), safeName(name.replace(/\//g, '-')));
const currentFile = () => path.join(dirs.tasks(), '_current.json');

export function startTask(name: string, opts: { gapMs?: number | [number, number]; note?: string } = {}): TaskInfo {
  if (!name.trim()) throw new RpaError('INPUT_INVALID', 'give the task a name');
  const dir = taskDir(name);
  const f = path.join(dir, 'task.json');
  const info: TaskInfo = fs.existsSync(f) ? { ...readJson<TaskInfo>(f), endedAt: undefined } : { name, startedAt: new Date().toISOString() };
  if (opts.gapMs !== undefined) info.gapMs = opts.gapMs;
  if (opts.note) info.note = opts.note;
  writeJson(f, info);
  if (!fs.existsSync(path.join(dir, 'journal.jsonl'))) fs.writeFileSync(path.join(dir, 'journal.jsonl'), '');
  writeJson(currentFile(), { name });
  return info;
}

export function currentTask(): TaskInfo | null {
  if (process.env.BROWSER_RECIPEWRIGHT_NO_TASK) return null;
  try {
    const { name } = readJson(currentFile());
    return readJson<TaskInfo>(path.join(taskDir(name), 'task.json'));
  } catch {
    return null;
  }
}

export function endTask(): TaskInfo | null {
  const t = currentTask();
  if (!t) return null;
  t.endedAt = new Date().toISOString();
  writeJson(path.join(taskDir(t.name), 'task.json'), t);
  fs.rmSync(currentFile(), { force: true });
  return t;
}

export function readJournal(name: string): JournalEntry[] {
  const f = path.join(taskDir(name), 'journal.jsonl');
  if (!fs.existsSync(f)) throw new RpaError('INPUT_INVALID', `no task "${name}" (see: browser-recipewright task list)`);
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function listTasks(): (TaskInfo & { entries: number; current: boolean })[] {
  if (!fs.existsSync(dirs.tasks())) return [];
  const cur = currentTask()?.name;
  const out: any[] = [];
  for (const n of fs.readdirSync(dirs.tasks())) {
    const f = path.join(dirs.tasks(), n, 'task.json');
    if (!fs.existsSync(f)) continue;
    const t = readJson<TaskInfo>(f);
    out.push({ ...t, entries: readJournal(t.name).length, current: t.name === cur });
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** Add a line to the current task's journal (no-op without a current task). Never throws. */
export function journal(entry: Omit<JournalEntry, 'seq' | 't'>): JournalEntry | null {
  const t = currentTask();
  if (!t) return null;
  try {
    const prev = readJournal(t.name);
    const e = { seq: (prev[prev.length - 1]?.seq ?? 0) + 1, t: new Date().toISOString(), ...entry } as JournalEntry;
    fs.appendFileSync(path.join(taskDir(t.name), 'journal.jsonl'), JSON.stringify(e) + '\n');
    return e;
  } catch {
    return null;
  }
}

/** Task rhythm: wait so that fragments are at least a random gap apart. */
export async function taskRhythm(): Promise<number> {
  const t = currentTask();
  if (!t?.gapMs) return 0;
  let last: JournalEntry | undefined;
  try {
    last = readJournal(t.name).filter((e) => e.type !== 'decision').pop();
  } catch {}
  if (!last) return 0;
  const want = pickMs(t.gapMs, 0);
  const since = Date.now() - Date.parse(last.endedAt ?? last.t);
  const wait = Math.max(0, want - since);
  if (wait > 0) {
    if (wait >= 200) log.info(`… task rhythm: pausing ${(wait / 1000).toFixed(1)}s before the next step`);
    await sleep(wait);
  }
  return wait;
}

export interface DraftOptions {
  from?: number;
  to?: number;
  id?: string;
  title?: string;
  /** literal values to turn into inputs: { keyword: "AI agent" } → {{inputs.keyword}} */
  params?: Record<string, string>;
}

/**
 * Turn journal entries into a recipe (only act steps) or a flow (recipe runs and decisions too).
 * The draft is a starting point: the agent reviews it, fixes what validate reports, and saves it.
 */
export function draftFromJournal(name: string, opts: DraftOptions = {}) {
  const entries = readJournal(name).filter((e) => (opts.from == null || e.seq >= opts.from) && (opts.to == null || e.seq <= opts.to));
  const steps: any[] = [];
  const sites = new Set<string>();
  const inputs: Record<string, any> = {};
  const used = new Set<string>();
  const uid = (base: string) => {
    let id = base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[^a-zA-Z]+/, '') || 'step';
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  const host = (u: any) => {
    try {
      if (typeof u === 'string' && /^https?:/.test(u)) sites.add(new URL(u).hostname);
    } catch {}
  };
  const skipped: { seq: number; why: string }[] = [];
  for (const e of entries) {
    if (e.type === 'act') {
      if (e.status !== 'success') { skipped.push({ seq: e.seq, why: `act ${e.step?.action} did not succeed` }); continue; }
      const st: any = { ...e.step };
      delete st.screenshot;
      if (st.saveAs === '_act_out' || st.saveAs === undefined) delete st.saveAs;
      st.id = uid(`${st.action}-${e.seq}`);
      if (['read', 'queryAll', 'collect', 'select', 'check', 'download', 'runScript'].includes(st.action)) st.saveAs = `out${e.seq}`;
      if (!st.note) st.note = `from task ${name}, entry ${e.seq}`;
      host(st.url);
      host(e.urlBefore);
      host(e.urlAfter);
      // describe the page the step landed on, so the draft has something to put in "expect"
      if ((st.action === 'goto' || st.action === 'click') && !st.expect && e.urlAfter && e.urlAfter !== e.urlBefore) {
        try {
          st.expect = { urlContains: new URL(e.urlAfter).pathname };
        } catch {}
      }
      steps.push(st);
    } else if (e.type === 'run') {
      if (!e.templateId || e.templateId === '_act') continue;
      const ref = e.templatePath && fs.existsSync(e.templatePath) ? e.templatePath : e.templateId;
      const st: any = { id: uid(`run-${String(e.templateId).split('/').pop()}`), action: 'recipe', recipe: ref, saveAs: `result${e.seq}` };
      const ins = { ...(e.inputs || {}) };
      for (const [k, v] of Object.entries(ins)) if (v === '***') { ins[k] = `{{inputs.${k}}}`; inputs[k] = { type: 'string', secret: true }; }
      if (Object.keys(ins).length) st.inputs = ins;
      for (const s of e.site || []) sites.add(String(s).replace(/^\*\./, ''));
      steps.push(st);
    } else if (e.type === 'decision') {
      steps.push({ id: uid(`decide-${e.seq}`), action: 'ask', question: e.text, ...(e.data !== undefined ? { data: e.data } : {}), answer: { type: 'text' }, saveAs: `decision${e.seq}`, note: 'a judgment you made by hand: turn it into a pick / choice / boolean question on the data it is about' });
    }
  }
  if (!steps.length) throw new RpaError('INPUT_INVALID', `task "${name}" has no usable entries${opts.from != null || opts.to != null ? ' in that range' : ''} (only successful act steps, recipe runs and notes become steps)`);
  // parameterize: replace literal values by input references
  let body = JSON.stringify(steps);
  for (const [k, v] of Object.entries(opts.params || {})) {
    if (!v) continue;
    const enc = encodeURIComponent(v);
    const esc = (x: string) => JSON.stringify(x).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let hit = false;
    if (enc !== v && body.includes(JSON.stringify(enc).slice(1, -1))) { body = body.replace(new RegExp(esc(enc), 'g'), `{{inputs.${k} | urlencode}}`); hit = true; }
    if (body.includes(JSON.stringify(v).slice(1, -1))) { body = body.replace(new RegExp(esc(v), 'g'), `{{inputs.${k}}}`); hit = true; }
    if (!hit) throw new RpaError('INPUT_INVALID', `--param ${k}: the value "${v}" does not appear in the selected entries`);
    inputs[k] = { type: 'string', default: v };
  }
  const finalSteps = JSON.parse(body);
  const isFlow = finalSteps.some((s: any) => s.action === 'recipe' || s.action === 'ask');
  const tpl: any = {
    id: opts.id || `draft/${safeName(name)}`,
    version: '0.1.0',
    title: opts.title || `Draft from task "${name}"`,
    description: `Generated by "browser-recipewright task draft" from ${entries.length} journal entr${entries.length === 1 ? 'y' : 'ies'}. Review it: give steps clear ids and notes, add expect / startOn, turn fixed values into inputs, then validate and save.`,
    kind: isFlow ? 'flow' : 'recipe',
    site: sites.size ? [...sites] : ['example.com'],
    ...(Object.keys(inputs).length ? { inputs } : {}),
    defaults: { timeoutMs: 15000, stepGapMs: [400, 1200], humanize: true },
    steps: finalSteps,
    provenance: { fromTask: name, entries: entries.map((e) => e.seq), createdAt: new Date().toISOString(), skipped },
  };
  const v = validateTemplate(tpl);
  for (const i of checkRecipeCalls(tpl, undefined)) (i.level === 'error' ? v.errors : v.warnings).push(i);
  v.ok = v.errors.length === 0;
  return { template: tpl, validation: v, skipped };
}

export { taskDir };
