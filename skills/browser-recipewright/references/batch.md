# Multi-account batch

One template × many accounts × per-account parameters. Each job uses that account's own browser
profile and writes its own run record.

```json
{
  "name": "x-daily-read",
  "template": "example.com/search-results",
  "inputs": { "count": 5, "minLikes": 100 },
  "accounts": [
    { "id": "brand-a", "profile": "example.com/brand-a", "inputs": { "keyword": "coffee" } },
    { "id": "brand-b", "profile": "example.com/brand-b", "inputs": { "keyword": "tea" } }
  ],
  "jobs": [
    { "account": "brand-a", "inputs": { "keyword": "latte" } }
  ],
  "spacingMs": [60000, 180000],
  "caps": { "runsPerDay": 5, "runsPerHour": 2, "itemsPerDay": 200, "itemsPerHour": 60 },
  "capInput": "count",
  "parallel": 2,
  "onLoginRequired": "skip",
  "onChallenge": "stop",
  "headless": false
}
```

- `accounts` (or `accountsFile`: CSV with columns `id,profile,<input>...`). `profile` defaults to `<site>/<id>`.
- `jobs` (or `jobsFile`: CSV with `account,<input>...`). Without jobs: one job per account.
- Inputs merge: batch `inputs` < account `inputs` < job `inputs`.
- `spacingMs`: random pause between jobs (sequential: after the previous job ends; parallel: after the previous browser started).
- `caps` (per site+account, i.e. per profile; `accounts[].caps` override): `runsPerDay`, `runsPerHour`, `itemsPerDay`, `itemsPerHour`. "Items" = records a run returned. Usage is stored per profile in `usage/<site>__<account>.json` and counts every run of that profile (`run`, `batch`, `answer`), so a second batch the same day sees what the first one used. Jobs over a cap are `skipped_cap`. `dailyCapPerAccount: N` is short for `caps.runsPerDay: N`. See usage with `browser-recipewright accounts`.
- `capInput`: name of the recipe input that sets how many items to fetch (e.g. `count`); it is lowered so one run never goes past the item caps.
- `parallel` (1–8, default 1; or `--parallel N`): several browsers at once, each with its own profile. One profile never runs two jobs at the same time; its next job waits. Keep it low: every browser still uses human-like input and spacing.
- `dialogs`: `dismiss` (default) or `accept` for alert/confirm/prompt in every job.
- `onLoginRequired`: `skip` (default; job becomes `skipped_login` and is listed in `loginExpired`) or `handoff` (wait for a human).
- `onChallenge`: `stop` (default; the batch pauses so a human can look) or `skip`.

Commands:

```bash
browser-recipewright batch batch.json --dry-run          # show the job plan
browser-recipewright batch batch.json                    # run
browser-recipewright batch --resume ~/.browser-recipewright/batches/<dir>                  # continue; finished jobs are not repeated
browser-recipewright batch --resume ~/.browser-recipewright/batches/<dir> --retry-failed   # also rerun failed jobs
```

Batch folder: `batch.json` (with the frozen job plan), `results.jsonl` (one line per finished job),
`summary.json` + `summary.csv` (status per job, run folder, error code), and `merged.json` + `merged.csv`: every
account's output in one table, one row per item, with `_job`, `_account`, `_profile` columns first (CSV opens in Excel
with Chinese text intact).

Log each account in once beforehand: `browser-recipewright login example.com/search-results -p example.com/brand-a`.

Platforms forbid coordinated inauthentic behaviour. Use batches for accounts you legitimately operate
(e.g. several of your own stores or brands), keep spacing and caps conservative, and prefer read-only tasks.
