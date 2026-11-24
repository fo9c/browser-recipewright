<div align="center">

# browser-recipewright

**The RPA built for AI agents: AI writes the recipe, the browser follows it.**

An AI explores a site once and writes a reusable *recipe*; a real Chrome replays it with human-like input and no model calls.<br>
Every step is recorded, and when a site changes only the failed step is repaired. Built for personal automation and data analysis.

[![CI](https://github.com/fo9c/browser-recipewright/actions/workflows/ci.yml/badge.svg)](https://github.com/fo9c/browser-recipewright/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 18.17](https://img.shields.io/badge/node-%3E%3D18.17-339933?logo=node.js&logoColor=white)](package.json)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skill-Claude%20Code%20%7C%20Codex%20%7C%20Cursor-8A63D2)](skills/browser-recipewright/SKILL.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[中文](README.md) · [Quick start](#quick-start) · [Examples](examples/) · [Changelog](CHANGELOG.md)

</div>

<!-- TODO: demo GIF docs/assets/demo.gif (explore -> recipe -> replay with live view) -->

```
  ① explore (AI reads the page, tries actions)  →  ② recipe (declarative JSON, validated, reviewable)  →  ③ replay (real Chrome, every step logged)
                                                          ▲                                                       │ site changed
                                                          └──────── ④ fix only the failed step (patch + resume) ◀──┘
```

## Validated so far

| Scenario | Result |
|---|---|
| X keyword search, read 5 posts + comments | **20 / 20** consecutive runs on a real account, no captcha (2026-11-23) |
| Browser fingerprint self-check (bot.sannysoft.com) | all checks pass |
| Boss Zhipin: read 30 job posts by city/industry, pick 3 (read-only) | passed (2026-11-24) |
| Automated tests | 13 unit + 12 end-to-end (real Chrome + offline demo site) on every CI run |

Measured in personal-automation use; this is not a claim that any site "cannot detect" it. See [responsible use](docs/responsible-use.md).

## How it compares

| | LLM-per-step browser agents | Classic RPA (record/replay) | Hand-written Playwright | **browser-recipewright** |
|---|---|---|---|---|
| Who writes the flow | nobody, reasoned live each run | a human records it | a developer codes it | **the AI, once; humans can review it** |
| Model cost on repeat runs | every step | none | none | **none (replay makes no model calls)** |
| Statically checkable, safe to share | no fixed flow | often proprietary | arbitrary code | **declarative JSON + schema, script whitelist** |
| When the site changes | re-reason live | re-record | edit code | **failure dossier + patch only the failed step** |
| API key needed by the tool | yes | no | no | **no (bring your own agent)** |

## Features

- **One template, three readers**: AI writes it, a human reviews it, the executor runs it. Declarative JSON (20 atomic actions + 4 control-flow), statically validated without a browser.
- **Real browser, low fingerprint**: your installed Google Chrome, clean launch flags (no `--enable-automation`), attached over CDP with [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright); page scripts run in an isolated world; trusted, humanized mouse/keyboard input; one Chrome profile per site/account.
- **Every step recorded**: one line per step (which locator candidate hit, timing, URLs, error code); on failure a dossier (screenshot, page snapshot with ready-made locators, last successful record, next commands).
- **Repair one step, not the whole flow**: the AI writes a patch scoped to the failed step id; `patch` shows the diff and bumps the version; `run --resume` replays from the failed step.
- **Humans handle login and captchas**: the run pauses, hands the window to you, and continues by itself. The AI never edits the template for environment problems and never bypasses captchas.
- **Multi-account batches**: accounts × template × per-account params, spacing, daily caps, skip expired logins, per-account records, resume.
- **Agent-agnostic**: ships as a Skill (`skills/browser-recipewright/SKILL.md`) around a CLI any agent can call.

## Quick start

```bash
git clone https://github.com/fo9c/browser-recipewright.git && cd browser-recipewright
npm install && npm link
browser-recipewright doctor
browser-recipewright demo                                   # offline demo against a bundled X-like feed
browser-recipewright login x.com/search-read-posts          # log in to X once in the window that opens
browser-recipewright run x.com/search-read-posts -i keyword="AI agent"
```

Claude Code: `ln -s "$(pwd)/skills/browser-recipewright" ~/.claude/skills/browser-recipewright`, then ask in plain language.

Docs: [template format](skills/browser-recipewright/references/template-format.md) · [batch](skills/browser-recipewright/references/batch.md) · [skill](skills/browser-recipewright/SKILL.md) · [architecture](docs/architecture.md)

## Roadmap

- [x] Recipe format v0, static validator, humanized executor, run records and failure dossiers
- [x] Step-scoped patches + resume, multi-account batches, Skill distribution
- [ ] Live view: mirrored page, event stream and data stream while a recipe runs, with replay
- [ ] Accessibility-tree-first locators with CSS/text fallback
- [ ] More read-only example recipes ([contributions welcome](CONTRIBUTING.md))
- [ ] npm release: `npx browser-recipewright`

## Contributing and safety

Issues and PRs are welcome, especially recipes: see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately per [SECURITY.md](SECURITY.md).
Use only with accounts and data you are allowed to use; respect site terms and rate limits ([responsible use](docs/responsible-use.md)).

Apache-2.0. Clean-room implementation.
