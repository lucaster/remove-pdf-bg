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
  python remove_pdf_backgrounds.py test.pdf -o pulito.pdf -e 1 -t 90 --dry-run
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


def strip_image_from_page(page, xref) -> bool:
    """Toglie l'immagine SOLO da questa pagina, eliminando dalla content stream
    l'operatore che la disegna. Serve quando l'immagine è condivisa con pagine
    escluse: delete_image() agirebbe su tutte le pagine."""
    doc = page.parent
    name = None
    for img in page.get_images(full=True):
        # (xref, smask, w, h, bpc, cs, alt_cs, name, filter, referencer)
        if img[0] == xref and (len(img) < 10 or img[9] == 0):
            name = img[7]
            break
    if not name:
        return False  # immagine dentro un Form XObject: non gestita

    page.clean_contents()
    pattern = rb"(?<![\w/])/" + re.escape(name.encode()) + rb"\s+Do\b"
    changed = False
    for cx in page.get_contents():
        data = doc.xref_stream(cx)
        new = re.sub(pattern, b"", data)
        if new != data:
            doc.update_stream(cx, new)
            changed = True
    return changed


def remove_backgrounds(src, dst, threshold, excluded, dry_run=False):
    doc = fitz.open(src)
    n_pages = len(doc)

    # Immagini usate nelle pagine escluse: l'oggetto immagine è unico nel file,
    # quindi se è condiviso con una pagina esclusa non possiamo cancellarlo
    # globalmente e lo togliamo pagina per pagina dalla content stream.
    protected: set[int] = set()
    for i in excluded:
        protected.update(img[0] for img in doc[i].get_images(full=True))

    already_replaced: set[int] = set()
    total_removed = 0
    pages_touched = 0

    for i, page in enumerate(doc):
        if i in excluded:
            print(f"Pagina {i + 1:>4}: esclusa")
            continue

        prect = visible_rect_size(page)
        seen_on_page: set[int] = set()
        removed_here = 0

        for info in page.get_image_info(xrefs=True):
            xref = info.get("xref", 0)
            if xref == 0 or xref in seen_on_page:  # 0 = immagine inline
                continue
            seen_on_page.add(xref)

            cov = coverage(info["bbox"], prect)
            if cov < threshold:
                continue

            if not dry_run:
                if xref in protected:
                    if not strip_image_from_page(page, xref):
                        print(
                            f"Pagina {i + 1:>4}: sfondo (xref {xref}) non rimovibile "
                            f"(dentro un Form XObject) -> saltato"
                        )
                        continue
                elif xref not in already_replaced:
                    page.delete_image(xref)
                    already_replaced.add(xref)
            removed_here += 1
            print(
                f"Pagina {i + 1:>4}: {'trovato' if dry_run else 'rimosso'} sfondo "
                f"(xref {xref}, copertura {cov:.0%})"
            )

        if removed_here:
            pages_touched += 1
            total_removed += removed_here

    if not dry_run:
        # garbage=4 elimina gli oggetti non più referenziati (i dati
        # originali delle immagini), deflate ricomprime gli stream.
        doc.save(dst, garbage=4, deflate=True)
    doc.close()

    print(
        f"\nImmagini {'individuate' if dry_run else 'rimosse'}: {total_removed} "
        f"su {pages_touched} pagine (totale pagine: {n_pages})"
    )
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