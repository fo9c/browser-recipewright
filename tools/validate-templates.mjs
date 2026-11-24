#!/usr/bin/env node
// Statically validate every recipe under templates/ (used by CI and `npm run validate:templates`).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue; // skip .history etc.
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".json")) files.push(p);
  }
})(join(root, "templates"));

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [join(root, "bin/browser-recipewright.js"), "validate", f], { encoding: "utf8" });
  const rel = f.slice(root.length);
  if (r.status === 0) console.log(`ok    ${rel}`);
  else { failed++; console.log(`FAIL  ${rel}\n${r.stdout}${r.stderr}`); }
}
console.log(`\n${files.length - failed}/${files.length} recipes valid`);
process.exit(failed ? 1 : 0);
