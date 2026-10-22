#!/usr/bin/env python3
"""
GUI per rimozione selettiva di immagini di sfondo da PDF.
Cross-platform, con preview PDF/immagini, checkbox di selezione e progress bar.

Uso:
  cd python-nicegui
  pip install -r requirements.txt
  python gui.py
"""

import asyncio
import base64
import re
import shutil
import subprocess
import sys
import time
import types
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import pymupdf as fitz
from nicegui import app, context, events, run, ui


# ---------------------------------------------------------------------------
# Core logic (independent from UI)
# ---------------------------------------------------------------------------


@dataclass
class CandidateImage:
    """Immagine candidata come sfondo da rimuovere."""

    page_idx: int  # 0-based
    xref: int
    img_name: Optional[str]
    bbox: Tuple[float, float, float, float]  # x0,y0,x1,y1
    coverage_pct: float  # 0-100
    is_protected: bool  # condivisa con pagine escluse
    can_strip_per_page: bool  # rimovibile da singola pagina via Do
    selected: bool = True
    image_data: Optional[bytes] = None
    page_pixmap_data: Optional[bytes] = None


@dataclass
class AnalysisResult:
    candidates: List[CandidateImage]
    total_pages: int
    doc_path: Path


def parse_pages(spec: str, n_pages: int) -> Set[int]:
    """Converte '1,3,5-7' (1-based) in set di indici 0-based.
    Supporta anche intervalli aperti: '5-', '-3'."""
    result: Set[int] = set()
    if not spec or not spec.strip():
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
                f"Intervallo pagine non valido: '{part}' (il PDF ha {n_pages} pagine)"
            )
        result.update(range(start - 1, end))
    return result


def visible_rect_size(page: fitz.Page) -> fitz.Rect:
    r = page.rect
    if page.rotation in (90, 270):
        return fitz.Rect(r.x0, r.y0, r.x0 + r.height, r.y0 + r.width)
    return r


def coverage_pct(bbox: fitz.Rect, page_rect: fitz.Rect) -> float:
    inter = bbox & page_rect
    if inter.is_empty:
        return 0.0
    return (inter.get_area() / page_rect.get_area()) * 100.0


def get_image_name_on_page(page: fitz.Page, xref: int) -> Optional[str]:
    for img in page.get_images(full=True):
        if img[0] == xref:
            return img[7] if len(img) > 7 else None
    return None


def can_strip_image_from_page(page: fitz.Page, xref: int) -> Tuple[bool, Optional[str]]:
    name = get_image_name_on_page(page, xref)
    if not name:
        return False, None
    return True, name


PAGE_PREVIEW_MAX_HEIGHT = 600.0
IMAGE_PREVIEW_MAX_DIM = 512


def preview_image(data: bytes, max_dim: int = IMAGE_PREVIEW_MAX_DIM) -> bytes:
    """Ridimensiona un'immagine per la preview (lato max_dim px) se necessario."""
    try:
        pix = fitz.Pixmap(data)
    except Exception:
        return data
    shrunk = False
    while pix.width > max_dim or pix.height > max_dim:
        pix.shrink(1)
        shrunk = True
    if not shrunk:
        return data
    try:
        if pix.colorspace is None or pix.colorspace.n not in (1, 3):
            pix = fitz.Pixmap(fitz.csRGB, pix)
        if pix.alpha:
            return pix.tobytes(output="png")
        return pix.tobytes(output="jpeg", jpg_quality=80)
    except Exception:
        return data


def data_url(data: bytes) -> str:
    """Costruisce un data URL con il MIME reale (jpeg o png)."""
    mime = "image/jpeg" if data.startswith(b"\xff\xd8\xff") else "image/png"
    return f"data:{mime};base64," + base64.b64encode(data).decode()


