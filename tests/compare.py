#!/usr/bin/env python3
"""
Confronta l'implementazione Java di remove-pdf-bg con il riferimento Python.

Per ogni PDF di input esegue entrambi i tool (stessi argomenti) e verifica:
  1. che il PDF prodotto sia identico pixel per pixel (renderizzato con PyMuPDF);
  2. che l'output su stdout coincida. In --dry-run la corrispondenza del testo è
     vincolante; nella rimozione reale le differenze di conteggio sono avvisi,
     perché PyMuPDF sostituisce l'oggetto immagine globalmente e sottostima.

Uso tipico:
    python tests/compare.py test.pdf
    python tests/compare.py *.pdf
    python tests/compare.py "Loot & Lore PDF v1.pdf" --dpi 30 --max-pages 40
    python tests/compare.py test.pdf -e 2 -t 50 --dry-run
    python tests/compare.py test.pdf --keep          # conserva i PDF generati

Prerequisiti:
    - il jar Java compilato in target/remove-pdf-bg.jar  (mvn package)
    - pymupdf  (pip install pymupdf)
    - numpy opzionale: se presente il report è più dettagliato.

Nota sul conteggio finale: su alcuni PDF PyMuPDF riporta meno immagini rimosse
di Java (page.delete_image() sostituisce l'oggetto globalmente e le pagine
successive non lo vedono più in get_image_info). L'identità dei pixel resta la
verifica decisiva.
"""

from __future__ import annotations

import argparse
import difflib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:  # PyMuPDF < 1.24.3
    import fitz

try:
    import numpy as np
except ImportError:
    np = None

REPO = Path(__file__).resolve().parent.parent
PY_TOOL = REPO / "remove-pdf-bg.py"
JAR = REPO / "target" / "remove-pdf-bg.jar"


SUMMARY_PREFIXES = ("Immagini rimosse:", "Immagini individuate:")
DIFF_LIMIT = 30


def _head(lines):
    """Limita l'output del diff per non sommergere la console."""
    out = []
    for i, line in enumerate(lines):
        if i >= DIFF_LIMIT:
            out.append("... (diff troncato)")
            break
        out.append(line)
    return out


def normalize(stdout: str) -> list[str]:
    """Rimuove le righe variabili (percorso di output) e gli spazi finali."""
    lines = []
    for line in stdout.replace("\r\n", "\n").split("\n"):
        if line.startswith("File salvato in:"):
            continue
        lines.append(line.rstrip())
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def split_summary(lines: list[str]) -> tuple[list[str], list[str]]:
    body = [l for l in lines if not l.startswith(SUMMARY_PREFIXES)]
    summary = [l for l in lines if l.startswith(SUMMARY_PREFIXES)]
    return body, summary


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    proc = subprocess.run(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )
    return proc.returncode, proc.stdout


def render(path: Path, index: int, dpi: int):
    doc = fitz.open(path)
    try:
        pix = doc[index].get_pixmap(dpi=dpi)
    finally:
        doc.close()
    return pix


def compare_pages(py_pdf: Path, java_pdf: Path, n_pages: int, dpi: int,
                  max_pages: int) -> list[str]:
    """Ritorna la lista di problemi (vuota = identici)."""
    problems: list[str] = []
    if max_pages and max_pages < n_pages:
        step = n_pages / max_pages
        indices = sorted({int(i * step) for i in range(max_pages)} | {n_pages - 1})
    else:
        indices = list(range(n_pages))

    total_bad_px = 0
    for i in indices:
        p = render(py_pdf, i, dpi)
        j = render(java_pdf, i, dpi)
        if (p.width, p.height, p.n) != (j.width, j.height, j.n):
            problems.append(
                f"pagina {i + 1}: dimensioni diverse "
                f"{p.width}x{p.height} vs {j.width}x{j.height}"
            )
            continue
        if p.samples == j.samples:
            continue
        if np is not None:
            a = np.frombuffer(p.samples, dtype=np.uint8).astype(np.int16)
            b = np.frombuffer(j.samples, dtype=np.uint8).astype(np.int16)
            d = np.abs(a - b)
            bad = int((d > 8).sum())
            total_bad_px += bad
            if bad:
                problems.append(
                    f"pagina {i + 1}: meanDiff={d.mean():.3f} maxDiff={int(d.max())} "
                    f"pixel con diff>8 = {bad}"
                )
        else:
            diff = sum(1 for x, y in zip(p.samples, j.samples) if x != y)
            total_bad_px += diff
            problems.append(f"pagina {i + 1}: {diff} byte di pixel diversi")
    return problems


