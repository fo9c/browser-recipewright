/**
 * Usage per profile (= per site + account), whichever way a run was started (run, batch, answer).
 *
 * usage/<site>__<account>.json   { "v": 2, "runs": [ { "at": "<iso>", "items": 12 } ] }
 *
 * A run counts once when it ends (paused runs count when they finally end); "items" is how many records it
 * returned (length of an array output, else 1 for a non-empty output, 0 on failure). Entries older than 8 days
 * are dropped. "Today" is the local calendar day. Only used to remind, never to block a run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs, readJson, writeJson, safeName } from './util.js';

const KEEP_MS = 8 * 24 * 3600 * 1000;

export function usageFile(profile: string) {
  return path.join(dirs.usage(), profile.split('/').filter(Boolean).map(safeName).join('__') + '.json');
}

function readRuns(profile: string): { at: string; items: number }[] {
  const f = usageFile(profile);
  if (!fs.existsSync(f)) return [];
  try {
    const u = readJson(f);
    return Array.isArray(u.runs) ? u.runs : [];
  } catch {
    return [];
  }
}

export function recordUsage(profile: string, items: number, at = new Date()) {
  const cutoff = at.getTime() - KEEP_MS;
  const runs = readRuns(profile).filter((r) => Date.parse(r.at) >= cutoff);
  runs.push({ at: at.toISOString(), items: Math.max(0, Math.floor(items || 0)) });
  writeJson(usageFile(profile), { v: 2, runs });
}

const dayKey = (d: Date) => {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export interface Usage {
  runsToday: number;
  itemsToday: number;
}

export function usageOf(profile: string, now = new Date()): Usage {
  const today = dayKey(now);
  const u: Usage = { runsToday: 0, itemsToday: 0 };
  for (const r of readRuns(profile)) {
    if (dayKey(new Date(r.at)) === today) { u.runsToday++; u.itemsToday += r.items; }
  }
  return u;
}

/** Items a run returned, for usage: array length, 1 for any other non-empty output, 0 when it failed. */
export function itemsOf(status: string, output: any): number {
  if (status !== 'success' || output == null) return 0;
  return Array.isArray(output) ? output.length : 1;
}
