/** Template library: built-in templates (package/templates) + user templates (~/.browser-rpa/templates). */
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT, dirs, readJson, writeJson, ensureDir, RpaError } from './util.js';
import { validateTemplate } from './validate.js';

export interface LoadedTemplate {
  template: any;
  path: string;
  source: 'file' | 'user' | 'builtin';
}

export const builtinDir = () => path.join(PKG_ROOT, 'templates');

function walkJson(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith('.')) continue;
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walkJson(p, acc);
    else if (n.endsWith('.json')) acc.push(p);
  }
  return acc;
}

export function loadTemplate(ref: string): LoadedTemplate {
  if (fs.existsSync(ref) && fs.statSync(ref).isFile()) return { template: readJson(ref), path: path.resolve(ref), source: 'file' };
  for (const [dir, source] of [[dirs.templates(), 'user'], [builtinDir(), 'builtin']] as const) {
    const direct = path.join(dir, ref.endsWith('.json') ? ref : ref + '.json');
    if (fs.existsSync(direct)) return { template: readJson(direct), path: direct, source };
    for (const f of walkJson(dir)) {
      try {
        const t = readJson(f);
        if (t.id === ref) return { template: t, path: f, source };
      } catch {}
    }
  }
  throw new RpaError('TEMPLATE_NOT_FOUND', `template "${ref}" not found (not a file, not in ${dirs.templates()} or built-in library). Try: browser-rpa list`);
}

export function listTemplates() {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const [dir, source] of [[dirs.templates(), 'user'], [builtinDir(), 'builtin']] as const) {
    for (const f of walkJson(dir)) {
      try {
        const t = readJson(f);
        if (!t.id || !t.steps) continue;
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const v = validateTemplate(t);
        out.push({ id: t.id, version: t.version, title: t.title, site: t.site, inputs: Object.keys(t.inputs || {}), source, path: f, valid: v.ok });
      } catch {}
    }
  }
  return out;
}

/** Copy a validated template into the user library, keeping the previous version in .history/. */
export function saveTemplate(file: string): string {
  const t = readJson(file);
  const v = validateTemplate(t);
  if (!v.ok) throw new RpaError('TEMPLATE_INVALID', `template has ${v.errors.length} error(s); run browser-rpa validate first`);
  const dest = path.join(dirs.templates(), t.id + '.json');
  if (fs.existsSync(dest)) {
    const old = readJson(dest);
    const hist = ensureDir(path.join(dirs.templates(), '.history'));
    writeJson(path.join(hist, `${t.id.replace(/\//g, '__')}@${old.version}.json`), old);
  }
  writeJson(dest, t);
  return dest;
}
