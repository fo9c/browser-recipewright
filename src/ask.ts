/**
 * Breakpoints: the `ask` step.
 *
 * A recipe stops at an `ask` step, leaves the browser on the page and hands a question (plus data) to the
 * agent that called it. The executor never calls a model itself: the agent that is already driving the tool
 * reads the question, decides, and answers with `browser-recipewright answer`. The run then continues from
 * exactly that step, in the same run directory.
 *
 * This module holds the parts that do not need a browser: answer formats, checking and converting an answer,
 * and the files a paused run leaves behind (ask.json, state.json answers).
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkSchema } from './jsonschema.js';
import { RpaError, readJson, writeJson, dirs } from './util.js';

export const ANSWER_TYPES = ['text', 'number', 'boolean', 'choice', 'pick', 'json'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export interface AnswerSpec {
  type?: AnswerType;
  /** choice: the allowed values */
  options?: any[];
  /** pick: how many items may be picked */
  min?: number;
  max?: number;
  /** json: JSON Schema subset the answer must match */
  schema?: any;
  /** one line telling the agent how to answer, shown with the question */
  hint?: string;
}

export const ASK_FILE = 'ask.json';

/** What a paused run asks; written to <runDir>/ask.json and printed by `run` / `pending`. */
export interface PendingAsk {
  runDir: string;
  templateId: string;
  templatePath: string;
  stepId: string;
  path: string;
  question: string;
  answer: AnswerSpec & { type: AnswerType };
  data: any;
  default?: any;
  url: string | null;
  since: string;
  /** plain instructions for the agent */
  how: string;
}

const TRUE = new Set([true, 'true', 'yes', 'y', '1', 1, '是', '对']);
const FALSE = new Set([false, 'false', 'no', 'n', '0', 0, '否', '不']);

/**
 * Check an answer against the step's answer format and convert it.
 * `pick` answers are 0-based indexes into the asked data (an array); the stored value is the picked items.
 * Throws ANSWER_INVALID with a message the agent can act on.
 */
export function coerceAnswer(spec: AnswerSpec | undefined, raw: any, data: any): any {
  const type: AnswerType = spec?.type ?? 'text';
  const bad = (msg: string) => new RpaError('ANSWER_INVALID', `answer ${JSON.stringify(raw)} is not valid: ${msg}`);
  switch (type) {
    case 'text':
      if (raw == null) throw bad('expected text');
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (raw === '' || raw == null || !Number.isFinite(n)) throw bad('expected a number');
      return n;
    }
    case 'boolean': {
      const v = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
      if (TRUE.has(v)) return true;
      if (FALSE.has(v)) return false;
      throw bad('expected true or false');
    }
    case 'choice': {
      const opts = spec?.options ?? [];
      const hit = opts.find((o) => o === raw || String(o) === String(raw));
      if (hit === undefined) throw bad(`expected one of ${JSON.stringify(opts)}`);
      return hit;
    }
    case 'pick': {
      if (!Array.isArray(data)) throw bad('this question has no list to pick from (its data is not an array)');
      let idx: any = raw;
      if (typeof idx === 'string') idx = idx.trim() === '' ? [] : idx.split(/[\s,，]+/).filter(Boolean).map(Number);
      if (typeof idx === 'number') idx = [idx];
      if (!Array.isArray(idx)) throw bad('expected a list of item numbers, e.g. [0, 3, 7]');
      const seen = new Set<number>();
      for (const i of idx) {
        if (!Number.isInteger(i) || i < 0 || i >= data.length) throw bad(`item number ${JSON.stringify(i)} is out of range 0..${data.length - 1} (numbers start at 0)`);
        seen.add(i);
      }
      if (spec?.min != null && seen.size < spec.min) throw bad(`pick at least ${spec.min} item(s)`);
      if (spec?.max != null && seen.size > spec.max) throw bad(`pick at most ${spec.max} item(s)`);
      return [...seen].sort((a, b) => a - b).map((i) => data[i]);
    }
    case 'json': {
      if (spec?.schema) {
        const errs = checkSchema(raw, spec.schema);
        if (errs.length) throw bad(errs.join('; '));
      }
      return raw;
    }
  }
  throw bad(`unknown answer type "${type}"`);
}

/** Read --value: JSON if it parses, else the plain text. */
export function parseAnswerValue(v: string): any {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Pending ask of a run directory, or null if the run is not waiting for an answer. */
export function readPendingAsk(runDir: string): PendingAsk | null {
  const f = path.join(runDir, ASK_FILE);
  if (!fs.existsSync(f)) return null;
  try {
    return readJson<PendingAsk>(f);
  } catch {
    return null;
  }
}

/** Store the agent's answer for the pending ask in state.json, after checking it. Returns the converted value. */
export function recordAnswer(runDir: string, raw: any): { ask: PendingAsk; value: any } {
  const ask = readPendingAsk(runDir);
  if (!ask) throw new RpaError('INPUT_INVALID', `${runDir} is not waiting for an answer (no ${ASK_FILE}). See: browser-recipewright pending`);
  const value = coerceAnswer(ask.answer, raw, ask.data);
  const stateFile = path.join(runDir, 'state.json');
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : {};
  state.answers = { ...(state.answers || {}), [ask.path]: raw };
  writeJson(stateFile, state);
  return { ask, value };
}

/** Every run that is paused at a breakpoint, newest first. */
export function listPending(root = dirs.runs()): PendingAsk[] {
  if (!fs.existsSync(root)) return [];
  const out: PendingAsk[] = [];
  for (const n of fs.readdirSync(root).filter((x) => !x.startsWith('_')).sort().reverse()) {
    const dir = path.join(root, n);
    const ask = readPendingAsk(dir);
    if (!ask) continue;
    try {
      if (readJson(path.join(dir, 'run.json')).status !== 'paused') continue;
    } catch {
      continue;
    }
    out.push(ask);
  }
  return out;
}
