/**
 * Self-repair support. The AI never rewrites a whole template: it writes a patch that targets one step id.
 *
 * patch.json  (object or array of objects):
 *   { "stepId": "collect-posts", "op": "replace", "value": { ...whole new step... } }
 *   { "stepId": "collect-posts", "op": "merge",   "value": { "maxScrolls": 60 } }
 *   { "stepId": "open-post",     "op": "insertBefore" | "insertAfter", "value": { ...new step... } }
 *   { "stepId": "close-popup",   "op": "remove" }
 *   { "stepId": "collect-posts", "ops": [ { "op": "replace", "path": "/item/0", "value": { "css": "article" } } ] }   // JSON Patch inside the step
 *   optional on any entry: "note": "why"
 */
import fs from 'node:fs';
import path from 'node:path';
import { RecipeError, readJson, writeJson, dirs, ensureDir } from './util.js';
import { validateTemplate, ValidationResult } from './validate.js';

type StepHolder = { list: any[]; index: number };

function findStep(steps: any[], id: string): StepHolder | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s?.id === id) return { list: steps, index: i };
    for (const k of ['do', 'then', 'else', 'steps']) {
      if (Array.isArray(s?.[k])) {
        const r = findStep(s[k], id);
        if (r) return r;
      }
    }
  }
  return null;
}

function pointer(obj: any, p: string): { parent: any; key: string } {
  const parts = p.split('/').slice(1).map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[Array.isArray(cur) ? Number(parts[i]) : parts[i]];
    if (cur === undefined) throw new RecipeError('PATCH_INVALID', `path ${p} does not exist`);
  }
  return { parent: cur, key: parts[parts.length - 1] };
}

function applyJsonPatch(target: any, ops: any[]) {
  for (const o of ops) {
    const { parent, key } = pointer(target, o.path);
    const isArr = Array.isArray(parent);
    const idx = key === '-' ? parent.length : Number(key);
    if (o.op === 'replace') isArr ? (parent[idx] = o.value) : (parent[key] = o.value);
    else if (o.op === 'add') isArr ? parent.splice(idx, 0, o.value) : (parent[key] = o.value);
    else if (o.op === 'remove') isArr ? parent.splice(idx, 1) : delete parent[key];
    else throw new RecipeError('PATCH_INVALID', `unsupported JSON Patch op "${o.op}"`);
  }
}

function bump(v: string) {
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b}.${(c || 0) + 1}`;
}

export function applyPatch(template: any, patch: any): { template: any; changed: string[] } {
  const t = JSON.parse(JSON.stringify(template));
  const entries = Array.isArray(patch) ? patch : [patch];
  const changed: string[] = [];
  for (const e of entries) {
    if (!e.stepId) throw new RecipeError('PATCH_INVALID', 'each patch entry needs "stepId"');
    const h = findStep(t.steps, e.stepId);
    if (!h) throw new RecipeError('PATCH_INVALID', `step "${e.stepId}" not found in template`);
    const op = e.ops ? 'jsonpatch' : e.op || 'replace';
    switch (op) {
      case 'replace':
        if (!e.value?.id) e.value = { ...e.value, id: e.stepId };
        h.list[h.index] = e.value;
        break;
      case 'merge':
        h.list[h.index] = { ...h.list[h.index], ...e.value };
        break;
      case 'remove':
        h.list.splice(h.index, 1);
        break;
      case 'insertBefore':
        h.list.splice(h.index, 0, e.value);
        break;
      case 'insertAfter':
        h.list.splice(h.index + 1, 0, e.value);
        break;
      case 'jsonpatch':
        applyJsonPatch(h.list[h.index], e.ops);
        break;
      default:
        throw new RecipeError('PATCH_INVALID', `unknown op "${op}"`);
    }
    changed.push(e.stepId);
  }
  const from = t.version;
  t.version = bump(t.version);
  t.provenance = t.provenance || {};
  t.provenance.repairs = [...(t.provenance.repairs || []), { at: new Date().toISOString(), fromVersion: from, toVersion: t.version, steps: changed, notes: entries.map((e: any) => e.note).filter(Boolean) }];
  return { template: t, changed };
}

/** Minimal line diff (LCS) for human review. */
export function lineDiff(a: string, b: string): string {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { out.push('  ' + A[i]); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push('+ ' + B[j]); j++; }
    else { out.push('- ' + A[i]); i++; }
  }
  // keep only changed lines with 2 lines of context
  const keep = new Set<number>();
  out.forEach((l, k) => { if (!l.startsWith('  ')) for (let d = -2; d <= 2; d++) keep.add(k + d); });
  const res: string[] = [];
  let last = -1;
  out.forEach((l, k) => { if (keep.has(k)) { if (last >= 0 && k > last + 1) res.push('  ...'); res.push(l); last = k; } });
  return res.join('\n');
}

export function patchTemplateFile(file: string, patchFile: string, write: boolean, builtin: boolean): { diff: string; validation: ValidationResult; written: string | null; version: string } {
  const before = readJson(file);
  const patch = readJson(patchFile);
  const { template } = applyPatch(before, patch);
  const validation = validateTemplate(template);
  const diff = lineDiff(JSON.stringify(before, null, 2), JSON.stringify(template, null, 2));
  let written: string | null = null;
  if (write && validation.ok) {
    if (builtin) {
      written = path.join(dirs.templates(), template.id + '.json'); // never modify the package; fork into the user library
    } else {
      const hist = ensureDir(path.join(path.dirname(file), '.history'));
      fs.copyFileSync(file, path.join(hist, `${path.basename(file, '.json')}@${before.version}.json`));
      written = file;
    }
    writeJson(written, template);
  }
  return { diff, validation, written, version: template.version };
}
