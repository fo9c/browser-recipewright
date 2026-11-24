# Run data format v1 (`recipewright.run/1`)

Every run writes the same set of local files. This document is the contract between the executor and
**viewer plugins**: separate programs that read those files and turn them into something to look at
(a live dashboard, a replay, a report, a chart). The executor ships no viewer and never depends on one.

```
executor (browser-recipewright run / batch / demo)
    │ writes, append-only
    ▼
~/.browser-recipewright/runs/<runId>/      ◀── viewer plugins only READ this
```

Principles:

- **Read-only.** A plugin never writes into the data folder. Removing every plugin changes nothing about a run.
- **Local files are the API.** No server, no socket, no import of this package. Any language that can read a file can be a plugin.
- **Always on.** Every run writes the format; there is no flag to turn it on, so a plugin can show any past run.
- **Looks are free.** The format says *what happened*; how a plugin draws it is up to the plugin.

A Chinese, beginner-friendly overview lives in [viewer-plugins.zh.md](viewer-plugins.zh.md).

## 1. Where the data is

| Path | What |
| --- | --- |
| `$BROWSER_RECIPEWRIGHT_HOME` | Data folder. Default `~/.browser-recipewright` (older installs: `~/.browser-rpa`). |
| `runs/<runId>/` | One run. `runId` = `<UTC time>_<template id>_<random>`, sorts by start time. |
| `runs/_latest.json` | Pointer to the newest run: `{ runId, runDir, templateId, status, startedAt, finishedAt }`. Rewritten when a run starts and ends. Watch this file to notice new runs. |
| `batches/<batchId>/results.jsonl` | One line per job of a batch (`key`, `account`, `status`, `runDir`, `error`, `outputCount`, `at`); `runDir` links to the run. `summary.json` when the batch ends. |

Names starting with `_` inside `runs/` are not runs.

## 2. Files inside a run

| File | Written | Content |
| --- | --- | --- |
| `run.json` | at start, rewritten at end | Run summary (below). `status` is `running` until the end. |
| `events.jsonl` | appended while running | **The event stream** (section 3). What a viewer mainly reads. |
| `steps.jsonl` | one line per finished step | Full step records (locator candidates tried, expect results, truncated output). Detail for drill-down. |
| `output.json` | at end | The run's result data (`outputs.from` of the recipe), or `null`. |
| `state.json` | after each top-level step | Resume checkpoint. Internal; plugins should not rely on its shape. |
| `artifacts/` | when saved | Screenshots (`screenshots: "every"` or `screenshot: true` on a step), downloads. Announced by `artifact` events. |
| `failure/` | on failure | `dossier.json` (aimed at an AI repairing the recipe), `screenshot.png`, `snapshot.txt`, `snapshot.refs.json`. |
| `HANDOFF.json` | only while waiting for a human | Present = the run is paused for a person. |

### `run.json`

```json
{
  "format": { "name": "recipewright.run", "version": 1 },
  "runId": "2026-11-24T12-13-47_demo-local-feed_sbxe",
  "templateId": "demo/local-feed",
  "templateVersion": "0.1.0",
  "templatePath": "/…/templates/demo/local-feed.json",
  "profile": "demo/default",
  "account": null,
  "inputs": { "base": "http://127.0.0.1:4173", "password": "***" },
  "resumedFrom": null,
  "options": { "humanize": true, "headless": true, "handoff": "never", "screenshots": "failure" },
  "status": "success",
  "startedAt": "2026-11-24T12:13:47.826Z",
  "finishedAt": "2026-11-24T12:14:04.010Z",
  "durationMs": 16184,
  "error": null,
  "outputCount": 5,
  "runDir": "/…/runs/2026-11-24T12-13-47_demo-local-feed_sbxe"
}
```

`status`: `running` → `success` | `failed`. A run with `running` and no new events for a long time was killed.
Inputs marked `secret` in the recipe are stored as `"***"`. Runs from before v1 have no `format` field: read
`steps.jsonl` instead.

