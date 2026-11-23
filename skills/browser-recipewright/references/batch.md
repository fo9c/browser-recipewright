# Multi-account batch

One template × many accounts × per-account parameters. Each job uses that account's own browser
profile and writes its own run record.

```json
{
  "name": "x-daily-read",
  "template": "x.com/search-read-posts",
  "inputs": { "count": 5, "minLikes": 100 },
  "accounts": [
    { "id": "brand-a", "profile": "x.com/brand-a", "inputs": { "keyword": "coffee" } },
    { "id": "brand-b", "profile": "x.com/brand-b", "inputs": { "keyword": "tea" } }
  ],
  "jobs": [
    { "account": "brand-a", "inputs": { "keyword": "latte" } }
  ],
  "spacingMs": [60000, 180000],
  "dailyCapPerAccount": 5,
  "onLoginRequired": "skip",
  "onChallenge": "stop",
  "headless": false
}
```

- `accounts` (or `accountsFile`: CSV with columns `id,profile,<input>...`). `profile` defaults to `<site>/<id>`.
- `jobs` (or `jobsFile`: CSV with `account,<input>...`). Without jobs: one job per account.
- Inputs merge: batch `inputs` < account `inputs` < job `inputs`.
- `spacingMs`: random pause between jobs. `dailyCapPerAccount`: jobs over the cap are `skipped_cap`.
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
`summary.json` + `summary.csv` (status per job, run folder, error code).

Log each account in once beforehand: `browser-recipewright login x.com/search-read-posts -p x.com/brand-a`.

Platforms forbid coordinated inauthentic behaviour. Use batches for accounts you legitimately operate
(e.g. several of your own stores or brands), keep spacing and caps conservative, and prefer read-only tasks.
