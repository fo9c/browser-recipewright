# Minimal viewer plugin

A 90-line, zero-dependency example of a **viewer plugin**: a separate program that reads the
[run data format](../../docs/run-data-format.md) and shows the run. This one prints a text timeline in the
terminal; a graphical viewer reads exactly the same files and is free to look however it likes.

```bash
node examples/viewer-plugin-minimal/viewer.mjs            # follow the newest run, live
node examples/viewer-plugin-minimal/viewer.mjs <runDir>   # replay one run
```

```
   0.0s ▶ demo/local-feed@0.1.0  (5 top-level steps)
   0.0s   → open (goto)
   0.4s   ⌂ http://127.0.0.1:4417/search.html
   0.4s   ✓ open 412ms
   0.5s   → collect-posts (collect)
   1.9s   ◆ +3 posts
   ...
  12.3s ■ success  12301ms  → output.json
```

It is not shipped in the npm package and nothing in browser-recipewright depends on it.
