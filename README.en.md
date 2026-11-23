# browser-recipewright

**AI writes the recipe, the browser follows it.**

An AI explores a site once and writes a reusable *recipe* (a declarative JSON workflow template). A real Chrome then follows it with human-like, low-signature input; every step is recorded, and when a site changes only the failed step is repaired. Built for personal automation and data collection/analysis.

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

Use only with accounts and data you are allowed to use; respect site terms. Apache-2.0. Clean-room implementation.
