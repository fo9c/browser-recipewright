/** Whitelisted page scripts: runScript may only run files listed in a manifest with a matching sha256. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PKG_ROOT, dirs, RpaError } from './util.js';

export interface ScriptEntry {
  file: string;
  sha256: string;
  domains: string[];
  description?: string;
  dir: string;
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readManifest(dir: string): Record<string, ScriptEntry> {
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) return {};
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const out: Record<string, ScriptEntry> = {};
  for (const [name, e] of Object.entries<any>(raw.scripts || raw)) out[name] = { ...e, dir };
  return out;
}

export function loadScripts(): Record<string, ScriptEntry> {
  return { ...readManifest(path.join(PKG_ROOT, 'scripts')), ...readManifest(dirs.scripts()) };
}

export function hostMatches(host: string, domain: string): boolean {
  if (domain === '*') return true;
  host = host.toLowerCase();
  domain = domain.toLowerCase().replace(/^\*\./, '');
  return host === domain || host.endsWith('.' + domain);
}

/** Returns an error message or null. */
export function checkScript(name: string, site: string[]): string | null {
  const e = loadScripts()[name];
  if (!e) return `script "${name}" is not in any whitelist manifest`;
  const file = path.join(e.dir, e.file);
  if (!fs.existsSync(file)) return `script file missing: ${file}`;
  const h = sha256File(file);
  if (h !== e.sha256) return `script "${name}" hash mismatch (manifest ${e.sha256.slice(0, 12)}…, file ${h.slice(0, 12)}…)`;
  if (e.domains?.length && !e.domains.includes('*') && !site.some((s) => e.domains.some((d) => hostMatches(s, d))))
    return `script "${name}" is only allowed on ${e.domains.join(', ')}`;
  return null;
}

export function loadScriptCode(name: string, site: string[]): string {
  const err = checkScript(name, site);
  if (err) throw new RpaError('SCRIPT_REJECTED', err);
  const e = loadScripts()[name];
  return fs.readFileSync(path.join(e.dir, e.file), 'utf8');
}
