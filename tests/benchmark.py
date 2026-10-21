#!/usr/bin/env python3
"""
Benchmark delle tre implementazioni CLI di remove-pdf-bg (Python, Java, TypeScript).

Per ogni PDF di input esegue ogni tool con gli stessi argomenti e misura:
  - tempo totale di processo (avvio -> exit), che include l'avvio del runtime;
  - dimensione e numero pagine del PDF prodotto;
  - i conteggi riportati dallo strumento ("Immagini rimosse" / "Immagini individuate").

Prerequisiti:
    - il jar Java compilato in java-cli/target/remove-pdf-bg.jar
      (mvn -f java-cli/pom.xml package)
    - la CLI TypeScript compilata in ts-cli/dist/remove-pdf-bg.js
      (cd ts-cli && npm install && npm run build)
    - pymupdf (pip install pymupdf)

Uso:
    python tests/benchmark.py test.pdf
    python tests/benchmark.py *.pdf --runs 5
    python tests/benchmark.py test.pdf --no-warmup --timeout 600
"""

from __future__ import annotations

import argparse
import re
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:  # PyMuPDF < 1.24.3
    import fitz

REPO = Path(__file__).resolve().parent.parent
TOOLS: dict[str, list[str]] = {
    "python": [sys.executable, str(REPO / "python-cli" / "remove-pdf-bg.py")],
    "java": ["java", "-jar", str(REPO / "java-cli" / "target" / "remove-pdf-bg.jar")],
    "typescript": ["node", str(REPO / "ts-cli" / "dist" / "remove-pdf-bg.js")],
}

COUNT_RE = re.compile(r"Immagini (rimosse|individuate):\s*(\d+)")
PAGES_RE = re.compile(r"su (\d+) pagine")


def version_of(name: str) -> str:
    cmd = {
        "python": [sys.executable, "-V"],
        "java": ["java", "-version"],
        "typescript": ["node", "-v"],
    }[name]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (proc.stdout or proc.stderr or "").strip().splitlines()
    return out[0] if out else "?"


def tool_overhead(name: str) -> float:
    """Tempo di avvio del runtime, senza lavoro utile."""
    cmd = {
        "python": [sys.executable, "-c", "pass"],
        "java": ["java", "-version"],
        "typescript": ["node", "-e", "0"],
    }[name]
    start = time.perf_counter()
    subprocess.run(cmd, capture_output=True)
    return time.perf_counter() - start


def run_once(cmd: list[str], src: Path, out: Path, timeout: float) -> tuple[float, int, int]:
    start = time.perf_counter()
    proc = subprocess.run(
        cmd + [str(src), "-o", str(out)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    elapsed = time.perf_counter() - start
    if proc.returncode != 0:
        raise RuntimeError(f"exit {proc.returncode}: {proc.stderr.strip()[:300]}")
    removed = 0
    m = COUNT_RE.search(proc.stdout)
    if m:
        removed = int(m.group(2))
    pages = 0
    m = PAGES_RE.search(proc.stdout)
    if m:
        pages = int(m.group(1))
    return elapsed, removed, pages


def pdf_info(path: Path) -> tuple[int, int]:
    if not path.exists():
        return 0, 0
    doc = fitz.open(path)
    try:
        return len(doc), path.stat().st_size
    finally:
        doc.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("inputs", nargs="+", type=Path, help="PDF di input")
    ap.add_argument("--runs", type=int, default=3, help="ripetizioni per tool (default: 3)")
    ap.add_argument("--timeout", type=float, default=900.0, help="timeout per run in secondi")
    ap.add_argument("--no-warmup", action="store_true", help="non eseguire il warm-up")
    args = ap.parse_args()

    print("Versioni: " + " | ".join(f"{n}: {version_of(n)}" for n in TOOLS))
    print()

    for src in args.inputs:
        src = src.resolve()
        print(f"=== {src.name} ({src.stat().st_size / 1e6:.1f} MB) ===")
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            for name, cmd in TOOLS.items():
                if not args.no_warmup:
                    run_once(cmd, src, out_dir / "warmup.pdf", args.timeout)
                times: list[float] = []
                removed = pages = 0
                out_file = out_dir / f"{name}.pdf"
                for _ in range(args.runs):
                    elapsed, removed, pages = run_once(cmd, src, out_file, args.timeout)
                    times.append(elapsed)
                n_pages, size = pdf_info(out_file)
                print(
                    f"  {name:<11} min {min(times):7.2f}s  mediana {statistics.median(times):7.2f}s"
                    f"  max {max(times):7.2f}s | output {n_pages} pagine, {size / 1e6:6.1f} MB"
                    f" | rimosse {removed} su {pages} pagine"
                )
        print()

    print("--- avvio runtime (senza lavoro utile) ---")
    for name in TOOLS:
        print(f"  {name:<11} {tool_overhead(name):.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
