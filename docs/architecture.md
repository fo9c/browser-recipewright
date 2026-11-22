# Architecture

```
skills/browser-rpa/SKILL.md      how an agent should use the CLI (explore → write → validate → run → heal)
        │
        ▼
src/cli.ts                       commands; JSON on stdout, progress on stderr, exit codes 0/1/2/3
        │
        ├── library.ts           template library (built-in + ~/.browser-rpa/templates)
        ├── validate.ts          static checks (schema.ts zod schemas + references, loops, domains, scripts)
        ├── engine.ts            Runner: login check → steps → records → outputs
        │     ├── locator.ts     candidate locators → exactly-one element (patchright locators)
        │     ├── human.ts       bezier mouse paths, jittered typing, chunked wheel (CDP trusted input)
        │     ├── inpage.ts      code evaluated in an isolated world: field extraction, snapshot, challenge detection
        │     ├── conditions.ts  structured conditions
        │     ├── render.ts      {{ }} references + filters
        │     ├── scripts.ts     runScript whitelist (sha256 + domains)
        │     └── records.ts     runs/<id>/ run.json, steps.jsonl, state.json, output.json, failure/dossier.json
        ├── browser.ts           find system Chrome, spawn with clean flags + own user-data-dir, connectOverCDP, sessions
        ├── heal.ts              step-scoped patches, diff, version bump, .history
        └── batch.ts             accounts × jobs, spacing, daily caps, login skip, results.jsonl, resume
```

## Design choices

- **Self-spawned Chrome + `connectOverCDP`** instead of `launchPersistentContext`: the browser is launched exactly like
  a normal Chrome with a dedicated profile (no `--enable-automation`, no automation extension), and it can outlive one
  CLI call, so `snapshot` / `act` / `run` share a live window. patchright removes the `Runtime.enable` leak and runs
  our evaluations in isolated worlds.
- **Locators resolved by patchright** for actions (actionability checks, trusted input), **field extraction in page**
  (one evaluate per scroll for `collect`, fast on long feeds).
- **Snapshot refs persist as locator candidates**, not as in-memory handles, so they survive between CLI processes
  and can be pasted straight into templates.
- **Records first**: every step is appended to `steps.jsonl` as it finishes; `state.json` after each top-level step
  makes `--resume` possible; failures write a dossier aimed at an AI reader.
- **Environment vs template errors** decide who acts: env → human (handoff / skip account), template → AI patch.

## Roadmap (not in v0.1)

- Recorder (record a human session → AI cleans and parameterizes it)
- Self-heal benchmark (before/after page versions, published success rate)
- Sub-templates, YAML input, MCP server wrapper
