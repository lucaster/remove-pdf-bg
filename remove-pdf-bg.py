#!/usr/bin/env python3
"""
Rimuove da un PDF le immagini che fanno da sfondo alle pagine, cioè quelle
che coprono almeno una certa percentuale dell'area della pagina (default 95%).
Testo e grafica vettoriale restano intatti.

Requisiti:  pip install pymupdf

Esempi:
  python remove_pdf_backgrounds.py input.pdf
  python remove_pdf_backgrounds.py input.pdf -o pulito.pdf
  python remove_pdf_backgrounds.py input.pdf -e 1,3,10-12       # escludi pagine
  python remove_pdf_backgrounds.py input.pdf -t 90 --dry-run    # solo report
"""

import argparse
import re
import sys
from pathlib import Path

try:
    import pymupdf as fitz  # PyMuPDF >= 1.24.3
except ImportError:  # versioni precedenti
    import fitz


def parse_pages(spec: str, n_pages: int) -> set[int]:
    """Converte '1,3,5-7' (numerazione da 1) in un set di indici da 0.
    Supporta anche intervalli aperti: '5-' (dalla 5 alla fine), '-3' (fino alla 3)."""
    result: set[int] = set()
    if not spec:
        return result
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start = int(a) if a else 1
            end = int(b) if b else n_pages
        else:
            start = end = int(part)
        if start < 1 or end > n_pages or start > end:
            raise ValueError(
                f"Intervallo di pagine non valido: '{part}' (il PDF ha {n_pages} pagine)"
            )
        result.update(range(start - 1, end))
    return result


def visible_rect_size(page) -> fitz.Rect:
    """Rettangolo della pagina nelle coordinate usate da get_image_info
    (non ruotate)."""
    r = page.rect
    if page.rotation in (90, 270):
        return fitz.Rect(r.x0, r.y0, r.x0 + r.height, r.y0 + r.width)
    return r


def coverage(bbox, page_rect) -> float:
    """Frazione di area della pagina coperta dall'immagine (ritagliata
    ai bordi della pagina)."""
    inter = fitz.Rect(bbox) & page_rect
    if inter.is_empty:
        return 0.0
    return inter.get_area() / page_rect.get_area()


def strip_images_from_page(page, targets: set[int]) -> tuple[set[int], set[int]]:
    """Toglie le immagini `targets` (xref) SOLO da questa pagina, eliminando
    dalla content stream l'operatore che le disegna. Non modifica né cancella
    gli oggetti immagine, quindi non può rompere altre pagine né la struttura
    del file. Restituisce (xref rimossi, xref non gestiti)."""
    doc = page.parent

    # 1) normalizza la content stream (una sola stream, nomi risorse coerenti)
    page.clean_contents()

    # 2) associa xref -> nome della risorsa nella pagina
    names: dict[int, set[str]] = {}
    unhandled: set[int] = set()
    for img in page.get_images(full=True):
        # (xref, smask, w, h, bpc, cs, alt_cs, name, filter, referencer)
        xref = img[0]
        if xref not in targets:
            continue
        referencer = img[9] if len(img) > 9 else 0
        if referencer == 0:
            names.setdefault(xref, set()).add(img[7])
        else:
            unhandled.add(xref)  # dentro un Form XObject

    # 3) rimuove "/Nome Do" dalla content stream
    removed: set[int] = set()
    for cx in page.get_contents():
        data = doc.xref_stream(cx)
        new = data
        for xref, nn in names.items():
            for name in nn:
                pattern = rb"(?<![\w/])/" + re.escape(name.encode()) + rb"\s+Do\b"
                new, count = re.subn(pattern, b"", new)
                if count:
                    removed.add(xref)
        if new != data:
            doc.update_stream(cx, new)

    # 4) una seconda pulizia elimina dalle risorse le immagini non più usate
    if removed:
        page.clean_contents()

    unhandled |= set(names) - removed
    return removed, unhandled - removed


