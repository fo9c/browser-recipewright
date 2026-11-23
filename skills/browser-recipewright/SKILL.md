---
name: browser-recipewright
description: Automate websites in a real Chrome with reusable, reviewable JSON workflow templates. Use when the user wants to collect data from a site, repeat a browser task, run the same task for several accounts, or fix a browser automation that broke after a site redesign. Explore the page, write a template, validate, run, and repair only the failed step using the run record.
---

# browser-recipewright

You drive websites through the `browser-recipewright` CLI. Do not click around ad hoc for repeatable work:
**turn the task into a template (JSON), validate it, run it, and read the run record.**
Templates are deterministic, cheap to replay, and a human can review them.

All commands print a JSON result on stdout and progress on stderr. Exit codes:
`0` ok · `1` template/step problem (you may fix it) · `2` invalid input/template · `3` environment problem (login, captcha, browser — hand to the human, do not edit the template).

If `browser-recipewright` is not on PATH, use `npx browser-recipewright` (or `node <repo>/bin/browser-recipewright.js`). Run `browser-recipewright doctor` once if anything looks broken.

## 0. Is there already a template?

```bash
browser-recipewright list                         # library: id, version, title, inputs
browser-recipewright show x.com/search-read-posts # read it before running
```
If one fits, skip to step 4.

## 1. Explore the page (only when writing or repairing)

