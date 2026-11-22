"""python -m browser_rpa export <runDir> [out.csv]  — export a run's output to CSV (Excel-friendly)."""
import sys
from pathlib import Path
from . import load_run, to_csv, flatten_posts


def main() -> None:
    if len(sys.argv) < 3 or sys.argv[1] != "export":
        print(__doc__)
        sys.exit(2)
    run_dir = Path(sys.argv[2])
    data = load_run(run_dir)
    out = data["output"] or []
    rows = flatten_posts(out) if out and isinstance(out, list) and isinstance(out[0], dict) and "post" in out[0] else out
    dest = Path(sys.argv[3]) if len(sys.argv) > 3 else run_dir / "output.csv"
    to_csv(rows if isinstance(rows, list) else [rows], dest)
    print(dest)


if __name__ == "__main__":
    main()
