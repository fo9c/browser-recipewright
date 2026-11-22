/** Structured conditions: used by expect / if / while / assert / collect.filter / collect.until / loginCheck. */
import { render, Scope } from './render.js';

export interface PageProbe {
  url(): string;
  count(target: any[], visibleOnly: boolean): Promise<number>;
  text(target: any[]): Promise<string | null>;
}

export const CONDITION_KEYS = [
  'exists', 'notExists', 'visible', 'hidden', 'urlContains', 'urlMatches', 'textContains',
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches',
  'and', 'or', 'not', 'countGte', 'countLte', 'countEq', 'truthy', 'empty',
] as const;

export interface CondResult {
  pass: boolean;
  why: string;
}

const num = (v: any) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')));
const len = (v: any) => (Array.isArray(v) ? v.length : v == null ? 0 : typeof v === 'object' ? Object.keys(v).length : String(v).length);
const short = (v: any) => {
  const s = JSON.stringify(v);
  return s && s.length > 60 ? s.slice(0, 57) + '...' : s;
};

export async function evalCond(cond: any, scope: Scope, probe?: PageProbe): Promise<CondResult> {
  if (!cond || typeof cond !== 'object') return { pass: false, why: 'empty condition' };
  const keys = Object.keys(cond);
  if (keys.length !== 1) return { pass: false, why: `condition must have exactly one key, got ${keys.join(',')}` };
  const key = keys[0];
  const raw = cond[key];
  const needPage = () => {
    if (!probe) throw new Error(`condition "${key}" needs a page`);
    return probe;
  };
  switch (key) {
    case 'and': {
      for (const c of raw) {
        const r = await evalCond(c, scope, probe);
        if (!r.pass) return { pass: false, why: `and → ${r.why}` };
      }
      return { pass: true, why: 'and: all true' };
    }
    case 'or': {
      const whys: string[] = [];
      for (const c of raw) {
        const r = await evalCond(c, scope, probe);
        if (r.pass) return { pass: true, why: `or → ${r.why}` };
        whys.push(r.why);
      }
      return { pass: false, why: `or: none true (${whys.join('; ')})` };
    }
    case 'not': {
      const r = await evalCond(raw, scope, probe);
      return { pass: !r.pass, why: `not(${r.why})` };
    }
    case 'exists':
    case 'notExists':
    case 'visible':
    case 'hidden': {
      const target = render(raw, scope);
      const n = await needPage().count(target, key === 'visible' || key === 'hidden');
      const pass = key === 'exists' || key === 'visible' ? n > 0 : n === 0;
      return { pass, why: `${key}: ${n} match(es)` };
    }
    case 'urlContains': {
      const u = needPage().url();
      const sub = String(render(raw, scope));
      return { pass: u.includes(sub), why: `url ${short(u)} ${u.includes(sub) ? 'contains' : 'lacks'} ${short(sub)}` };
    }
    case 'urlMatches': {
      const u = needPage().url();
      const pass = new RegExp(String(render(raw, scope))).test(u);
      return { pass, why: `url ${short(u)} ${pass ? 'matches' : 'does not match'} /${raw}/` };
    }
    case 'textContains': {
      const [target, word] = render(raw, scope);
      const t = await needPage().text(target);
      const pass = t != null && t.includes(String(word));
      return { pass, why: `text ${short(t)} ${pass ? 'contains' : 'lacks'} ${short(word)}` };
    }
    case 'truthy':
    case 'empty': {
      const v = render(raw, scope);
      const truthy = Array.isArray(v) ? v.length > 0 : !!v;
      const pass = key === 'truthy' ? truthy : !truthy;
      return { pass, why: `${key}(${short(v)})` };
    }
    default: {
      const [a0, b0] = raw as [any, any];
      const a = render(a0, scope);
      const b = render(b0, scope);
      let pass: boolean;
      switch (key) {
        case 'eq': pass = a === b || (a != null && b != null && String(a) === String(b)); break;
        case 'ne': pass = !(a === b || (a != null && b != null && String(a) === String(b))); break;
        case 'gt': pass = a != null && num(a) > num(b); break;
        case 'gte': pass = a != null && num(a) >= num(b); break;
        case 'lt': pass = a != null && num(a) < num(b); break;
        case 'lte': pass = a != null && num(a) <= num(b); break;
        case 'contains': pass = Array.isArray(a) ? a.includes(b) : String(a ?? '').includes(String(b)); break;
        case 'matches': pass = new RegExp(String(b)).test(String(a ?? '')); break;
        case 'countGte': pass = len(a) >= num(b); return { pass, why: `count ${len(a)} >= ${b}: ${pass}` };
        case 'countLte': pass = len(a) <= num(b); return { pass, why: `count ${len(a)} <= ${b}: ${pass}` };
        case 'countEq': pass = len(a) === num(b); return { pass, why: `count ${len(a)} == ${b}: ${pass}` };
        default: return { pass: false, why: `unknown condition "${key}"` };
      }
      return { pass, why: `${key}(${short(a)}, ${short(b)}) = ${pass}` };
    }
  }
}

/** Collect the targets referenced by a condition (for validation). */
export function conditionTargets(cond: any, acc: any[] = []): any[] {
  if (!cond || typeof cond !== 'object') return acc;
  const [key] = Object.keys(cond);
  const raw = cond[key];
  if (['exists', 'notExists', 'visible', 'hidden'].includes(key)) acc.push(raw);
  else if (key === 'textContains' && Array.isArray(raw)) acc.push(raw[0]);
  else if (key === 'and' || key === 'or') (raw || []).forEach((c: any) => conditionTargets(c, acc));
  else if (key === 'not') conditionTargets(raw, acc);
  return acc;
}
