/**
 * Run data format v1: the event stream every run writes to runs/<id>/events.jsonl.
 *
 * This is the one contract between the executor and any viewer plugin. Plugins are separate programs that
 * only READ these files; the executor never depends on a plugin being present. See docs/run-data-format.md.
 *
 * Rules the writer keeps (and readers may rely on):
 *  - one JSON object per line, appended in order, each line ends with "\n";
 *  - every event has the envelope { v, seq, t, ms, type } (seq starts at 1 and has no gaps);
 *  - the first event is "run.start", the last one (if the process was not killed) is "run.end";
 *  - a run that stops at a breakpoint ends with "run.pause" instead; when the agent answers, the same file
 *    continues with "run.resume" (seq and ms carry on), and the run later ends with "run.end" as usual;
 *  - new event types and new fields may be added within v1: readers must ignore what they do not know.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const RUN_FORMAT = 'recipewright.run';
export const RUN_FORMAT_VERSION = 1;
export const EVENTS_FILE = 'events.jsonl';

export interface RunEvent {
  v: number;
  seq: number;
  t: string;
  ms: number;
  type: string;
  [k: string]: any;
}

export type EventListener = (e: RunEvent) => void;

/** Process-wide listeners: the in-process hook a future live viewer (e.g. a local SSE server) can attach to. */
const globalListeners = new Set<EventListener>();
export function onRunEvent(fn: EventListener): () => void {
  globalListeners.add(fn);
  return () => globalListeners.delete(fn);
}

/** Appends events to events.jsonl. Never throws: a viewer problem must never break a run. */
export class RunEvents {
  readonly file: string;
  private seq = 0;
  private t0 = Date.now();
  private listeners = new Set<EventListener>();
  private broken = false;
  constructor(runDir: string, opts: { append?: boolean } = {}) {
    this.file = path.join(runDir, EVENTS_FILE);
    try {
      if (opts.append && fs.existsSync(this.file)) {
        // continuing a paused run: keep numbering and the time origin of the existing stream
        const prev = readEvents(runDir);
        const last = prev[prev.length - 1];
        if (last) {
          this.seq = last.seq;
          this.t0 = Date.parse(prev[0].t);
        }
      } else fs.writeFileSync(this.file, '');
    } catch {
      this.broken = true;
    }
  }
  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(type: string, data: Record<string, any> = {}): RunEvent {
    const now = Date.now();
    if (this.seq === 0) this.t0 = now;
    const e: RunEvent = { v: RUN_FORMAT_VERSION, seq: ++this.seq, t: new Date(now).toISOString(), ms: now - this.t0, type, ...stripEnvelope(data) };
    if (!this.broken) {
      try {
        fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
      } catch {
        this.broken = true;
      }
    }
    for (const fn of [...this.listeners, ...globalListeners]) {
      try {
        fn(e);
      } catch {}
    }
    return e;
  }
}

function stripEnvelope(d: Record<string, any>) {
  const { v, seq, t, ms, type, ...rest } = d;
  return rest;
}

/** A short, JSON-safe preview of extracted data for "data" events (the full data stays in output.json). */
export function preview(value: any, maxItems = 3, maxChars = 400): any {
  const one = (x: any) => {
    const s = JSON.stringify(x ?? null);
    if (s.length <= maxChars) return x ?? null;
    return { _truncated: s.slice(0, maxChars) };
  };
  if (Array.isArray(value)) return value.slice(-maxItems).map(one);
  return one(value);
}

/** A compact outline of the template's steps, so a viewer can draw the whole recipe before it runs. */
export function stepOutline(steps: any[], prefix = ''): any[] {
  return (steps || []).map((s) => {
    const p = prefix ? `${prefix}.${s.id}` : s.id;
    const node: any = { id: s.id, path: p, action: s.action };
    if (s.description) node.description = s.description;
    if (s.optional) node.optional = true;
    if (s.action === 'recipe') node.recipe = s.recipe;
    if (s.action === 'forEach' || s.action === 'while') node.loop = true;
    const kids: Record<string, any[]> = {};
    for (const k of ['steps', 'do', 'then', 'else']) if (Array.isArray(s[k])) kids[k] = stepOutline(s[k], s.action === 'forEach' || s.action === 'while' ? `${p}[*]` : p);
    if (Object.keys(kids).length) node.children = kids;
    return node;
  });
}