## 3. `events.jsonl`

One JSON object per line, in the order things happened. Every line has the same envelope:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | integer | Format version, `1`. |
| `seq` | integer | 1, 2, 3 … without gaps. |
| `t` | string | ISO time (UTC). |
| `ms` | integer | Milliseconds since `run.start`. Never goes backwards. Use it for timelines and replay speed. |
| `type` | string | Event type (table below). |

The rest of the fields depend on `type` and sit next to the envelope (no nesting):

```json
{"v":1,"seq":8,"t":"2026-11-24T12:13:11.128Z","ms":620,"type":"step.start","step":3,"path":"close-banner","stepId":"close-banner","action":"click","url":"http://127.0.0.1:4173/search.html?q=agent&f=top"}
```

### Event types

| `type` | Fields (✱ = always present) | When |
| --- | --- | --- |
| `run.start` | `runId`✱ `templateId`✱ `templateVersion`✱ `steps`✱ `templatePath` `profile` `account` `inputs` `resumedFrom` `options` `startedAt` | First line. `steps` is the recipe outline (below), so a viewer can draw every step before it runs. |
| `run.end` | `status`✱ (`success`/`failed`) `durationMs`✱ `error` `outputCount` `output` | Last line. `output.json` is already written. |
| `step.start` | `step`✱ `path`✱ `stepId`✱ `action`✱ `url` `description` | A step begins. `step` is the step's number in this run; `step.end` carries the same number. |
| `step.end` | `step`✱ `path`✱ `stepId`✱ `action`✱ `status`✱ `durationMs`✱ `attempts` `urlAfter` `locatorHit` `error` `note` `handoffMs` `artifacts` | A step finished. `status`: `ok` / `failed` / `soft-failed` (optional step failed, run goes on) / `skipped`. `locatorHit` > 0 = a fallback locator was needed (early sign the site changed). The full record is the line with the same `seq` in `steps.jsonl`. |
| `step.retry` | `step`✱ `path`✱ `attempt`✱ `error`✱ | A step failed and is about to be tried again. |
| `loop.iteration` | `path`✱ `index`✱ `total` `max` `item` | A `forEach` / `while` loop begins item `index` (0-based). `total` for `forEach`, `max` for `while`; `item` is a short preview of the forEach item. |
| `data` | `path`✱ `mode`✱ `added`✱ `step` `var` `total` `duplicates` `preview` | A step stored extracted data. `mode`: `save` (`saveAs`), `append` (`appendTo`; `total` = list length after, `duplicates` = skipped by `dedupeBy`), `collect`. `preview` = up to 3 items, each cut to ~400 characters; the full data is in `output.json`. |
| `page.navigated` | `url`✱ | The main frame went to a new URL (also emitted once when the run attaches to the page). |
| `page.viewport` | `width`✱ `height`✱ `dpr` | Size of the page viewport in CSS pixels; emitted when first known and whenever it changes. |
| `pointer.move` | `x`✱ `y`✱ `fromX` `fromY` `durationMs` | The mouse arrived at (x, y) after a curved move that took `durationMs`. |
| `pointer.click` | `x`✱ `y`✱ `button` `count` | Mouse pressed and released at (x, y). |
| `pointer.wheel` | `dy`✱ `x` `y` | Scroll by `dy` CSS pixels (positive = down) with the mouse at (x, y). |
| `key.type` | `chars`✱ | Text was typed: only the **number** of characters, never the text. |
| `handoff.start` | `reason`✱ `code`✱ `timeoutMs` | The run paused and is waiting for a person (login, captcha, `handoff` step). |
| `handoff.end` | `waitedMs`✱ `resolved`✱ `code` | The person finished (`resolved: true`) or the wait gave up. |
| `artifact` | `path`✱ `kind`✱ `step` | A file was saved; `path` is relative to the run folder. `kind`: `screenshot`, `download`, `failure-screenshot`, `dossier`. |

