import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

export function randInt(min: number, max: number): number {
  if (max < min) [min, max] = [max, min];
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** ms may be a number or a [min,max] range */
export function pickMs(v: number | [number, number] | undefined, fallback = 0): number {
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) return randInt(v[0], v[1]);
  return v;
}

/** Root of the installed package (one level above dist/ or src/). */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function homeDir(): string {
  return process.env.BROWSER_RPA_HOME || path.join(os.homedir(), '.browser-rpa');
}

export const dirs = {
  profiles: () => path.join(homeDir(), 'profiles'),
  runs: () => path.join(homeDir(), 'runs'),
  batches: () => path.join(homeDir(), 'batches'),
  sessions: () => path.join(homeDir(), 'sessions'),
  templates: () => path.join(homeDir(), 'templates'),
  scripts: () => path.join(homeDir(), 'scripts'),
  usage: () => path.join(homeDir(), 'usage'),
};

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJson<T = any>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';
}

export function timestampId(): string {
  return new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
}

export function shortRand(n = 4): string {
  return Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0');
}

export function todayKey(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Stderr logger so stdout stays machine-readable JSON. */
export const log = {
  quiet: false,
  info(msg: string) {
    if (!this.quiet) process.stderr.write(msg + '\n');
  },
  warn(msg: string) {
    process.stderr.write('⚠️  ' + msg + '\n');
  },
};

export function truncateForRecord(v: unknown, maxLen = 2000): unknown {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  if (s === undefined) return null;
  if (s.length <= maxLen) return v;
  if (Array.isArray(v)) return { _summary: `array(${v.length})`, first: truncateForRecord(v[0], maxLen / 2) };
  return { _summary: `truncated ${s.length} chars`, preview: s.slice(0, maxLen) };
}

export class RpaError extends Error {
  code: string;
  details?: any;
  constructor(code: string, message: string, details?: any) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const ENV_ERROR_CODES = new Set(['LOGIN_REQUIRED', 'CHALLENGE_DETECTED', 'BROWSER_ERROR']);
