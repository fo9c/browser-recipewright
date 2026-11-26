/** {{ ... }} references: lookup only, plus a few built-in filters. No arbitrary expressions. */
import { RecipeError } from './util.js';

export type Scope = Record<string, any>;

const EXPR = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;

export const FILTERS: Record<string, (v: any) => any> = {
  urlencode: (v) => encodeURIComponent(v == null ? '' : String(v)),
  trim: (v) => (v == null ? '' : String(v).trim()),
  number: (v) => {
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  },
  lower: (v) => (v == null ? '' : String(v).toLowerCase()),
  upper: (v) => (v == null ? '' : String(v).toUpperCase()),
  length: (v) => (v == null ? 0 : Array.isArray(v) || typeof v === 'string' ? v.length : Object.keys(v).length),
  json: (v) => JSON.stringify(v),
  /** one level: [[a,b],[c]] -> [a,b,c]; non-array items are kept as they are */
  flatten: (v) => (Array.isArray(v) ? v.flatMap((x) => (Array.isArray(x) ? x : [x])) : v),
  /** drop null/undefined items from a list */
  compact: (v) => (Array.isArray(v) ? v.filter((x) => x != null) : v),
};

export function parseExpr(expr: string): { path: string[]; filters: string[] } {
  const [head, ...filters] = expr.split('|').map((x) => x.trim());
  const path: string[] = [];
  const re = /([a-zA-Z_$][a-zA-Z0-9_$-]*)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let consumed = '';
  while ((m = re.exec(head))) {
    path.push(m[1] ?? m[2]);
    consumed += m[0];
  }
  if (!path.length || consumed.length !== head.replace(/\./g, '').length) {
    throw new RecipeError('TEMPLATE_INVALID', `bad reference "{{${expr}}}"`);
  }
  return { path, filters };
}

export function lookup(scope: Scope, expr: string): any {
  const { path, filters } = parseExpr(expr);
  let v: any = scope;
  for (const k of path) {
    if (v == null) {
      v = undefined;
      break;
    }
    v = v[k];
  }
  for (const f of filters) {
    const fn = FILTERS[f];
    if (!fn) throw new RecipeError('TEMPLATE_INVALID', `unknown filter "${f}"`);
    v = fn(v);
  }
  return v;
}

export function renderString(s: string, scope: Scope): any {
  const whole = s.match(WHOLE);
  if (whole) return lookup(scope, whole[1]);
  return s.replace(EXPR, (_, e) => {
    const v = lookup(scope, e);
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function render<T = any>(value: T, scope: Scope): any {
  if (typeof value === 'string') return renderString(value, scope);
  if (Array.isArray(value)) return value.map((v) => render(v, scope));
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v, scope);
    return out;
  }
  return value;
}

/** All reference expressions inside a value (for static validation). */
export function findRefs(value: any, acc: string[] = []): string[] {
  if (typeof value === 'string') {
    for (const m of value.matchAll(EXPR)) acc.push(m[1]);
  } else if (Array.isArray(value)) value.forEach((v) => findRefs(v, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => findRefs(v, acc));
  return acc;
}

/** "1.2K" / "3,456" / "1.5万" / "12 Likes" -> number */
export function parseCount(raw: any): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim().replace(/,/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*([KkMmBb万亿千]?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, 千: 1e3, 万: 1e4, 亿: 1e8 };
  return Math.round(n * (mult[m[2].toLowerCase()] || 1));
}
