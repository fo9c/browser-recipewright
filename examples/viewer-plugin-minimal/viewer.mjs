#!/usr/bin/env node
// Minimal viewer plugin for browser-recipewright (run data format v1).
//
// It is NOT part of the package: it shows that a viewer is a separate program that only READS the run
// directory. No imports from browser-recipewright, no dependencies, never writes anything.
//
//   node viewer.mjs                 # follow the newest run (live if it is still running)
//   node viewer.mjs <runDir>        # replay a finished run
//
// Data folder: $BROWSER_RECIPEWRIGHT_HOME, else ~/.browser-recipewright (or the legacy ~/.browser-rpa).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home =
  process.env.BROWSER_RECIPEWRIGHT_HOME ||
  [path.join(os.homedir(), '.browser-recipewright'), path.join(os.homedir(), '.browser-rpa')].find((d) => fs.existsSync(d)) ||
  path.join(os.homedir(), '.browser-recipewright');

function pickRunDir() {
  if (process.argv[2]) return process.argv[2];
  const latest = path.join(home, 'runs', '_latest.json');
  if (!fs.existsSync(latest)) throw new Error(`no run yet: ${latest} not found`);
  return JSON.parse(fs.readFileSync(latest, 'utf8')).runDir;
}

const runDir = pickRunDir();
const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
if (run.format?.name !== 'recipewright.run' || run.format?.version !== 1) {
  console.error(`unsupported run format ${JSON.stringify(run.format ?? null)} (this viewer reads recipewright.run v1)`);
  process.exit(2);
}

const sec = (ms) => (ms / 1000).toFixed(1).padStart(6) + 's';
const show = {
  'run.start': (e) => `▶ ${e.templateId}@${e.templateVersion}  (${e.steps.length} top-level steps)`,
  'step.start': (e) => `  → ${e.path} (${e.action})`,
  'step.retry': (e) => `  ↻ ${e.path} retry #${e.attempt}: ${e.error.code}`,
  'step.end': (e) => `  ${e.status === 'ok' ? '✓' : e.status === 'soft-failed' ? '~' : '✗'} ${e.path} ${e.durationMs}ms${e.error ? ' ' + e.error.code : ''}`,
  'loop.iteration': (e) => `  ┄ ${e.path} item ${e.index + 1}${e.total ? '/' + e.total : ''}`,
  data: (e) => `  ◆ +${e.added} ${e.var ?? ''}${e.total != null ? ` (total ${e.total})` : ''}`,
  'page.navigated': (e) => `  ⌂ ${e.url}`,
  'pointer.click': (e) => `  ● click (${e.x}, ${e.y})`,
  'handoff.start': (e) => `  🙋 human needed: ${e.reason}`,
  'handoff.end': (e) => `  🙋 ${e.resolved ? 'done' : 'gave up'} after ${Math.round(e.waitedMs / 1000)}s`,
  'run.end': (e) => `■ ${e.status}${e.error ? ' ' + e.error.code : ''}  ${e.durationMs}ms  → output.json`,
};
// pointer.move / pointer.wheel / key.type / artifact and unknown types are ignored here (a graphical viewer would animate them)

const file = path.join(runDir, 'events.jsonl');
let pos = 0;
let rest = '';
let ended = false;
function pump() {
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size <= pos) return;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - pos);
  fs.readSync(fd, buf, 0, buf.length, pos);
  fs.closeSync(fd);
  pos = size;
  const lines = (rest + buf.toString('utf8')).split('\n');
  rest = lines.pop(); // an unfinished last line: wait for the rest of it
  for (const line of lines) {
    if (!line) continue;
    const e = JSON.parse(line);
    const fmt = show[e.type];
    if (fmt) console.log(`${sec(e.ms)} ${fmt(e)}`);
    if (e.type === 'run.end') ended = true;
  }
}

pump();
const timer = setInterval(() => {
  pump();
  const status = (() => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).status; } catch { return 'running'; } })();
  if (ended || status !== 'running') {
    pump();
    clearInterval(timer);
  }
}, 250);