```bash
browser-recipewright launch -p x.com/main --url "https://x.com/home"   # opens/reuses that account's Chrome
browser-recipewright snapshot -p x.com/main                              # outline with [ref=rN]
browser-recipewright snapshot -p x.com/main --json                       # same + locator candidates per ref
browser-recipewright screenshot -p x.com/main -o page.png [--full]       # look at the page yourself (PNG); act --screenshot does it after a step
browser-recipewright act click --ref r12 -p x.com/main                   # try ONE step, same semantics as a template step
browser-recipewright act fill --ref r5 --value "hello" -p x.com/main
browser-recipewright act read --ref r20 --fields '{"text":{"text":true}}' -p x.com/main
browser-recipewright act goto --url "https://x.com/search?q=ai" -p x.com/main
browser-recipewright act collect --step '{"item":[{"testid":"tweet"}],"fields":{...},"limit":5,"maxScrolls":3}' -p x.com/main
#   collect prints {count, items:[...], fieldsEmpty:{field: n}, stats:{scanned, filteredOut, scrolls, stoppedBecause}}
#   fieldsEmpty tells you which field locator is wrong before you put the step in a template
```
- Profiles are `<site>/<account>`; each is a separate Chrome user-data-dir with its own login.
- `snapshot --json` gives, for each ref, candidates already checked to match exactly one element. Copy them into `target`.
- Prefer navigating by URL (`goto` with `{{inputs.x | urlencode}}`) over typing into search boxes: fewer steps, more stable.
- If you see a login wall or captcha: stop and ask the human (`browser-recipewright login <template> -p <profile>`; if the template's URL uses inputs, pass them: `-i base=...`). Never try to bypass a captcha.

## 2. Write the template

Read `references/template-format.md` before writing your first template. Essentials:

```json
{
  "id": "site.com/task-name", "version": "0.1.0", "title": "one line for humans and search",
  "site": ["site.com"],
  "account": { "checkUrl": "https://site.com/home", "loginCheck": { "exists": [{ "testid": "avatar" }] } },
  "inputs": { "keyword": { "type": "string" }, "count": { "type": "integer", "default": 5 } },
  "defaults": { "timeoutMs": 15000, "stepGapMs": [400, 1200], "humanize": true },
  "steps": [
    { "id": "open", "action": "goto", "url": "https://site.com/search?q={{inputs.keyword | urlencode}}",
      "expect": { "exists": [{ "testid": "result" }, { "css": "article" }] } },
    { "id": "collect", "action": "collect", "item": [{ "testid": "result" }, { "css": "article" }],
      "fields": { "url": { "target": [{ "css": "a" }], "attr": "href" }, "title": { "target": [{ "css": "h2" }], "text": true } },
      "dedupeBy": "url", "limit": "{{inputs.count}}", "maxScrolls": 30, "saveAs": "items" }
  ],
  "outputs": { "from": "{{vars.items}}", "schema": { "type": "array", "minItems": 1 } }
}
```
Rules that matter:
- Every step has a unique `id` (short English, kebab-case) and ideally a `note`.
- `target` is a list of candidates, most stable first: `testid` > `role`+`name` > `label`/`placeholder` > `text` > `css` > `xpath`. Give 2+.
- Add `expect` to every `goto`/`click` so failures surface at the right step.
- Infinite feeds: use `collect` (scrolls and extracts as it goes; feeds remove off-screen items). Never `while`+`queryAll`.
- Loops need limits (`forEach.max`, `while.maxIterations`, `collect.maxScrolls`).
- References: `{{inputs.x}}`, `{{vars.x}}` (from an earlier `saveAs`), `{{item.x}}` (collect filter), loop variable (`forEach.as`), `{{self}}` (collect until). Filters: `urlencode trim number lower upper length json flatten compact`. Paging: put `"appendTo": {"var": "all", "dedupeBy": "url"}` on the step that reads each page, so all pages end up in ONE flat list `{{vars.all}}` (see template-format.md, Pagination). No arbitrary expressions.
- Conditions are objects: `exists notExists visible hidden urlContains urlMatches textContains eq ne gt gte lt lte contains matches and or not countGte countLte countEq truthy empty`.
- Page JavaScript only via `runScript` with a whitelisted script (see `browser-recipewright` `scripts/manifest.json`). Never ask to disable the whitelist.
- Read-only by default. Anything that posts, buys, deletes or messages needs the human's explicit OK first.

## 3. Validate (mandatory)

```bash
browser-recipewright validate ./my-template.json
```
Fix every error (each has a step id and field path). Warnings are advice. Do not run an invalid template.

## 4. Run

```bash
browser-recipewright run x.com/search-read-posts -i keyword="AI agent" -i count=5 -p x.com/main
browser-recipewright run ./my-template.json --inputs '{"keyword":"rpa"}' --keep-open
```
- A window opens (the human can watch). If login or a captcha is needed, the run pauses and asks the human in the terminal, then continues by itself. In unattended runs pass `--no-handoff` and treat exit code 3 as "tell the human".
- Result JSON: `status`, `runDir`, `output` (path to output.json), `preview`, `error`, `dossier`.
- Save good templates: `browser-recipewright save ./my-template.json` (goes to `~/.browser-recipewright/templates`).

## 5. When a run fails: repair ONE step

```bash
browser-recipewright heal <runDir>          # dossier: failed step, error code, locator tries, snapshot preview, last success, next commands
browser-recipewright inspect <runDir>       # every step: status, locator hit, duration
```
Decide by `error.category`:
- `env` (`LOGIN_REQUIRED`, `CHALLENGE_DETECTED`, `HANDOFF_REQUIRED`, `BROWSER_ERROR`): **do not edit the template.** Tell the human what to do, then `browser-recipewright run <template> --resume <runDir>`.
- `template`: read `failure/snapshot.txt` and `failure/snapshot.refs.json` (ready-made candidates), compare with `lastSuccess`, then write a patch that touches only the failed step id:

```json
{ "stepId": "collect-posts", "ops": [ { "op": "replace", "path": "/item", "value": [ { "testid": "tweet" }, { "role": "article" } ] } ], "note": "site renamed the item test id" }
```
Other forms: `{"stepId":"x","op":"merge","value":{...}}`, `"op":"replace"` (whole step), `"insertBefore"`, `"insertAfter"`, `"remove"`.

```bash
browser-recipewright patch <template> patch.json           # shows the diff, validates
browser-recipewright patch <template> patch.json --write   # version +1, old version kept in .history/
browser-recipewright run <template> --resume <runDir>      # skips finished steps and finished forEach items; works even if the run died before step 1
```
Show the human the diff and the verified result. Typical fixes per code are in `references/template-format.md` (error codes table).

A locator hit on a fallback candidate (`hit > 0` in steps.jsonl, `locatorDrift` in the dossier) is an early warning: suggest updating the first candidate before it breaks.

## 6. Many accounts

Write a `batch.json` (see `references/batch.md`) and run `browser-recipewright batch batch.json`. Each account uses its own profile and gets its own run record; expired logins are skipped and listed; `--resume <batchDir>` never repeats finished jobs. Keep spacing and daily caps conservative and remind the human that platforms forbid coordinated inauthentic activity.

## Boundaries

- Only automate accounts and data the human is allowed to use; respect site terms and rate limits.
- No captcha solving, no credential harvesting, no mass posting. Passwords never go into templates (log in once by hand; the profile keeps the session).
- Headless mode is for tests; real sites should run with a window.
