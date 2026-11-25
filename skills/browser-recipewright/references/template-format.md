# Template format v0 — reference

A template is one JSON file: metadata + inputs + defaults + steps + outputs.
Machine-readable schema: `schema/template.v0.json` (or `browser-recipewright schema`).

## Top level

| field | required | meaning |
|---|---|---|
| `$schema` | no | URL of the JSON Schema (editors validate with it) |
| `id` | yes | `site/task`, e.g. `example.com/search-results` |
| `version` | yes | semver; `patch` bumps the last number |
| `title` / `description` | title yes | one line for humans and library search |
| `tags` | no | strings |
| `site` | yes | allowed domains (subdomains included). Leaving them fails with `NAVIGATION_BLOCKED` |
| `account` | no | `{ checkUrl, loginUrl, loginCheck }`. Before step 1 the runner opens `checkUrl` and evaluates `loginCheck`; if false it hands off to the human (or fails `LOGIN_REQUIRED` when non-interactive) |
| `inputs` | no | `{ name: { type: string/integer/number/boolean/array/object, default, description, enum, secret, required } }`. No default ⇒ required. `secret: true` ⇒ shown as `***` in records |
| `defaults` | no | `timeoutMs` (10000), `retries` (0), `stepGapMs` (number or `[min,max]`), `humanize` (true), `screenshots` (`failure`/`every`/`none`) |
| `steps` | yes | array of steps |
| `outputs` | no | `{ from: "{{vars.x}}", schema: {...} }` — final result, checked against a JSON Schema subset (type, required, properties, items, minItems, maxItems, enum) ⇒ `OUTPUT_INVALID` |
| `provenance` | no | free-form; `patch` appends to `provenance.repairs` |

### Fragments: `startOn` and `kind`

- `startOn`: `{ "when": <condition>, "goto": "<url, may use inputs>" }`. Before step 1: if the current page meets
  `when`, start here (an agent chaining fragments in one browser); else open `goto` and check again; else fail with
  `START_PAGE_MISMATCH`. The login check also happens in place when `when` already holds.
- `kind`: `"recipe"` (a fixed fragment) or `"flow"` (strings recipes and breakpoints together). Informational.

## Common step fields

`id` (unique, `[a-zA-Z][a-zA-Z0-9_-]*`), `action`, `note`, `expect` (condition polled until true or timeout ⇒ `EXPECT_FAILED`), `timeoutMs`, `retries` (0–5), `optional` (template errors are recorded as `soft-failed` and the run continues; environment errors never are), `saveAs` (store the step result in `vars`), `appendTo` (add the step result to a list in `vars`: arrays are spread into it, so repeated pages build ONE flat list; `"appendTo": "all"` or `{"var": "all", "dedupeBy": "url"}` to skip items already in the list; the list starts as `[]`, so loop conditions may read it before the first append; a name cannot be both `saveAs` and `appendTo`), `screenshot` (true ⇒ screenshot after this step).

## Locators (`target`)

A list of candidates tried in order; the first that matches **exactly one visible element** wins. 0 matches ⇒ next; >1 ⇒ next. All fail ⇒ `LOCATOR_NOT_FOUND` or `LOCATOR_AMBIGUOUS`. The record stores every try and which candidate hit.

| candidate | example | stability |
|---|---|---|
| `testid` | `{ "testid": "post" }` (`data-testid`) | highest |
| `role` (+`name`) | `{ "role": "button", "name": "Post", "exact": true }` | high |
| `label` / `placeholder` | `{ "placeholder": "Search" }` | medium |
| `text` | `{ "text": "Latest", "exact": true }` | medium |
| `alt` / `title` | `{ "alt": "avatar" }` | medium |
| `css` | `{ "css": "article[role=article]" }` | low |
| `xpath` | `{ "xpath": "//article[1]" }` | lowest (warning) |

Modifiers on any candidate: `nth` (0-based, `-1` = last), `within` (a target to search inside), `visible` (default `true`), `frame` (CSS of an iframe), `exact`.

## Actions (21 atomic + 5 control flow)