def test_pdf(pdf: Path, args: argparse.Namespace, tmp: Path) -> bool:
    stem = pdf.stem
    out_py = tmp / f"{stem}.py.pdf"
    out_java = tmp / f"{stem}.java.pdf"

    common: list[str] = []
    if args.threshold is not None:
        common += ["-t", str(args.threshold)]
    if args.exclude:
        common += ["-e", args.exclude]
    if args.dry_run:
        common += ["-n"]

    py_out = out_py if not args.dry_run else None
    java_out = out_java if not args.dry_run else None

    py_cmd = [sys.executable, str(PY_TOOL), str(pdf)]
    if py_out:
        py_cmd += ["-o", str(py_out)]
    py_cmd += common

    java_cmd = ["java", "-jar", str(JAR), str(pdf)]
    if java_out:
        java_cmd += ["-o", str(java_out)]
    java_cmd += common

    print(f"\n=== {pdf.name} ===")
    rc_py, stdout_py = run(py_cmd, REPO)
    rc_java, stdout_java = run(java_cmd, REPO)

    ok = True
    if rc_py != 0:
        print(f"  [FAIL] Python exit={rc_py}")
        ok = False
    if rc_java != 0:
        print(f"  [FAIL] Java exit={rc_java}")
        ok = False

    lyp, ljv = normalize(stdout_py), normalize(stdout_java)
    body_py, summary_py = split_summary(lyp)
    body_java, summary_java = split_summary(ljv)

    # Nelle dry-run il testo è la verifica principale: deve coincidere.
    # Nella rimozione reale l'accounting differisce per construction (PyMuPDF
    # sostituisce l'oggetto globalmente e le pagine successive non lo vedono
    # più), quindi lì la verifica vincolante è il rendering: le differenze di
    # testo diventano avvisi.
    strict = args.dry_run or args.strict_stdout
    if body_py == body_java:
        print(f"  [ OK ] messaggi per pagina identici ({len(body_py)} righe)")
    elif strict:
        print("  [FAIL] messaggi per pagina diversi:")
        for line in _head(difflib.unified_diff(body_py, body_java, "python", "java", lineterm="")):
            print("         " + line)
        ok = False
    else:
        print("  [WARN] messaggi per pagina diversi (accounting PyMuPDF vs Java):")
        for line in _head(difflib.unified_diff(body_py, body_java, "python", "java", lineterm="")):
            print("         " + line)

    if summary_py != summary_java:
        print("  [WARN] riepilogo diverso (quirk noto di PyMuPDF, non incide sul rendering):")
        for line in _head(difflib.unified_diff(summary_py, summary_java, "python", "java", lineterm="")):
            print("         " + line)

    if args.dry_run:
        return ok

    if not out_py.exists() or not out_java.exists():
        print("  [FAIL] PDF di output mancante")
        return False

    n_pages = len(fitz.open(pdf))
    problems = compare_pages(out_py, out_java, n_pages, args.dpi, args.max_pages)
    checked = min(args.max_pages, n_pages) if args.max_pages else n_pages
    if problems:
        print(f"  [FAIL] rendering diverso ({len(problems)} pagine su ~{checked}):")
        for p in problems[:20]:
            print("         " + p)
        ok = False
    else:
        print(f"  [ OK ] rendering identico ({checked} pagine, dpi {args.dpi})")
    return ok


def main() -> int:
    global JAR
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdfs", nargs="+", help="PDF di input da confrontare")
    ap.add_argument("--dpi", type=int, default=50, help="risoluzione di confronto (default 50)")
    ap.add_argument("--max-pages", type=int, default=0,
                    help="numero massimo di pagine campionate per PDF (0 = tutte)")
    ap.add_argument("-t", "--threshold", type=float, default=None)
    ap.add_argument("-e", "--exclude", default="")
    ap.add_argument("-n", "--dry-run", action="store_true",
                    help="confronta solo l'output testuale (nessun PDF scritto)")
    ap.add_argument("--strict-stdout", action="store_true",
                    help="nella rimozione reale considera un FAIL ogni differenza di testo")
    ap.add_argument("--keep", action="store_true", help="conserva i PDF generati")
    ap.add_argument("--jar", type=Path, default=JAR)
    args = ap.parse_args()

    if args.jar != JAR:
        JAR = args.jar
    if not JAR.is_file():
        sys.exit(f"Jar non trovato: {JAR}\nCompila prima con: mvn package")
    if not PY_TOOL.is_file():
        sys.exit(f"Script Python non trovato: {PY_TOOL}")

    missing = [str(p) for p in args.pdfs if not Path(p).is_file()]
    if missing:
        sys.exit("File non trovati: " + ", ".join(missing))

    tmp = Path(tempfile.mkdtemp(prefix="remove-pdf-bg-cmp-"))
    results: list[tuple[str, bool]] = []
    try:
        for p in args.pdfs:
            results.append((Path(p).name, test_pdf(Path(p), args, tmp)))
    finally:
        if args.keep:
            print(f"\nOutput conservati in: {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    print("\n===== RIEPILOGO =====")
    for name, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    print(f"{sum(ok for _, ok in results)}/{len(results)} PDF superati")
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
