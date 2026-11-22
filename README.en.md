# browser-rpa

**Browser RPA for AI agents: turn a web task into a reviewable, replayable, self-repairable JSON workflow template.**

- **One template, three readers**: AI writes it, a human reviews it, the executor runs it. Declarative JSON (20 atomic actions + 4 control-flow), statically validated without a browser.
- **Real browser, low fingerprint**: your installed Google Chrome, clean launch flags (no `--enable-automation`), attached over CDP with [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright); page scripts run in an isolated world; trusted, humanized mouse/keyboard input; one Chrome profile per site/account.
- **Every step recorded**: one line per step (which locator candidate hit, timing, URLs, error code); on failure a dossier (screenshot, page snapshot with ready-made locators, last successful record, next commands).
- **Repair one step, not the whole flow**: the AI writes a patch scoped to the failed step id; `patch` shows the diff and bumps the version; `run --resume` replays from the failed step.
- **Humans handle login and captchas**: the run pauses, hands the window to you, and continues by itself. The AI never edits the template for environment problems and never bypasses captchas.
- **Multi-account batches**: accounts × template × per-account params, spacing, daily caps, skip expired logins, per-account records, resume.
- **Agent-agnostic**: ships as a Skill (`skills/browser-rpa/SKILL.md`) around a CLI any agent can call.

## Quick start

```bash
git clone https://github.com/fo9c/browser-rpa.git && cd browser-rpa
npm install && npm link
browser-rpa doctor
browser-rpa demo                                   # offline demo against a bundled X-like feed
browser-rpa login x.com/search-read-posts          # log in to X once in the window that opens
browser-rpa run x.com/search-read-posts -i keyword="AI agent"
```

Claude Code: `ln -s "$(pwd)/skills/browser-rpa" ~/.claude/skills/browser-rpa`, then ask in plain language.

Docs: [template format](skills/browser-rpa/references/template-format.md) · [batch](skills/browser-rpa/references/batch.md) · [skill](skills/browser-rpa/SKILL.md) · [architecture](docs/architecture.md)

Use only with accounts and data you are allowed to use; respect site terms. Apache-2.0. Clean-room implementation.
