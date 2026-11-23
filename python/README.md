# browser-recipewright (Python helpers)

The engine is the Node CLI; this package just calls it and reads its JSON records.

```bash
pip install -e python/          # from the repo root
```

```python
from browser_recipewright import run, to_csv, flatten_posts
res = run("x.com/search-read-posts", {"keyword": "AI agent", "count": 3})
if res.ok:
    to_csv(flatten_posts(res.output), "posts.csv")
else:
    print(res.error)            # {"code": "LOGIN_REQUIRED", ...}
```

Export any finished run to an Excel-friendly CSV:

```bash
python -m browser_recipewright export ~/.browser-recipewright/runs/<runDir>       # writes <runDir>/output.csv
```
