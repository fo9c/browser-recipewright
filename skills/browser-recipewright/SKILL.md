---
name: browser-recipewright
description: Automate websites in a real Chrome with reusable, reviewable JSON workflow templates. Use when the user wants to collect data from a site, repeat a browser task, run the same task for several accounts, or fix a browser automation that broke after a site redesign. Explore the page, write a template, validate, run, and repair only the failed step using the run record.
---

# browser-recipewright

You drive websites through the `browser-recipewright` CLI, like a practiced person would:
- **Routine work runs as recipes** (JSON templates): fixed fragments such as "search and collect 30 posts" or
  "open a post and read its comments". They replay with no model cost and a human can review them.
- **Judgment stays with you.** Between fragments you read what came back and decide what to run next. Inside a
  recipe, an `ask` step (breakpoint) stops and hands you the data to decide on.
- **New situations you handle live** with `act` (one step at a time). Every input, by a recipe or by you, goes
  through the same human-like mouse and keyboard layer and is recorded.
- **What works becomes a recipe or a flow.** Record live work in a task, then `task draft` it (section 6).

Repeatable work belongs in recipes: write, validate, run, read the run record. Do not redo a fixed sequence by
hand every time.

All commands print a JSON result on stdout and progress on stderr. Exit codes:
`0` ok · `1` template/step problem (you may fix it) · `2` invalid input/template · `3` environment problem (login, captcha, browser — hand to the human, do not edit the template) · `4` paused at a breakpoint: **you** must decide and `answer` (section 4b).

If `browser-recipewright` is not on PATH, use `npx browser-recipewright` (or `node <repo>/bin/browser-recipewright.js`). Run `browser-recipewright doctor` once if anything looks broken, and `browser-recipewright selfcheck` to confirm clicks, typing, scrolling and extraction work on this machine (local test page, no network).

## 0. Is there already a template?

```bash
browser-recipewright list                         # library: id, version, title, inputs
browser-recipewright show demo/local-feed       # read it before running
```
If one fits, skip to step 4.

## 1. Explore the page (only when writing or repairing)

```bash
browser-recipewright launch -p example.com/main --url "https://example.com/" # opens/reuses that account's Chrome
browser-recipewright snapshot -p example.com/main                              # outline with stable [ref=r…] ids
browser-recipewright snapshot -p example.com/main --json                       # same + locator candidates per ref
browser-recipewright screenshot -p example.com/main -o page.png [--full]       # look at the page yourself (PNG); act --screenshot does it after a step
browser-recipewright act click --ref rk3x9a -p example.com/main                # try ONE step, same semantics as a template step
browser-recipewright act fill --ref r5 --value "hello" -p example.com/main
browser-recipewright act read --ref r20 --fields '{"text":{"text":true}}' -p example.com/main
browser-recipewright act goto --url "https://example.com/search?q=ai" -p example.com/main
browser-recipewright act collect --step '{"item":[{"testid":"post"}],"fields":{...},"limit":5,"maxScrolls":3}' -p example.com/main
#   collect prints {count, items:[...], fieldsEmpty:{field: n}, stats:{scanned, filteredOut, scrolls, stoppedBecause}}
#   fieldsEmpty tells you which field locator is wrong before you put the step in a template
```
- Profiles are `<site>/<account>`; each is a separate Chrome user-data-dir with its own login.
- Without `-p` every command picks the profile the same way: a recipe → `<recipe site>/default`; `launch --url` → `<host>/default`; otherwise the only running browser; several running → `PROFILE_AMBIGUOUS` (pass `-p`); nothing running → `<url host>/default` or `default/default`. The picked profile is printed on stderr.
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
browser-recipewright run example.com/search -i keyword="AI agent" -i count=5 -p example.com/main
browser-recipewright run ./my-template.json --inputs '{"keyword":"rpa"}' --keep-open
```
- A window opens (the human can watch). If login or a captcha is needed, the run pauses and asks the human in the terminal, then continues by itself. In unattended runs pass `--no-handoff` and treat exit code 3 as "tell the human".
- Result JSON: `status`, `runDir`, `output` (path to output.json), `preview`, `error`, `dossier`.
- Save good templates: `browser-recipewright save ./my-template.json` (goes to `~/.browser-recipewright/templates`).

## 4b. Breakpoints: the recipe asks you to decide

A recipe can stop in the middle with an `ask` step when something needs judgment, not a rule: which posts are
really relevant, is this reply spam, which of these buttons is the right one. The executor never calls a model;
it hands the question to you. Exit code `4`, and the result looks like:

```json
{ "status": "paused", "runDir": "…", "ask": { "step": "pick-relevant", "question": "Which posts are about AI agents?",
  "answer": { "type": "pick", "max": 10 }, "data": [ { "#": 0, "title": "…" }, { "#": 1, "title": "…" } ], "next": "browser-recipewright answer … --value '<JSON>'" } }