_DIALOG_SCRIPT = (
    "import sys, tkinter as tk\n"
    "from tkinter import filedialog\n"
    "sys.stdout.reconfigure(encoding='utf-8')\n"
    "root = tk.Tk()\n"
    "root.withdraw()\n"
    "root.attributes('-topmost', True)\n"
    "path = filedialog.askopenfilename(\n"
    "    title='Seleziona PDF',\n"
    "    filetypes=[('PDF', '*.pdf'), ('Tutti i file', '*.*')],\n"
    ")\n"
    "sys.stdout.write(path or '')\n"
)


def pick_pdf_file(run=subprocess.run, python: Optional[str] = None) -> Optional[Path]:
    """Apre il dialogo file nativo (tkinter in un sottoprocesso) e ritorna il percorso scelto.

    Il dialogo gira in un processo separato perché tkinter non è sicuro da
    usare dal thread del server. Ritorna None se l'utente annulla o se il
    dialogo non è disponibile.
    """
    try:
        proc = run(
            [python or sys.executable, "-c", _DIALOG_SCRIPT],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    out = (proc.stdout or "").strip()
    return Path(out) if out else None


def _fmt_eta(seconds: float) -> str:
    """Formatta un tempo stimato rimanente in modo leggibile."""
    if seconds < 1:
        return "<1s"
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes, secs = divmod(int(round(seconds)), 60)
    return f"{minutes}m {secs}s"


_SAVE_DIALOG_SCRIPT = (
    "import sys, tkinter as tk\n"
    "from tkinter import filedialog\n"
    "sys.stdout.reconfigure(encoding='utf-8')\n"
    "root = tk.Tk()\n"
    "root.withdraw()\n"
    "root.attributes('-topmost', True)\n"
    "path = filedialog.asksaveasfilename(\n"
    "    title='Salva il PDF',\n"
    "    defaultextension='.pdf',\n"
    "    initialfile=sys.argv[1],\n"
    "    filetypes=[('PDF', '*.pdf'), ('Tutti i file', '*.*')],\n"
    ")\n"
    "sys.stdout.write(path or '')\n"
)


def pick_save_path(
    suggested_name: str, run=subprocess.run, python: Optional[str] = None
) -> Optional[Path]:
    """Apre il dialogo nativo 'Salva come' e ritorna il percorso scelto.

    Ritorna None se l'utente annulla o se il dialogo non è disponibile.
    """
    try:
        proc = run(
            [python or sys.executable, "-c", _SAVE_DIALOG_SCRIPT, suggested_name],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    out = (proc.stdout or "").strip()
    return Path(out) if out else None


def analyze_pdf(
    pdf_path: Path,
    threshold_pct: float,
    exclude_spec: str,
    progress_callback=None,
) -> AnalysisResult:
    """Analizza PDF e restituisce candidati con coverage >= threshold."""
    candidates: List[CandidateImage] = []
    doc = fitz.open(pdf_path)
    try:
        n_pages = len(doc)
        excluded = parse_pages(exclude_spec, n_pages)

        protected: Set[int] = set()
        for i in excluded:
            for img in doc[i].get_images(full=True):
                protected.add(img[0])

        for i in range(n_pages):
            if i in excluded:
                continue

            page = doc[i]
            prect = visible_rect_size(page)
            seen: Set[int] = set()

            try:
                zoom = min(1.0, PAGE_PREVIEW_MAX_HEIGHT / prect.height)
                page_pm = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace="rgb")
                page_preview = page_pm.tobytes(output="jpeg", jpg_quality=75)
                page_pm = None
            except Exception:
                page_preview = None

            for info in page.get_image_info(xrefs=True):
                xref = info.get("xref", 0)
                if xref == 0 or xref in seen:
                    continue
                seen.add(xref)

                bbox = fitz.Rect(info.get("bbox"))
                if bbox.is_empty:
                    continue

                cov = coverage_pct(bbox, prect)
                if cov < threshold_pct:
                    continue

                # Ignora lo stub 1x1 lasciato da una precedente rimozione
                try:
                    if info.get("width") == 1 and info.get("height") == 1:
                        continue
                except Exception:
                    pass

                can_strip, name = can_strip_image_from_page(page, xref)
                is_prot = xref in protected

                img_preview: Optional[bytes] = None
                try:
                    img_dict = doc.extract_image(xref)
                    if img_dict and img_dict.get("image"):
                        img_preview = preview_image(img_dict["image"])
                except Exception:
                    img_preview = None

                candidates.append(
                    CandidateImage(
                        page_idx=i,
                        xref=xref,
                        img_name=name,
                        bbox=(bbox.x0, bbox.y0, bbox.x1, bbox.y1),
                        coverage_pct=cov,
                        is_protected=is_prot,
                        can_strip_per_page=can_strip,
                        selected=True,
                        image_data=img_preview,
                        page_pixmap_data=page_preview,
                    )
                )

            if progress_callback:
                progress_callback(
                    (i + 1) / n_pages,
                    f"Pagina {i + 1}/{n_pages} - {len(candidates)} immagini identificate",
                )

        if progress_callback:
            progress_callback(1.0, "Analisi completata")
        return AnalysisResult(candidates=candidates, total_pages=n_pages, doc_path=pdf_path)
    finally:
        doc.close()


def apply_removal(
    pdf_path: Path,
    output_path: Path,
    threshold_pct: float,
    exclude_spec: str,
    selected_xrefs_by_page: Dict[int, Set[int]],
    progress_callback=None,
    dry_run: bool = False,
) -> int:
    """Rimuove solo le immagini selezionate. Ritorna il numero rimosso."""
    doc = fitz.open(pdf_path)
    try:
        n_pages = len(doc)
        excluded = parse_pages(exclude_spec, n_pages)

        protected: Set[int] = set()
        for i in excluded:
            for img in doc[i].get_images(full=True):
                protected.add(img[0])

        already_replaced: Set[int] = set()
        total_removed = 0
        pages_touched = 0

        for i in range(n_pages):
            if progress_callback:
                progress_callback(i / n_pages, f"Elaborando pagina {i + 1}/{n_pages}...")
            if i in excluded:
                continue

            page = doc[i]
            prect = visible_rect_size(page)
            seen: Set[int] = set()
            removed_here = 0
            allowed = selected_xrefs_by_page.get(i, set())

            for info in page.get_image_info(xrefs=True):
                xref = info.get("xref", 0)
                if xref == 0 or xref in seen:
                    continue
                seen.add(xref)

                bbox = fitz.Rect(info.get("bbox"))
                if bbox.is_empty:
                    continue
                cov = coverage_pct(bbox, prect)
                if cov < threshold_pct or xref not in allowed:
                    continue

                if not dry_run:
                    if xref in protected:
                        can_strip, name = can_strip_image_from_page(page, xref)
                        if not can_strip or name is None:
                            continue
                        page.clean_contents()
                        pattern = re.compile(
                            rb"(?<![\w/])/" + re.escape(name.encode()) + rb"\s+Do\b"
                        )
                        changed = False
                        for cx in page.get_contents():
                            data = doc.xref_stream(cx)
                            new = pattern.sub(b"", data)
                            if new != data:
                                doc.update_stream(cx, new)
                                changed = True
                        if not changed:
                            continue
                    elif xref not in already_replaced:
                        page.delete_image(xref)
                        already_replaced.add(xref)
                removed_here += 1

            if removed_here:
                pages_touched += 1
                total_removed += removed_here

        if progress_callback:
            progress_callback(1.0, "Salvataggio in corso...")
        if not dry_run:
            doc.save(output_path, garbage=4, deflate=True, use_objstms=True)
        if progress_callback:
            progress_callback(
                1.0, f"Completato: {total_removed} immagini rimosse su {pages_touched} pagine"
            )
        return total_removed
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# UI (per-client via @ui.page)
# ---------------------------------------------------------------------------


@dataclass
class PageState:
    pdf_path: Optional[Path] = None
    analysis: Optional[AnalysisResult] = None
    candidates: List[CandidateImage] = field(default_factory=list)
    output_path: Optional[Path] = None
    saved_path: Optional[Path] = None
    analyze_runs: int = 0


_state_module = sys.modules.get("_gui_state")
if _state_module is None:
    _state_module = types.ModuleType("_gui_state")
    _state_module.refs = {}
    sys.modules["_gui_state"] = _state_module

# Reference for tests to interact with the current page
_refs: Dict[str, object] = _state_module.refs


@ui.page("/")
def main_page():
    state = PageState()

    # ---- header ----
    with ui.header(elevated=True).style("background-color: #3874c8"):
        ui.label("Remove PDF Background - GUI (NiceGUI)").style(
            "color: white; font-weight: bold"
        )

    with ui.column().classes("w-full p-4 gap-4"):
        # ---- 1. file selection ----
        with ui.card().classes("w-full"):
            ui.label("1. Seleziona PDF").classes("text-lg font-bold")
            with ui.row().classes("items-center gap-4 w-full"):

                async def handle_upload(e: events.UploadEventArguments):
                    f = e.file
                    tmp_dir = Path("uploads")
                    tmp_dir.mkdir(exist_ok=True)
                    tmp = tmp_dir / f.name
                    await f.save(tmp)
                    state.pdf_path = tmp
                    _reset_analysis_ui()
                    file_label.text = f"File: {tmp.name}"
                    analyze_btn.enable()
                    ui.notify(f"PDF caricato: {tmp.name}")

                async def handle_browse():
                    picker = _refs.get("pick_pdf_file", pick_pdf_file)
                    path = await run.io_bound(picker)
                    if path is None:
                        return
                    path = Path(path)
                    if not path.exists():
                        ui.notify(f"File non trovato: {path}", type="negative")
                        return
                    if path.suffix.lower() != ".pdf":
                        ui.notify("Il file selezionato non è un PDF", type="warning")
                        return
                    state.pdf_path = path
                    _reset_analysis_ui()
                    file_label.text = f"File: {path.name}"
                    analyze_btn.enable()
                    ui.notify(f"PDF selezionato: {path.name}")

                file_input = (
                    ui.upload(
                        label="Trascina PDF qui o clicca",
                        auto_upload=True,
                        on_upload=handle_upload,
                    )
                    .props('color=primary accept=".pdf"')
                    .classes("flex-grow")
                )
                browse_btn = ui.button(
                    "Sfoglia dal disco", icon="folder_open", on_click=handle_browse
                ).props("color=secondary outline")
                file_label = ui.label("Nessun file selezionato").classes("text-gray-600")

        # ---- 2. options ----
        with ui.card().classes("w-full"):
            ui.label("2. Opzioni").classes("text-lg font-bold")
            with ui.row().classes("items-end gap-4 flex-wrap"):
                threshold_slider = ui.slider(min=1, max=100, value=95, step=1).props(
                    "label-always"
                )
                ui.label("Soglia copertura (%)")
                threshold_value = ui.label("95%")

                def update_thresh(v):
                    threshold_value.text = f"{int(v)}%"

                threshold_slider.on("update:model-value", lambda e: update_thresh(e.args))

                exclude_input = ui.input(label="Pagine escluse (es. 1,3,5-7,10-)").classes(
                    "w-64"
                )
                dry_run_check = ui.checkbox("Dry-run (solo preview, non scrive file)")

        # ---- 3. analyze ----
        with ui.card().classes("w-full"):
            ui.label("3. Analizza e seleziona immagini da rimuovere").classes(
                "text-lg font-bold"
            )

            async def analyze():
                if not state.pdf_path:
                    ui.notify("Seleziona prima un PDF", type="warning")
                    return

                thresh = int(threshold_slider.value)
                exclude = exclude_input.value or ""

                state.analyze_runs += 1
                progress_bar.classes(remove="hidden")
                progress_bar.value = 0
                progress_pct.text = "0%"
                progress_label.text = "Analisi in corso..."
                spinner.classes(remove="hidden")
                analyze_btn.disable()
                apply_btn.disable()
                candidates_container.clear()
                state.candidates.clear()
                state.analysis = None

                progress = {"frac": 0.0, "msg": "Analisi in corso..."}

                def _on_progress(frac: float, msg: str) -> None:
                    progress["frac"] = frac
                    progress["msg"] = msg

                try:
                    pump = _start_progress_pump(progress)
                    try:
                        res = await run.io_bound(
                            _refs.get("analyze_pdf", analyze_pdf),
                            state.pdf_path,
                            thresh,
                            exclude,
                            _on_progress,
                        )
                    finally:
                        pump.cancel()
                    state.analysis = res
                    state.candidates = res.candidates

                    info_label.text = (
                        f"Trovate {len(res.candidates)} immagini candidate "
                        f"(>= {thresh}% copertura) su {res.total_pages} pagine"
                    )
                    select_row.classes(remove="hidden")

                    for i, c in enumerate(res.candidates):
                        _add_candidate_card(i, c)

                    progress_label.text = "Analisi completata"
                    if state.candidates:
                        apply_btn.enable()
                    ui.notify(f"{len(state.candidates)} candidati trovati", type="positive")
                except ValueError as ve:
                    ui.notify(str(ve), type="negative")
                    progress_label.text = "Errore"
                except Exception as e:
                    ui.notify(f"Errore analisi: {e}", type="negative")
                    progress_label.text = "Errore"
                finally:
                    spinner.classes(add="hidden")
                    progress_bar.value = 1.0
                    progress_pct.text = "100%"
                    analyze_btn.enable()

            with ui.row().classes("items-center gap-4"):
                analyze_btn = ui.button("Analizza PDF", icon="search", on_click=analyze).props(
                    "color=primary"
                )
                analyze_btn.disable()

                spinner = ui.spinner(type="dots", size="2rem").classes("hidden")
                progress_bar = ui.linear_progress(
                    value=0, show_value=False, size="20px"
                ).classes("flex-grow hidden")
                with progress_bar:
                    progress_pct = ui.label("0%").classes(
                        "absolute-center text-white"
                    ).style("font-size: 0.875rem")
                progress_label = ui.label("").classes("text-sm text-gray-600")

            def _start_progress_pump(progress: dict) -> asyncio.Task:
                """Aggiorna barra, percentuale ed ETA mentre il lavoro gira in un thread."""
                start = time.monotonic()

                async def _pump() -> None:
                    while True:
                        frac = progress["frac"]
                        progress_bar.value = frac
                        progress_pct.text = f"{round(frac * 100)}%"
                        text = progress["msg"]
                        if text and 0 < frac < 1:
                            remaining = (time.monotonic() - start) * (1 - frac) / frac
                            text += f" - ETA {_fmt_eta(remaining)}"
                        if text:
                            progress_label.text = text
                        await asyncio.sleep(0.1)

                return asyncio.create_task(_pump())

            ui.separator().classes("my-2")

            info_label = ui.label("Nessuna analisi ancora effettuata").classes(
                "text-gray-600"
            )

            def _candidate_checkboxes() -> List[ui.checkbox]:
                return [
                    e for e in candidates_container.descendants() if isinstance(e, ui.checkbox)
                ]

            def toggle_all(val: bool):
                boxes = _candidate_checkboxes()
                for i, c in enumerate(state.candidates):
                    c.selected = val
                    if i < len(boxes):
                        boxes[i].value = val

            def toggle_inverse():
                boxes = _candidate_checkboxes()
                for i, c in enumerate(state.candidates):
                    c.selected = not c.selected
                    if i < len(boxes):
                        boxes[i].value = c.selected

            with ui.row().classes("gap-2 hidden") as select_row:
                ui.button("Seleziona tutto", icon="check_box", on_click=lambda: toggle_all(True)).props(
                    "size=sm"
                )
                ui.button(
                    "Deseleziona tutto", icon="check_box_outline_blank", on_click=lambda: toggle_all(False)
                ).props("size=sm")
                ui.button("Inverti selezione", icon="swap_horiz", on_click=toggle_inverse).props(
                    "size=sm"
                )

            candidates_container = ui.column().classes("w-full gap-3 mt-4")

            def _add_candidate_card(idx: int, c: CandidateImage):
                with candidates_container:
                    with ui.card().classes("w-full border-l-4 border-blue-500"):
                        with ui.row().classes("w-full gap-4 items-start flex-wrap"):
                            with ui.column().classes("flex-shrink-0 gap-2 min-w-72"):
                                ui.checkbox(
                                    f"Seleziona (xref {c.xref})",
                                    value=c.selected,
                                    on_change=lambda e, i=idx: _toggle_candidate(i, e.value),
                                )
                                ui.label(
                                    f"Pagina {c.page_idx + 1} / xref {c.xref}"
                                ).classes("font-bold")
                                ui.label(f"Copertura: {c.coverage_pct:.1f}%").classes("text-sm")
                                if c.img_name:
                                    ui.label(f"Nome: {c.img_name}").classes("text-xs text-gray-600")
                                ui.label(
                                    f"Protetto: {'Si' if c.is_protected else 'No'}"
                                ).classes("text-xs")
                                ui.label(
                                    f"Strip per-pagina: {'Si' if c.can_strip_per_page else 'No'}"
                                ).classes("text-xs")

                            with ui.column().classes("items-center gap-2"):
                                ui.label("Immagine rilevata").classes("text-sm font-semibold")
                                if c.image_data:
                                    ui.image(data_url(c.image_data)).classes(
                                        "max-h-48 max-w-96 object-contain border rounded"
                                    )
                                else:
                                    ui.label("Immagine non estratta").classes(
                                        "text-xs text-gray-500 italic"
                                    )

                            with ui.column().classes("items-center gap-2 flex-grow"):
                                ui.label("Contesto pagina").classes("text-sm font-semibold")
                                if c.page_pixmap_data:
                                    ui.image(data_url(c.page_pixmap_data)).classes(
                                        "max-h-64 max-w-full object-contain border rounded"
                                    )
                                else:
                                    ui.label("Anteprima non disponibile").classes(
                                        "text-xs text-gray-500 italic"
                                    )

            def _toggle_candidate(idx: int, val: bool):
                if 0 <= idx < len(state.candidates):
                    state.candidates[idx].selected = val

        # ---- 4. apply ----
        with ui.card().classes("w-full"):
            ui.label("4. Applica rimozione").classes("text-lg font-bold")

            async def handle_download():
                out = state.output_path
                if out is None or not out.exists():
                    ui.notify("Nessun file da scaricare", type="warning")
                    return
                url = app.add_static_file(local_file=out.resolve(), single_use=True)
                context.client.on_delete(
                    lambda: app.remove_route(urllib.parse.unquote(url))
                )
                ui.download.from_url(url, out.name)

            async def handle_save_as():
                out = state.output_path
                if out is None or not out.exists():
                    ui.notify("Nessun file da salvare", type="warning")
                    return
                picker = _refs.get("pick_save_path", pick_save_path)
                dest = await run.io_bound(picker, out.name)
                if dest is None:
                    return
                try:
                    if dest.resolve() != out.resolve():
                        shutil.copy2(out, dest)
                except OSError as e:
                    ui.notify(f"Errore durante il salvataggio: {e}", type="negative")
                    return
                state.saved_path = dest
                output_label.text = f"Output: {dest.name} - {dest}"
                ui.notify(f"File salvato in: {dest}", type="positive")

            async def apply_removal_ui():
                if not state.pdf_path or not state.candidates:
                    ui.notify("Nessun candidato selezionato", type="warning")
                    return

                thresh = int(threshold_slider.value)
                exclude = exclude_input.value or ""
                dry = dry_run_check.value

                selected_map: Dict[int, Set[int]] = {}
                for c in state.candidates:
                    if c.selected:
                        selected_map.setdefault(c.page_idx, set()).add(c.xref)

                if not selected_map:
                    ui.notify("Seleziona almeno un'immagine", type="warning")
                    return

                src = state.pdf_path
                suffix = "_nobg_preview.pdf" if dry else "_nobg.pdf"
                out = src.with_name(f"{src.stem}{suffix}")
                state.output_path = out

                progress_bar.classes(remove="hidden")
                progress_bar.value = 0
                progress_pct.text = "0%"
                progress_label.text = "Elaborazione in corso..."
                spinner.classes(remove="hidden")
                apply_btn.disable()
                analyze_btn.disable()

                progress = {"frac": 0.0, "msg": "Elaborazione in corso..."}

                def _on_progress(frac: float, msg: str) -> None:
                    progress["frac"] = frac
                    progress["msg"] = msg

                try:
                    pump = _start_progress_pump(progress)
                    try:
                        removed = await run.io_bound(
                            apply_removal,
                            src,
                            out,
                            thresh,
                            exclude,
                            selected_map,
                            _on_progress,
                            dry_run=dry,
                        )
                    finally:
                        pump.cancel()
                    prefix = "Dry-run completato" if dry else "Fatto! File salvato"
                    result_label.text = f"{prefix}: {out} ({removed} immagini)"
                    output_label.text = f"Output: {out.name}"
                    ui.notify("Operazione completata", type="positive")
                    progress_label.text = "Completato"
                    if not dry:
                        save_row.clear()
                        with save_row:
                            ui.button(
                                "Scarica PDF", icon="download", on_click=handle_download
                            ).props("color=primary")
                            ui.button(
                                "Salva come...", icon="save", on_click=handle_save_as
                            )
                        save_row.classes(remove="hidden")
                except Exception as e:
                    ui.notify(f"Errore: {e}", type="negative")
                    result_label.text = f"Errore: {e}"
                    progress_label.text = "Errore"
                finally:
                    spinner.classes(add="hidden")
                    progress_bar.value = 1.0
                    progress_pct.text = "100%"
                    analyze_btn.enable()
                    apply_btn.enable()

                if not dry and state.output_path and state.output_path.exists():
                    await handle_save_as()

            with ui.row().classes("items-center gap-4"):
                apply_btn = ui.button(
                    "Rimuovi immagini selezionate", icon="delete", on_click=apply_removal_ui
                ).props("color=negative")
                apply_btn.disable()
                output_label = ui.label("").classes("text-gray-600")

            save_row = ui.row().classes("items-center gap-4 hidden")

            result_label = ui.label("").classes("mt-2")

    # Expose state + handlers for tests
    def _reset_analysis_ui():
        """Azzera l'analisi precedente quando si cambia file."""
        state.analysis = None
        state.candidates = []
        candidates_container.clear()
        info_label.text = "Nessuna analisi ancora effettuata"
        select_row.classes(add="hidden")
        apply_btn.disable()

    # Il picker puo' essere sostituito dai test: setdefault non sovrascrive
    _refs.setdefault("pick_save_path", pick_save_path)

    _refs.update(
        state=state,
        handle_upload=handle_upload,
        handle_browse=handle_browse,
        handle_download=handle_download,
        handle_save_as=handle_save_as,
        pick_pdf_file=pick_pdf_file,
        analyze_pdf=analyze_pdf,
        analyze=analyze,
        apply_removal_ui=apply_removal_ui,
        analyze_btn=analyze_btn,
        apply_btn=apply_btn,
        threshold_slider=threshold_slider,
        exclude_input=exclude_input,
        dry_run_check=dry_run_check,
        info_label=info_label,
        candidates_container=candidates_container,
        select_row=select_row,
        spinner=spinner,
        progress_bar=progress_bar,
        progress_pct=progress_pct,
        progress_label=progress_label,
        file_label=file_label,
        output_label=output_label,
        result_label=result_label,
        save_row=save_row,
    )


if __name__ in {"__main__", "__mp_main__"}:
    ui.run(title="Remove PDF Background - NiceGUI", port=8080, reload=False)
