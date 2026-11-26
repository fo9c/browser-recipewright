/**
 * Usage per profile (= per site + account), so caps hold no matter how a run was started (run, batch, answer).
 *
 * usage/<site>__<account>.json   { "v": 2, "runs": [ { "at": "<iso>", "items": 12 } ] }
 *
 * A run counts once when it ends (paused runs count when they finally end); "items" is how many records it
 * returned (length of an array output, else 1 for a non-empty output, 0 on failure). Entries older than 8 days
 * are dropped. "Today" is the local calendar day, "this hour" is the last 60 minutes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirs, readJson, writeJson, safeName } from './util.js';

export interface Caps {
  runsPerDay?: number;
  runsPerHour?: number;
  itemsPerDay?: number;
  itemsPerHour?: number;
}
export interface Usage {
  runsToday: number;
  runsLastHour: number;
  itemsToday: number;
  itemsLastHour: number;
}

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

export function usageOf(profile: string, now = new Date()): Usage {
  const today = dayKey(now);
  const hourAgo = now.getTime() - 3600 * 1000;
  const u: Usage = { runsToday: 0, runsLastHour: 0, itemsToday: 0, itemsLastHour: 0 };
  for (const r of readRuns(profile)) {
    const t = new Date(r.at);
    if (dayKey(t) === today) { u.runsToday++; u.itemsToday += r.items; }
    if (t.getTime() >= hourAgo && t.getTime() <= now.getTime()) { u.runsLastHour++; u.itemsLastHour += r.items; }
  }
  return u;
}

/** Is another run allowed now? itemsLeft = how many more items the item caps allow (undefined = no item cap). */
export function checkCaps(profile: string, caps: Caps | undefined, now = new Date()): { ok: boolean; reason?: string; itemsLeft?: number; usage: Usage } {
  const usage = usageOf(profile, now);
  const c = caps || {};
  const over = (used: number, cap: number | undefined) => cap !== undefined && cap !== null && used >= cap;
  if (over(usage.runsToday, c.runsPerDay)) return { ok: false, reason: `daily cap ${c.runsPerDay} runs reached`, usage };
  if (over(usage.runsLastHour, c.runsPerHour)) return { ok: false, reason: `hourly cap ${c.runsPerHour} runs reached`, usage };
  if (over(usage.itemsToday, c.itemsPerDay)) return { ok: false, reason: `daily cap ${c.itemsPerDay} items reached`, usage };
  if (over(usage.itemsLastHour, c.itemsPerHour)) return { ok: false, reason: `hourly cap ${c.itemsPerHour} items reached`, usage };
  const left = [c.itemsPerDay !== undefined ? c.itemsPerDay - usage.itemsToday : undefined, c.itemsPerHour !== undefined ? c.itemsPerHour - usage.itemsLastHour : undefined].filter((x): x is number => x !== undefined);
  return { ok: true, itemsLeft: left.length ? Math.min(...left) : undefined, usage };
}

/** Items a run returned, for usage: array length, 1 for any other non-empty output, 0 when it failed. */
export function itemsOf(status: string, output: any): number {
  if (status !== 'success' || output == null) return 0;
  return Array.isArray(output) ? output.length : 1;
}