| action | parameters | result (`saveAs`) |
|---|---|---|
| `goto` | `url`, `waitUntil` (`domcontentloaded`) | – |
| `back` | – | – |
| `click` | `target`, `button`, `clickCount` | – |
| `fill` | `target`, `value` | – |
| `type` | `target`, `text`, `delayMs`, `clear` | – |
| `press` | `key` (e.g. `Enter`, `Meta+A`), optional `target` | – |
| `hover` | `target` | – |
| `select` | `target`, `option` (string or list) | selected values |
| `check` | `target`, `checked` (default true) | state |
| `upload` | `target`, `files` | absolute paths |
| `waitFor` | one of `target` (+`state`: visible/hidden/attached/detached), `url`, `text`, `until` (condition) | – |
| `wait` | `ms` (number or `[min,max]`) | – |
| `scroll` | `target` (scroll into view, or scroll over it), `by` (px or `"page"`), `to` (`top`/`bottom`), `times` | – |
| `read` | `target`, and `fields` **or** `text`/`attr`/`pattern`/`as` | object or value |
| `queryAll` | `target`, `fields`, `limit` (200) | array |
| `collect` | `item`, `fields`, `dedupeBy`, `filter`, `until`, `limit`, `offset`, `maxScrolls` (required), `scrollBy`, `scrollWaitMs`, `stopAfterNoNew` (4) | array |
| `download` | `trigger` (target), `filename` | saved path |
| `runScript` | `script` (whitelisted name), `args` | script return value |
| `assert` | `that` (condition), `code` (error code, default `ASSERT_FAILED`), `message` | true |
| `handoff` | `reason`, `until` (condition) | – |
| `ask` | `question`, `data`, `answer` (`{type, options, min, max, schema, hint}`), `default` | the answer (see Breakpoints) |
| `if` | `when`, `then`, `else` | – |
| `forEach` | `in`, `as`, `do`, `max` (required), `continueOnError`, `collectFrom`, `flatten` | array built from `collectFrom`; with `flatten: true`, per-iteration arrays are joined into one list |
| `while` | `when`, `do`, `maxIterations` (required) | – |
| `group` | `steps` (retries / optional apply to the whole group) | – |
| `recipe` | `recipe` (library id, file path, or `./x.json` next to this file), `inputs` | the called recipe's output (`outputs.from`, else its variables) |

`recipe` runs another recipe on the same page, in the same run record: its own inputs, variables, `site`, defaults
and `startOn`; its steps get paths like `visit.go-next`. Its `ask` steps pause the whole run as usual. Calls are
checked by `validate` (recipe exists and is valid, required inputs given, no circles, at most 4 deep).

All clicks and typing are trusted CDP input events. With `humanize` the mouse moves on a curved path to a jittered point, keys have variable delays, wheel scrolling is chunked. `click` first runs Playwright's actionability checks (visible, stable, enabled, not covered) ⇒ otherwise `ELEMENT_NOT_ACTIONABLE`.

### Field specs (`fields` in read / queryAll / collect)

`{ "target": [...], "text": true | "attr": "href" | "html": true, "pattern": "regex (group 1 kept)", "as": "string|number|count|url|boolean", "optional": true, "default": 0, "all": true }`

- no `target` ⇒ the item itself; `all` ⇒ array of every match.
- `as: "count"` understands `1.2K`, `3,456`, `1.5万`, `2M`.
- A missing non-optional field drops the item (collect/queryAll) or fails the step (read).

### collect

Scroll-and-extract loop for infinite feeds: extract visible items → dedupe by `dedupeBy` → skip the first `offset` unique items → keep those passing `filter` (`{{item.x}}`) → stop when `limit` reached, `until` is true (`{{self}}` = kept list), the list ends (no new items `stopAfterNoNew` times at the bottom) or `maxScrolls`. The record shows `kept, scanned, filteredOut, dropped, scrolls, stoppedBecause`.

### Breakpoints (`ask`)

`ask` stops the recipe and hands a decision to **you, the agent** (the executor never calls a model). The browser
stays on the page; the run ends with `status: "paused"`, exit code `4`, and prints `ask: {question, answer, data, next}`.
Decide, then `browser-recipewright answer <runDir> --value '<JSON>'`: the same run continues from that exact step,
also inside loops.

```json
{ "id": "pick-relevant", "action": "ask",
  "question": "Which of these posts are really about {{inputs.topic}}?",
  "data": "{{vars.posts}}", "answer": { "type": "pick", "max": 10 }, "default": [], "saveAs": "relevant" }
```

| `answer.type` | answer you give | stored in `saveAs` |
|---|---|---|
| `text` (default) | any text | the text |
| `number` | `3` | number |
| `boolean` | `true` / `false` (`yes`/`no` ok) | boolean |
| `choice` | one of `answer.options` | that option |
| `pick` | item numbers from 0, e.g. `[0, 3]` (`min`/`max` limit the count) | **the picked items** of `data` |
| `json` | any JSON, checked against `answer.schema` | the JSON |

- Ask **once with the whole list** (`pick` over 30 posts) rather than once per item: one pause instead of 30.
- `default` is used by unattended runs (`batch`, `selfcheck`, `run --on-ask default`). It may be a reference.
  Without a default those runs fail with `ASK_UNANSWERED`.