// ---------------- reading & checking (for plugins, tests and `check-run`) ----------------

/** Read events.jsonl. A last line without "\n" is still being written and is skipped. */
export function readEvents(runDir: string): RunEvent[] {
  const f = path.join(runDir, EVENTS_FILE);
  if (!fs.existsSync(f)) return [];
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');
  lines.pop(); // "" after the final newline, or an unfinished line
  return lines.filter(Boolean).map((l) => JSON.parse(l));
}

const ISO = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'ISO date-time');
const Envelope = z.looseObject({
  v: z.literal(RUN_FORMAT_VERSION),
  seq: z.number().int().min(1),
  t: ISO,
  ms: z.number().int().min(0),
  type: z.string().regex(/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)*$/),
});
const Err = z.looseObject({ code: z.string(), message: z.string() });
const StepStatus = z.enum(['ok', 'failed', 'soft-failed', 'skipped', 'paused']);

/** Payload schemas of the event types defined in v1. Unknown types are allowed (forward compatible). */
export const EVENT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'run.start': z.looseObject({ runId: z.string(), templateId: z.string(), templateVersion: z.string(), steps: z.array(z.any()) }),
  'run.end': z.looseObject({ status: z.enum(['success', 'failed']), durationMs: z.number(), error: Err.nullable().optional() }),
  'step.start': z.looseObject({ step: z.number().int(), path: z.string(), stepId: z.string(), action: z.string() }),
  'step.retry': z.looseObject({ step: z.number().int(), path: z.string(), attempt: z.number().int(), error: Err }),
  'step.end': z.looseObject({ step: z.number().int(), path: z.string(), stepId: z.string(), action: z.string(), status: StepStatus, durationMs: z.number() }),
  'loop.iteration': z.looseObject({ path: z.string(), index: z.number().int().min(0) }),
  data: z.looseObject({ path: z.string(), mode: z.enum(['save', 'append', 'collect']), added: z.number().int().min(0) }),
  'page.navigated': z.looseObject({ url: z.string() }),
  'page.viewport': z.looseObject({ width: z.number(), height: z.number() }),
  'pointer.move': z.looseObject({ x: z.number(), y: z.number() }),
  'pointer.click': z.looseObject({ x: z.number(), y: z.number() }),
  'pointer.wheel': z.looseObject({ dy: z.number() }),
  'key.type': z.looseObject({ chars: z.number().int().min(0) }),
  'handoff.start': z.looseObject({ reason: z.string(), code: z.string() }),
  'handoff.end': z.looseObject({ waitedMs: z.number(), resolved: z.boolean() }),
  artifact: z.looseObject({ path: z.string(), kind: z.string() }),
  // breakpoints (added in v1, additive): the agent decides something in the middle of a run
  'ask.start': z.looseObject({ step: z.number().int(), path: z.string(), stepId: z.string(), question: z.string(), answerType: z.string() }),
  'ask.answered': z.looseObject({ step: z.number().int(), path: z.string(), stepId: z.string(), source: z.enum(['agent', 'default']) }),
  'run.pause': z.looseObject({ path: z.string(), stepId: z.string(), reason: z.literal('ask') }),
  'run.resume': z.looseObject({ path: z.string() }),
  // fragments: a recipe step runs another recipe inside this run; its steps follow with paths "<path>.<stepId>"
  'recipe.enter': z.looseObject({ path: z.string(), recipeId: z.string(), recipeVersion: z.string() }),
};

export interface RunCheck {
  ok: boolean;
  format: string | null;
  events: number;
  finished: boolean;
  errors: string[];
  warnings: string[];
}