```

Read `data`, decide yourself, and answer in the given format; the browser is still on that page and the same run
continues from that step (also inside loops), in the same run directory:

```bash
browser-recipewright answer <runDir> --value '[0, 3, 7]'   # pick: item numbers from 0 → the picked items are saved
browser-recipewright answer <runDir> --value true          # boolean · "more" for choice · 5 for number · JSON for json
browser-recipewright pending                               # every run waiting for an answer (after a restart, too)
```
- A wrong format is refused (`ANSWER_INVALID`, exit 2) and the run stays paused: answer again.
- The answer may lead to another pause (exit 4 again): keep answering until `success` / `failed`.
- Unattended runs (`batch`, `run --on-ask default`) use the step's `default`; give every `ask` a sensible one.
- When writing a recipe, put an `ask` where you would otherwise need to stop the recipe and look at the data
  yourself. Ask once with the whole list (`pick`) instead of once per item. See `references/template-format.md`.

## 5. When a run fails: repair ONE step

```bash
browser-recipewright heal <runDir>          # dossier: failed step, error code, locator tries, snapshot preview, last success, next commands
browser-recipewright inspect <runDir>       # every step: status, locator hit, duration
```
Decide by `error.category`:
- `env` (`LOGIN_REQUIRED`, `CHALLENGE_DETECTED`, `HANDOFF_REQUIRED`, `BROWSER_ERROR`): **do not edit the template.** Tell the human what to do, then `browser-recipewright run <template> --resume <runDir>`.
- `template`: read `failure/snapshot.txt` and `failure/snapshot.refs.json` (ready-made candidates), compare with `lastSuccess`, then write a patch that touches only the failed step id:

```json
{ "stepId": "collect-posts", "ops": [ { "op": "replace", "path": "/item", "value": [ { "testid": "post" }, { "role": "article" } ] } ], "note": "site renamed the item test id" }
```
Other forms: `{"stepId":"x","op":"merge","value":{...}}`, `"op":"replace"` (whole step), `"insertBefore"`, `"insertAfter"`, `"remove"`.

```bash
browser-recipewright patch <template> patch.json           # shows the diff, validates
browser-recipewright patch <template> patch.json --write   # version +1, old version kept in .history/
browser-recipewright run <template> --resume <runDir>      # skips finished steps and finished forEach items; works even if the run died before step 1
```
Show the human the diff and the verified result. Typical fixes per code are in `references/template-format.md` (error codes table).

A locator hit on a fallback candidate (`hit > 0` in steps.jsonl, `locatorDrift` in the dossier) is an early warning: suggest updating the first candidate before it breaks.

## 6. Working live: fragments, tasks and flows

A recipe does not have to be a whole job. Keep recipes small and fixed, and chain them yourself in one browser:

```bash
browser-recipewright task start find-agent-posts --gap 2000-6000   # record this job; human-like pause between steps
browser-recipewright launch -p example.com/main                     # one browser for the whole job (runs leave it open)
browser-recipewright run example.com/search-collect -i keyword="AI agent" -p example.com/main   # fragment 1
#   …read the output yourself, decide which posts matter…
browser-recipewright task note "posts 2, 5 and 9 are really about agents" --data '[2,5,9]'
browser-recipewright run example.com/read-post -i url="…" -p example.com/main                   # fragment 2, on the page it left
browser-recipewright act click --ref r7 -p example.com/main                                     # an unexpected popup: handle it live
browser-recipewright task show                                                                  # everything so far, in order
```
- Give each recipe a `startOn` (`{"when": <condition>, "goto": "…"}`): if the browser already shows the right page it
  starts right there, otherwise it opens `goto`, otherwise it fails with `START_PAGE_MISMATCH` (run the fragment that
  leads there first). A recipe without `startOn` runs from wherever the browser is.
- `act recipe --step '{"recipe":"example.com/read-post","inputs":{…}}' -p …` runs a fragment as one live step.
- When the same sequence has worked once or twice, save it:
  `browser-recipewright task draft --param keyword="AI agent" -o flow.json`. Act steps become recipe steps, recipe runs
  become `recipe` calls, your notes become `ask` breakpoints. Review the draft (ids, notes, `expect`, `startOn`, better
  question formats such as `pick`), then `validate` and `save` it. Next time run the flow and only answer its questions.
- A flow is a recipe with `"kind": "flow"` whose steps are mostly `{"action": "recipe", "recipe": "<id or ./file.json>",
  "inputs": {…}, "saveAs": "x"}` and `ask` steps. `validate` checks the called recipes too. Everything runs in one
  browser and one run record; a failure inside a called recipe points the dossier at that recipe.
- `task end` stops recording. Without a current task nothing is journaled.

## 7. Many accounts

Write a `batch.json` (see `references/batch.md`) and run `browser-recipewright batch batch.json`. Each account uses its own profile and gets its own run record; expired logins are skipped and listed; `--resume <batchDir>` never repeats finished jobs. Keep spacing and daily caps conservative and remind the human that platforms forbid coordinated inauthentic activity.

## Boundaries

- Only automate accounts and data the human is allowed to use; respect site terms and rate limits.
- No captcha solving, no credential harvesting, no mass posting. Passwords never go into templates (log in once by hand; the profile keeps the session).
- Headless mode is for tests; real sites should run with a window.