def remove_backgrounds(src, dst, threshold, excluded, dry_run=False):
    doc = fitz.open(src)
    n_pages = len(doc)

    total_removed = 0
    pages_touched = 0
    problems = 0
    usage: dict[int, int] = {}  # xref -> numero di pagine

    for i, page in enumerate(doc):
        if i in excluded:
            print(f"Pagina {i + 1:>4}: esclusa")
            continue

        try:
            prect = visible_rect_size(page)
            targets: dict[int, float] = {}
            for info in page.get_image_info(xrefs=True):
                xref = info.get("xref", 0)
                if xref == 0 or xref in targets:  # 0 = immagine inline
                    continue
                cov = coverage(info["bbox"], prect)
                if cov >= threshold:
                    targets[xref] = cov

            if not targets:
                continue

            if dry_run:
                removed, unhandled = set(targets), set()
            else:
                removed, unhandled = strip_images_from_page(page, set(targets))
        except Exception as e:  # una pagina problematica non blocca le altre
            problems += 1
            print(f"Pagina {i + 1:>4}: ERRORE ({e}) -> pagina lasciata invariata")
            continue

        for xref in sorted(removed):
            print(
                f"Pagina {i + 1:>4}: {'trovato' if dry_run else 'rimosso'} sfondo "
                f"(xref {xref}, copertura {targets[xref]:.0%})"
            )
        for xref in sorted(unhandled):
            problems += 1
            print(
                f"Pagina {i + 1:>4}: sfondo (xref {xref}, copertura {targets[xref]:.0%}) "
                f"non rimovibile (dentro un Form XObject) -> saltato"
            )
        if removed:
            pages_touched += 1
            total_removed += len(removed)
            for xref in removed:
                usage[xref] = usage.get(xref, 0) + 1

    if not dry_run:
        # garbage=3 elimina gli oggetti non più referenziati (i dati delle
        # immagini rimosse) senza il deduplicate aggressivo di garbage=4.
        doc.save(dst, garbage=3, deflate=True)
    doc.close()

    verb = "individuate" if dry_run else "rimosse"
    print(
        f"\nOccorrenze {verb} (immagine x pagina): {total_removed} "
        f"su {pages_touched} pagine (totale pagine: {n_pages})"
    )
    print(f"Immagini distinte: {len(usage)}")
    ranked = sorted(usage.items(), key=lambda kv: (-kv[1], kv[0]))
    for xref, n in ranked[:15]:
        print(f"  xref {xref:>6}: {n} {'pagina' if n == 1 else 'pagine'}")
    if len(ranked) > 15:
        rest = ranked[15:]
        print(f"  ... e altre {len(rest)} immagini distinte "
              f"(usate in {sum(n for _, n in rest)} pagine in totale)")
    if problems:
        print(f"Attenzione: {problems} problemi segnalati sopra.")
    if not dry_run:
        print(f"File salvato in: {dst}")


def main():
    ap = argparse.ArgumentParser(
        description="Rimuove le immagini di sfondo a pagina intera da un PDF."
    )
    ap.add_argument("input", help="PDF di input")
    ap.add_argument("-o", "--output", help="PDF di output (default: <input>_nobg.pdf)")
    ap.add_argument(
        "-t", "--threshold", type=float, default=95.0,
        help="copertura minima della pagina, in %% (default: 95)",
    )
    ap.add_argument(
        "-e", "--exclude", default="",
        help="pagine da NON trattare, numerate da 1: es. '1,3,10-12' o '5-'",
    )
    ap.add_argument(
        "-n", "--dry-run", action="store_true",
        help="mostra cosa verrebbe rimosso senza scrivere alcun file",
    )
    args = ap.parse_args()

    src = Path(args.input)
    if not src.is_file():
        sys.exit(f"File non trovato: {src}")

    dst = Path(args.output) if args.output else src.with_name(f"{src.stem}_nobg.pdf")
    if dst.resolve() == src.resolve():
        sys.exit("Il file di output deve essere diverso da quello di input.")

    # Accetta sia 95 che 0.95
    threshold = args.threshold / 100 if args.threshold > 1 else args.threshold
    if not 0 < threshold <= 1:
        sys.exit("La soglia deve essere tra 0 e 100 (%).")

    with fitz.open(src) as d:
        n_pages = len(d)
    try:
        excluded = parse_pages(args.exclude, n_pages)
    except ValueError as e:
        sys.exit(str(e))

    remove_backgrounds(src, dst, threshold, excluded, args.dry_run)


if __name__ == "__main__":
    main()