/** Check a run directory against the run data format. Used by `browser-recipewright check-run` and tests. */
export function checkRunDir(runDir: string): RunCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const res = (format: string | null, events: number, finished: boolean): RunCheck => ({ ok: errors.length === 0, format, events, finished, errors, warnings });
  const runFile = path.join(runDir, 'run.json');
  if (!fs.existsSync(runFile)) {
    errors.push('run.json is missing (not a run directory)');
    return res(null, 0, false);
  }
  let run: any;
  try {
    run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  } catch (e: any) {
    errors.push(`run.json is not valid JSON: ${e.message}`);
    return res(null, 0, false);
  }
  const format = run.format ? `${run.format.name}/${run.format.version}` : null;
  if (!run.format) {
    warnings.push('run.json has no "format": a run from before v1. Readers should fall back to steps.jsonl.');
    return res(null, 0, run.status !== 'running');
  }
  if (run.format.name !== RUN_FORMAT) errors.push(`run.json format.name is "${run.format.name}", expected "${RUN_FORMAT}"`);
  if (run.format.version !== RUN_FORMAT_VERSION) warnings.push(`run.json format.version is ${run.format.version}; this checker knows v${RUN_FORMAT_VERSION}`);
  for (const k of ['runId', 'templateId', 'status', 'startedAt']) if (run[k] == null) errors.push(`run.json: "${k}" is missing`);
  if (!fs.existsSync(path.join(runDir, 'steps.jsonl'))) errors.push('steps.jsonl is missing');

  let events: RunEvent[] = [];
  try {
    events = readEvents(runDir);
  } catch (e: any) {
    errors.push(`events.jsonl has a line that is not JSON: ${e.message}`);
    return res(format, 0, false);
  }
  if (!events.length) errors.push('events.jsonl is missing or empty');
  const openSteps = new Map<number, string>();
  events.forEach((e, i) => {
    const where = `events.jsonl line ${i + 1}`;
    const env = Envelope.safeParse(e);
    if (!env.success) {
      errors.push(`${where}: ${env.error.issues.map((x) => `${x.path.join('.') || '(root)'} ${x.message}`).join('; ')}`);
      return;
    }
    if (e.seq !== i + 1) errors.push(`${where}: seq is ${e.seq}, expected ${i + 1}`);
    if (i > 0 && e.ms < events[i - 1].ms) errors.push(`${where}: ms goes backwards`);
    const sch = EVENT_SCHEMAS[e.type];
    if (sch) {
      const p = sch.safeParse(e);
      if (!p.success) errors.push(`${where} (${e.type}): ${p.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
    }
    if (e.type === 'step.start') openSteps.set(e.step, e.path);
    if (e.type === 'step.end') {
      if (!openSteps.has(e.step) && e.stepId !== '_login-check') warnings.push(`${where}: step.end for step ${e.step} without a step.start`);
      openSteps.delete(e.step);
    }
  });
  if (events.length && events[0].type !== 'run.start') errors.push('the first event must be "run.start"');
  const finished = events.length > 0 && events[events.length - 1].type === 'run.end';
  const paused = events.length > 0 && events[events.length - 1].type === 'run.pause';
  if (run.status === 'paused' && !paused) warnings.push('run.json says "paused" but the last event is not "run.pause"');
  if (!finished && !paused && run.status !== 'running') warnings.push('no "run.end" event: the process was probably killed');
  if ((finished || paused) && openSteps.size) warnings.push(`${openSteps.size} step(s) started but never ended: ${[...openSteps.values()].slice(0, 5).join(', ')}`);
  return res(format, events.length, finished);
}

/** JSON Schema of one events.jsonl line, for plugins written in other languages (schema/run-events.v1.json). */
export function buildRunEventsJsonSchema(): any {
  const conv = (sch: z.ZodTypeAny) => {
    const j = z.toJSONSchema(sch, { unrepresentable: 'any', io: 'input' }) as any;
    delete j.$schema;
    return j;
  };
  const known = Object.keys(EVENT_SCHEMAS);
  const defs: Record<string, any> = { envelope: conv(Envelope) };
  for (const [type, sch] of Object.entries(EVENT_SCHEMAS)) defs[type] = { ...conv(sch), properties: { ...conv(sch).properties, type: { const: type } } };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://raw.githubusercontent.com/fo9c/browser-recipewright/main/schema/run-events.v1.json',
    title: `browser-recipewright run event (${RUN_FORMAT} v${RUN_FORMAT_VERSION}), one line of events.jsonl`,
    description: 'Every line matches the envelope. Lines whose "type" is listed also match that type. Unknown types and extra fields are allowed: ignore them.',
    allOf: [
      { $ref: '#/$defs/envelope' },
      ...known.map((t) => ({ if: { properties: { type: { const: t } }, required: ['type'] }, then: { $ref: `#/$defs/${t}` } })),
    ],
    $defs: defs,
  };
}