- Use rules (`filter`, `if`) when the decision is mechanical (likes > 100); use `ask` when it needs judgment
  (is this relevant / spam / worth replying to / which button is right).

## References and conditions

`{{inputs.k}}`, `{{vars.k}}`, `{{account.id}}`, loop variable (`{{post.url}}`), `{{index}}` inside forEach, `{{item.k}}`/`{{self}}` in collect. A string that is exactly one reference keeps its type (array, number). Filters: `| urlencode | trim | number | lower | upper | length | json | flatten | compact` (`flatten` joins a list of lists one level deep; `compact` drops null items).

Conditions (one key each): `exists`/`notExists`/`visible`/`hidden` (target), `urlContains`, `urlMatches`, `textContains: [target, "text"]`, `eq ne gt gte lt lte contains matches: [a, b]`, `countGte countLte countEq: [list, n]`, `truthy`/`empty: value`, `and`/`or: [...]`, `not: {...}`.

## Run record

`~/.browser-recipewright/runs/<time>_<template>_<rand>/`

```
run.json        template, version, profile, inputs (secrets masked), status, error, duration
steps.jsonl     one line per executed step (loop steps once per round): seq, stepId, path (read-each[2].open-post),
                action, status (ok/failed/soft-failed/paused), durationMs, urlBefore/After, locator {tried, hit}, expect, attempts, output, error
state.json      variables after the last finished top-level step (used by --resume), answers given to ask steps
ask.json        only while paused at an ask step: question, answer format, data
output.json     final result
artifacts/      screenshots, downloads
failure/        dossier.json, screenshot.png, snapshot.txt, snapshot.refs.json   (only when failed)
```

## Error codes

| code | category | usual fix |
|---|---|---|
| `LOCATOR_NOT_FOUND` | template | new candidates from snapshot |
| `LOCATOR_AMBIGUOUS` | template | add `nth` / `within` |
| `ELEMENT_NOT_ACTIONABLE` | template | `waitFor`, or optional step closing a popup |
| `EXPECT_FAILED` | template | wrong element or wrong expect |
| `ACTION_TIMEOUT` | template | raise `timeoutMs`, wait for a better condition |
| `NAVIGATION_BLOCKED` | template | ask the human before adding a domain to `site` |
| `NAVIGATION_FAILED` | template | network / URL problem |
| `NOT_ENOUGH_RESULTS` | template | relax filter, raise `maxScrolls` |
| `OUTPUT_INVALID` | template | fix field extraction |
| `SCRIPT_REJECTED` | template | never bypass; human reviews the script |
| `ASSERT_FAILED` / custom | template | as designed |
| `START_PAGE_MISMATCH` | template | the fragment was started on the wrong page: run the one that leads there, or add `startOn.goto` |
| `ASK_UNANSWERED` | template | an `ask` step needs a `default` for unattended runs, or run with `--on-ask pause` |
| `ANSWER_INVALID` | – | your answer does not fit `answer.type`; the run stays paused, answer again |
| `LOGIN_REQUIRED` | env | human logs in (`browser-recipewright login`) |
| `CHALLENGE_DETECTED` | env | human solves it |
| `HANDOFF_REQUIRED` | env | human action needed in a non-interactive run |
| `BROWSER_ERROR` | env | `browser-recipewright doctor`, close the other Chrome using the profile |

## Static validation (`browser-recipewright validate`)

Errors: schema violations, unknown fields/actions, duplicate step ids or `saveAs`, undeclared inputs or variables not yet produced, unknown filters/conditions, loops without limits, `goto` outside `site`, non-whitelisted or modified scripts, optional `runScript`, missing targets.
Warnings: single or css/xpath-only locators, xpath, `goto`/`click` without `expect`, secret inputs with screenshots, big loops with no step gap, `collect` without `dedupeBy`, URL hosts built from variables.

## Pagination: one flat list across pages

Use `appendTo` inside the loop that turns pages. Do not `saveAs` each page and return the list of pages (that gives `[[...],[...]]`).

```json
{ "id": "pages", "action": "while", "maxIterations": 5,
  "when": { "countLte": ["{{vars.all}}", 29] },
  "do": [
    { "id": "grab", "action": "queryAll", "target": [{ "css": "tr.athing" }], "fields": { "title": { "target": [{ "css": ".titleline a" }], "text": true } },
      "appendTo": { "var": "all", "dedupeBy": "title" } },
    { "id": "next", "action": "click", "target": [{ "role": "link", "name": "More" }], "optional": true }
  ] }
```

Then `"outputs": { "from": "{{vars.all}}" }`. With `forEach` over page numbers you can instead set `collectFrom` + `"flatten": true`, or apply `| flatten` later.