Coordinates are CSS pixels relative to the top-left of the page viewport. `pointer.*` and `key.type` come from
the human-like input layer, so they are present when `humanize` is on (the default); with `humanize: false`
clicks happen without them.

Typical order inside one step: `step.start` → (`pointer.move` → `pointer.click`, `page.navigated`, `pointer.wheel` …)
→ `step.retry`? → `data`? → `artifact`? → `step.end`. Control steps (`forEach`, `while`, `if`, `group`) wrap their
children: their `step.end` comes after all children ended.

### Step paths

`path` says where a step sits in the recipe: `open-search`, `read-each[2].collect-replies` (third item of the
loop `read-each`), `maybe-login.click-ok` (inside `if` / `group`). The special path `_login-check` is the login
check before step 1. In the `run.start` outline, loop children use `[*]` (`read-each[*].collect-replies`);
replace `[*]` with `[index]` to match a running step to its outline node.

### Recipe outline (`run.start.steps`)

```json
[
  { "id": "open-search", "path": "open-search", "action": "goto" },
  { "id": "read-each", "path": "read-each", "action": "forEach", "loop": true,
    "children": { "do": [ { "id": "open-post", "path": "read-each[*].open-post", "action": "goto" } ] } }
]
```

Node fields: `id`, `path`, `action`, optional `description`, `optional: true`, `loop: true`, and `children`
grouped by the recipe key they come from (`steps`, `do`, `then`, `else`).

## 4. Reading it (live or afterwards)

1. Find the run: a path you were given, or `runs/_latest.json`.
2. Read `run.json`; check `format.name === "recipewright.run"` and `format.version === 1`.
3. Read `events.jsonl` from the start. To follow a live run, remember the byte offset you read up to and read
   again when the file grows (poll every 100–500 ms, or use a file watcher).
4. **A last line without a trailing `\n` is still being written**: keep it and wait for the rest.
5. Stop at `run.end`. If it never comes and `run.json` no longer says `running`, the process was killed.

Without writing any code:

```bash
browser-recipewright events                 # the newest run's events, one JSON per line
browser-recipewright events <runDir> -f     # follow a run live until it ends (pipe it into your plugin)
browser-recipewright check-run [<runDir>]   # check a run folder against this format
browser-recipewright schema --run-events    # JSON Schema of one line (also in schema/run-events.v1.json)
```

A complete, dependency-free example plugin: [examples/viewer-plugin-minimal](../examples/viewer-plugin-minimal).

## 5. Versioning rules

- Within v1 the executor may **add** event types and **add** fields. Plugins must ignore types and fields they do
  not know.
- Fields marked ✱ above are never removed or renamed in v1, and their meaning does not change.
- A breaking change bumps `v` / `format.version` to 2. A plugin that sees a version it does not know should say so
  instead of guessing.

## 6. For contributors: where the executor writes it

| Hook | File | Emits |
| --- | --- | --- |
| `RunEvents` (append-only writer, never throws) | `src/events.ts` | envelope, `seq`, `ms` |
| `RunRecorder.start / step / artifact / finish` | `src/records.ts` | `run.start`, `step.end`, `artifact`, `run.end`, `_latest.json` |
| `Runner.execStep / control / handoff` | `src/engine.ts` | `step.start`, `step.retry`, `loop.iteration`, `data`, `handoff.*` |
| `Runner.watchPage` | `src/engine.ts` | `page.navigated`, `page.viewport`, bridges the input observer |
| `observeInput(page, observer)` | `src/human.ts` | `pointer.*`, `key.type` |
| `onRunEvent(fn)` / `RunEvents.subscribe(fn)` | `src/events.ts` | in-process listeners: the place to attach a future live transport (e.g. a local SSE server) without touching the engine |

When you add an event: emit it through `this.rec.events.emit(type, fields)`, add its payload schema to
`EVENT_SCHEMAS`, run `npm run schema`, and document it in the table above. Writing events must never change
timing or behaviour of a run, and must never throw.
