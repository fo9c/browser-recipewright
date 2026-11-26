<div align="center">

# browser-recipewright

### AI writes the recipe, the browser follows it

**The RPA built for AI agents: routine work runs as recipes, judgment goes to the AI, and every step is recorded.**

[![CI](https://github.com/fo9c/browser-recipewright/actions/workflows/ci.yml/badge.svg)](https://github.com/fo9c/browser-recipewright/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 18.17](https://img.shields.io/badge/node-%3E%3D18.17-339933?logo=node.js&logoColor=white)](package.json)

[中文](README.md) · [Quick start](#-quick-start) · [Skill](skills/browser-recipewright/SKILL.md) · [Changelog](CHANGELOG.md)

</div>

---

## 💡 What it is

You tell your agent: "open this site, search for a keyword, and put the results that really matter in a table."

- **The AI explores the page once** and writes what can be fixed down as a JSON **recipe** (e.g. "search and collect 30 results").
- **Then the browser follows the recipe**: your own Chrome, human-like mouse and keyboard, **no model calls**.
- **Where judgment is needed, it stops and asks the AI**: a recipe can contain a **breakpoint** that hands data to the agent ("which of these 30 are relevant?"), then continues.
- **Every step is recorded**: when a site changes, the AI reads the failure and **repairs only the failed step**.

It is not one rigid end-to-end flow. Recipes are **reusable fixed fragments** that the agent calls live, deciding what to run next from what came back; combinations that work can be saved as a flow. Built for **personal automation and data analysis**.

```
your request
   │
   ▼
agent (Claude Code, …) orchestrates live and makes the calls
   │
   ├─▶ fragment A: search and collect 30     recipe, replayed, no model calls
   ├─▶ ⏸ breakpoint: which are relevant?     data handed to the AI, then continues
   ├─▶ fragment B: open each and read it     recipe, replayed, no model calls
   │
   ▼
table / CSV          every step recorded; on a site change fix only the failed step
```

## ✨ Highlights

| | What it means |
|---|---|
| ⚡ **Efficient** | repeat runs make no model calls; several fragments run back to back in one browser; batches can run several browsers at once |
| 🧭 **Practical** | declarative JSON validated before running; logins and captchas go to a human; failures come with a dossier so the AI fixes one step |
| 🧠 **AI in the middle** | `ask` breakpoints hand data to the agent; the executor itself never calls a model and needs no API key |
| 👀 **Every step visible** | each run writes one standard event stream that any read-only viewer plugin can replay |

## 🚀 Quick start

```bash
git clone https://github.com/fo9c/browser-recipewright.git
cd browser-recipewright
npm install && npm link

browser-recipewright doctor      # check Node, Chrome, data folder
browser-recipewright selfcheck   # run every core browser action on the bundled local test page
browser-recipewright demo        # offline demo: search a generated feed and read posts
```

Needs Google Chrome and Node.js 18.17+. Claude Code: `ln -s "$(pwd)/skills/browser-recipewright" ~/.claude/skills/browser-recipewright`, then ask in plain language. Other agents that can run shell commands: put [`SKILL.md`](skills/browser-recipewright/SKILL.md) into their system prompt or rules.

## 🧩 What you get

- **Recipes**: 21 actions (goto, click, type, select, scroll, collect, download, assert, …) plus `if` / `forEach` / `while` / `group` / `recipe`. `validate` checks references, loop limits, site domains and the script whitelist without a browser. `startOn` lets a recipe start in place when the browser is already on the right page.
- **Breakpoints**: an `ask` step pauses the run (exit code `4`) with the browser left on the page; the agent replies with `answer <runDir> --value ...` and the same run continues. Answer types `text` `number` `boolean` `choice` `pick` `json`; unattended runs use the step's `default`. `pending` lists waiting runs.
- **Flows and task drafts**: a `recipe` step calls another recipe in the same browser and run record; a flow is recipe calls plus `ask` breakpoints. New situations are handled live with `act`; `task start` records acts, runs, answers and decisions, and `task draft` turns them into a recipe or flow draft.
- **Real browser, human-like input**: your installed Chrome with clean launch flags, attached over CDP with [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright); trusted mouse moves along a path and re-aims before pressing, typing with varied rhythm, focus restored if stolen, full speed even when the window is hidden. Logins and captchas pause and go to you; captchas are never bypassed.
- **Isolated profiles**: one Chrome user-data-dir per `<site>/<account>`, separate from your everyday Chrome. One rule picks the profile when `-p` is omitted. `login` lets you log in once by hand (default); optional `import-login` copies one site's cookies from your own Chrome, which is only read, never attached to.
- **Multi-account batches**: accounts × recipe × per-account params, spacing, skip expired logins, resume; `"parallel": N` browsers at once; results merged into `merged.json` / `merged.csv`; `"remindAfter": N` only warns, never blocks.
- **Records and repair**: one record per step (locator hit, timing, URL, error code) and a failure dossier; `heal` → step-scoped patch → `patch` shows the diff → `run --resume` continues from the failed step.

## 📖 Commands

All commands print JSON on stdout and progress on stderr; see `browser-recipewright <command> --help`.

| Purpose | Commands |
|---|---|
| Setup and self-check | `doctor` · `selfcheck` · `demo` · `demo-server` |
| Browsers and accounts | `launch` · `close` · `sessions` · `login` · `import-login` (optional) · `accounts` |
| Live exploration | `snapshot` · `act` · `screenshot` |
| Recipes | `validate` · `run` · `list` · `show` · `save` · `schema` |
| Breakpoints | `answer` · `pending` |
| Task records | `task start / note / show / list / end / draft` |
| Batches | `batch` (`--parallel`, `--resume`, `--dry-run`) |
| Records and repair | `runs` · `inspect` · `events` · `check-run` · `heal` · `patch` |

Exit codes: `0` ok · `1` recipe/step problem · `2` invalid input or recipe · `3` environment (login, captcha, browser) · `4` paused at a breakpoint.

## 👀 Run data and viewers

Every run writes `runs/<id>/events.jsonl` (steps, loop progress, extracted data, navigation, mouse paths, breakpoints, human takeovers), `run.json` and `output.json` in one documented format. Visualization is **not bundled**: it is meant as separately downloadable read-only plugins that read these files (`events --follow` streams a live run, `check-run` validates the format). A full viewer is still in progress; a zero-dependency [terminal timeline example](examples/viewer-plugin-minimal) is included. Spec: [docs/run-data-format.md](docs/run-data-format.md).

## 📚 Docs

[Template format](skills/browser-recipewright/references/template-format.md) · [Batches](skills/browser-recipewright/references/batch.md) · [Skill](skills/browser-recipewright/SKILL.md) · [Architecture](docs/architecture.md) · [Run data format](docs/run-data-format.md) · [Responsible use](docs/responsible-use.md) · [Python helpers](python/README.md)

## 🗺️ Roadmap

- [x] Declarative recipes, static validator, humanized executor, run records and failure dossiers
- [x] Step-scoped patches + resume, multi-account batches, Skill distribution
- [x] Breakpoints (`ask`), fragment orchestration, flows, task records → recipe drafts
- [x] One default-profile rule, parallel batches, merged result table, usage reminders, optional login import
- [ ] Separately downloadable viewer plugin: live page, event and data streams, replay
- [ ] npm release: `npx browser-recipewright`

## 🤝 Contributing and safety

Issues and PRs are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately per [SECURITY.md](SECURITY.md).
Use only with accounts and data you are allowed to use; respect site terms and request rates ([responsible use](docs/responsible-use.md)).

Apache-2.0. Depends on patchright / Playwright (Apache-2.0). Clean-room implementation.
