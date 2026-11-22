"""Thin Python helpers around the browser-rpa CLI.

    from browser_rpa import run, load_run, to_csv
    res = run("x.com/search-read-posts", {"keyword": "AI agent", "count": 3})
    rows = res.output            # list of dicts from output.json
    to_csv(rows, "posts.csv")    # nested values are JSON-encoded
"""
from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

__all__ = ["run", "batch", "load_run", "list_runs", "to_csv", "flatten_posts", "RunResult", "BrowserRpaError"]


class BrowserRpaError(RuntimeError):
    def __init__(self, code: str, message: str, result: dict | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.result = result or {}


@dataclass
class RunResult:
    status: str
    run_dir: Path | None
    output: Any
    error: dict | None
    raw: dict = field(repr=False, default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "success"


def _cmd() -> list[str]:
    exe = os.environ.get("BROWSER_RPA_BIN") or shutil.which("browser-rpa")
    if exe:
        return [exe]
    repo_bin = Path(__file__).resolve().parents[2] / "bin" / "browser-rpa.js"
    if repo_bin.exists():
        return ["node", str(repo_bin)]
    return ["npx", "browser-rpa"]


def _call(args: list[str]) -> tuple[int, dict]:
    p = subprocess.run(_cmd() + args, capture_output=True, text=True)
    try:
        data = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise BrowserRpaError("CLI_ERROR", (p.stderr or p.stdout).strip()[-2000:])
    return p.returncode, data


def run(template: str, inputs: dict | None = None, profile: str | None = None, *, headless: bool = False,
        handoff: bool = True, resume: str | None = None, raise_on_error: bool = False) -> RunResult:
    """Run a template and return its output (parsed output.json)."""
    args = ["run", template]
    if inputs:
        args += ["--inputs", json.dumps(inputs, ensure_ascii=False)]
    if profile:
        args += ["-p", profile]
    if headless:
        args.append("--headless")
    if not handoff:
        args.append("--no-handoff")
    if resume:
        args += ["--resume", resume]
    _, data = _call(args)
    run_dir = Path(data["runDir"]) if data.get("runDir") else None
    output = None
    if data.get("output") and Path(data["output"]).exists():
        output = json.loads(Path(data["output"]).read_text(encoding="utf-8"))
    res = RunResult(data.get("status", "error"), run_dir, output, data.get("error"), data)
    if raise_on_error and not res.ok:
        err = res.error or {}
        raise BrowserRpaError(err.get("code", "ERROR"), err.get("message", ""), data)
    return res


def batch(batch_file: str | None = None, resume: str | None = None, retry_failed: bool = False) -> dict:
    args = ["batch"] + ([batch_file] if batch_file else []) + (["--resume", resume] if resume else [])
    if retry_failed:
        args.append("--retry-failed")
    return _call(args)[1]


def load_run(run_dir: str | Path) -> dict:
    """run.json + steps (list) + output for a run folder."""
    d = Path(run_dir)
    steps_file = d / "steps.jsonl"
    steps = [json.loads(l) for l in steps_file.read_text(encoding="utf-8").splitlines() if l.strip()] if steps_file.exists() else []
    out = d / "output.json"
    dossier = d / "failure" / "dossier.json"
    return {
        "run": json.loads((d / "run.json").read_text(encoding="utf-8")),
        "steps": steps,
        "output": json.loads(out.read_text(encoding="utf-8")) if out.exists() else None,
        "dossier": json.loads(dossier.read_text(encoding="utf-8")) if dossier.exists() else None,
    }


def list_runs(limit: int = 20, template: str | None = None) -> list[dict]:
    return _call(["runs", "-n", str(limit)] + (["-t", template] if template else []))[1].get("runs", [])


def flatten_posts(details: Iterable[dict]) -> list[dict]:
    """For x.com/search-read-posts output: one row per post with reply texts joined."""
    rows = []
    for d in details:
        post, main, replies = d.get("post") or {}, d.get("main") or {}, d.get("replies") or []
        rows.append({
            "url": "https://x.com" + post.get("url", ""),
            "author": post.get("author"),
            "likes": post.get("likes"),
            "time": main.get("time") or post.get("time"),
            "text": main.get("text") or post.get("text"),
            "reply_count": len(replies),
            "replies": "\n---\n".join((r.get("text") or "") for r in replies),
            "error": (d.get("_error") or {}).get("code"),
        })
    return rows


def to_csv(rows: Iterable[dict], path: str | Path) -> Path:
    rows = list(rows)
    cols: list[str] = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    p = Path(path)
    with p.open("w", newline="", encoding="utf-8-sig") as f:  # utf-8-sig so Excel shows Chinese correctly
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for k, v in r.items()})
    return p
