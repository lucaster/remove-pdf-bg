"""E2E test per la GUI con nicegui.testing.User.

Simula l'interazione completa: upload, analisi, selezione checkbox, rimozione.
"""
import asyncio
import sys
import time
from pathlib import Path

import pymupdf
import pytest
from nicegui import ui
from nicegui.elements.upload_files import SmallFileUpload
from nicegui.testing import User

from gui import AnalysisResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _refs() -> dict:
    """Access the shared per-page refs exposed by gui.py."""
    module = sys.modules.get("_gui_state")
    assert module is not None, "gui.py state not loaded yet (open '/' first)"
    return module.refs


async def _wait_for(predicate, *, timeout: float = 10.0, message: str = "condition not met") -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.05)
    raise AssertionError(message)


@pytest.fixture(autouse=True)
def _no_native_save_dialog(user: User):
    """Impedisce l'apertura del dialogo nativo 'Salva come' durante i test."""
    _refs()["pick_save_path"] = lambda name: None
    yield


async def _upload_pdf(user: User, pdf_path: Path) -> None:
    """Simulate a file upload through the upload widget."""
    upload = next(iter(user.find(kind=ui.upload).elements))
    file = SmallFileUpload(pdf_path.name, "application/pdf", pdf_path.read_bytes())
    with user:
        await upload.handle_uploads([file])
    await _wait_for(
        lambda: _refs()["state"].pdf_path is not None and _refs()["analyze_btn"].enabled,
        message="upload did not complete",
    )


async def _analyze(user: User) -> None:
    """Click 'Analizza PDF' and wait for the analysis to complete."""
    runs = _refs()["state"].analyze_runs
    user.find("Analizza PDF").click()
    await _wait_for(
        lambda: _refs()["state"].analyze_runs == runs + 1 and _refs()["state"].analysis is not None,
        message="analyze did not complete",
    )


async def _apply(user: User) -> str:
    """Click 'Rimuovi immagini selezionate' and wait for the result label."""
    user.find("Rimuovi immagini selezionate").click()
    await _wait_for(
        lambda: _refs()["result_label"].text != "",
        message="apply did not complete",
    )
    return str(_refs()["result_label"].text)


def _set_value(user: User, key: str, value) -> None:
    with user:
        _refs()[key].value = value


def _candidate_checkbox(user: User, index: int):
    container = _refs()["candidates_container"]
    boxes = [e for e in container.descendants() if isinstance(e, ui.checkbox)]
    return boxes[index]


# ---------------------------------------------------------------------------
# Initial state
# ---------------------------------------------------------------------------


class TestInitialState:
    async def test_page_loads(self, user: User):
        await user.open("/")
        await user.should_see("Remove PDF Background - GUI (NiceGUI)")
        await user.should_see("1. Seleziona PDF")
        await user.should_see("2. Opzioni")
        await user.should_see("3. Analizza e seleziona immagini da rimuovere")
        await user.should_see("4. Applica rimozione")

    async def test_analyze_btn_disabled(self, user: User):
        await user.open("/")
        assert _refs()["analyze_btn"].enabled is False

    async def test_apply_btn_disabled(self, user: User):
        await user.open("/")
        assert _refs()["apply_btn"].enabled is False

    async def test_no_candidates_initially(self, user: User):
        await user.open("/")
        await user.should_see("Nessuna analisi ancora effettuata")

    async def test_file_label_empty(self, user: User):
        await user.open("/")
        await user.should_see("Nessun file selezionato")

    async def test_threshold_default(self, user: User):
        await user.open("/")
        assert _refs()["threshold_slider"].value == 95

    async def test_threshold_slider_range(self, user: User):
        await user.open("/")
        slider = _refs()["threshold_slider"]
        assert slider.props["min"] == 1
        assert slider.props["max"] == 100

    async def test_dry_run_unchecked(self, user: User):
        await user.open("/")
        assert _refs()["dry_run_check"].value is False

    async def test_select_row_hidden_initially(self, user: User):
        await user.open("/")
        assert "hidden" in _refs()["select_row"]._classes

    async def test_progress_hidden_initially(self, user: User):
        await user.open("/")
        assert "hidden" in _refs()["progress_bar"]._classes
        assert "hidden" in _refs()["spinner"]._classes


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------


class TestUpload:
    async def test_upload_enables_analyze(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        assert _refs()["analyze_btn"].enabled is True
        assert _refs()["state"].pdf_path is not None
        assert _refs()["info_label"].text == "Nessuna analisi ancora effettuata"

    async def test_upload_sets_file_label(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        assert _refs()["file_label"].text == f"File: {sample_pdf.name}"

    async def test_upload_saves_file(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        saved = _refs()["state"].pdf_path
        assert saved is not None
        assert saved.exists()
        assert saved.name == sample_pdf.name
        assert saved == Path("uploads") / sample_pdf.name
        assert saved.read_bytes() == sample_pdf.read_bytes()

    async def test_browse_selects_file_from_disk(self, user: User, sample_pdf: Path):
        await user.open("/")
        _refs()["pick_pdf_file"] = lambda: sample_pdf
        user.find("Sfoglia dal disco").click()
        await _wait_for(lambda: _refs()["state"].pdf_path is not None)
        assert _refs()["state"].pdf_path == sample_pdf
        assert _refs()["analyze_btn"].enabled is True
        assert _refs()["file_label"].text == f"File: {sample_pdf.name}"

    async def test_browse_output_saved_next_to_input(self, user: User, sample_pdf: Path):
        await user.open("/")
        _refs()["pick_pdf_file"] = lambda: sample_pdf
        user.find("Sfoglia dal disco").click()
        await _wait_for(lambda: _refs()["state"].pdf_path is not None)
        await _analyze(user)
        await _apply(user)
        out = _refs()["state"].output_path
        assert out.parent == sample_pdf.parent
        assert out.name == f"{sample_pdf.stem}_nobg.pdf"
        assert out.exists()

    async def test_browse_rejects_non_pdf(self, user: User, tmp_path: Path):
        await user.open("/")
        txt = tmp_path / "note.txt"
        txt.write_text("x")
        _refs()["pick_pdf_file"] = lambda: txt
        user.find("Sfoglia dal disco").click()
        await _wait_for(lambda: user.notify.contains("non è un PDF"))
        assert _refs()["state"].pdf_path is None

    async def test_browse_cancel_keeps_state(self, user: User):
        await user.open("/")
        _refs()["pick_pdf_file"] = lambda: None
        user.find("Sfoglia dal disco").click()
        await asyncio.sleep(0.2)
        assert _refs()["state"].pdf_path is None
        assert _refs()["analyze_btn"].enabled is False

    async def test_browse_resets_previous_analysis(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        assert _refs()["state"].candidates
        _refs()["pick_pdf_file"] = lambda: sample_pdf
        user.find("Sfoglia dal disco").click()
        await _wait_for(lambda: _refs()["state"].analyze_runs == 1 and not _refs()["state"].candidates)
        assert _refs()["info_label"].text == "Nessuna analisi ancora effettuata"
        assert _refs()["apply_btn"].enabled is False

    async def test_analyze_without_pdf_shows_warning(self, user: User):
        await user.open("/")
        _refs()["analyze_btn"].enable()
        user.find("Analizza PDF").click()
        await _wait_for(lambda: user.notify.contains("Seleziona prima un PDF"))
        assert _refs()["state"].analysis is None
        assert _refs()["state"].analyze_runs == 0


# ---------------------------------------------------------------------------
# Analyze
# ---------------------------------------------------------------------------


class TestAnalyze:
    async def test_analyze_shows_candidates(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        assert len(_refs()["state"].candidates) == 3

    async def test_analyze_reenables_analyze_btn(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        assert _refs()["analyze_btn"].enabled is True

    async def test_analyze_enables_apply(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        assert _refs()["apply_btn"].enabled is True

    async def test_analyze_shows_select_row(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        assert "hidden" not in _refs()["select_row"]._classes

    async def test_analyze_shows_candidate_cards(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        cards = list(_refs()["candidates_container"])
        assert len(cards) == 3
        await user.should_see("Copertura:")

    async def test_analyze_shows_info_label(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        info = str(_refs()["info_label"].text)
        assert "Trovate 3" in info
        assert "3 pagine" in info

    async def test_analyze_shows_progress_done(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        assert _refs()["progress_bar"].value == 1.0
        assert _refs()["progress_pct"].text == "100%"
        assert _refs()["progress_label"].text == "Analisi completata"
        assert "hidden" not in _refs()["progress_bar"]._classes
        assert "hidden" in _refs()["spinner"]._classes

    async def test_analyze_shows_live_image_count(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        real = _refs()["analyze_pdf"]

        def slow_analyze(pdf_path, threshold, exclude, cb):
            total = 5
            for i in range(1, total + 1):
                time.sleep(0.2)
                if cb:
                    cb(i / total, f"Pagina {i}/{total} - {i} immagini identificate")
            return AnalysisResult(candidates=[], total_pages=total, doc_path=pdf_path)

        _refs()["analyze_pdf"] = slow_analyze
        try:
            user.find("Analizza PDF").click()
            await _wait_for(
                lambda: "immagini identificate" in str(_refs()["progress_label"].text),
                message="live image count never shown",
            )
            await _wait_for(
                lambda: "ETA " in str(_refs()["progress_label"].text),
                message="ETA never shown during analysis",
            )
            assert "hidden" not in _refs()["progress_bar"]._classes
            pct = str(_refs()["progress_pct"].text)
            assert pct.endswith("%") and pct[:-1].isdigit(), f"percentuale non intera: {pct}"
            assert 0 < _refs()["progress_bar"].value < 1
        finally:
            _refs()["analyze_pdf"] = real

    async def test_analyze_with_exclude(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        _set_value(user, "exclude_input", "1")
        await _analyze(user)
        candidates = _refs()["state"].candidates
        assert len(candidates) == 2
        assert all(c.page_idx != 0 for c in candidates)

    async def test_analyze_invalid_exclude_shows_error(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        _set_value(user, "exclude_input", "99")
        user.find("Analizza PDF").click()
        await _wait_for(lambda: _refs()["progress_label"].text == "Errore")
        assert user.notify.contains("Intervallo pagine non valido")
        assert _refs()["state"].analysis is None
        assert _refs()["analyze_btn"].enabled is True
        assert _refs()["apply_btn"].enabled is False

    async def test_analyze_with_threshold(self, user: User, multi_image_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, multi_image_pdf)
        _set_value(user, "threshold_slider", 95)
        await _analyze(user)
        high_count = len(_refs()["state"].candidates)

        _set_value(user, "threshold_slider", 50)
        await _analyze(user)
        low_count = len(_refs()["state"].candidates)

        assert high_count == 4
        assert low_count == 8


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------


class TestSelection:
    async def test_all_selected_by_default(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        assert all(c.selected for c in _refs()["state"].candidates)

    async def test_deselect_all(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        user.find("Deseleziona tutto").click()
        assert all(not c.selected for c in _refs()["state"].candidates)

    async def test_select_all(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        user.find("Deseleziona tutto").click()
        assert all(not c.selected for c in _refs()["state"].candidates)
        user.find("Seleziona tutto").click()
        assert all(c.selected for c in _refs()["state"].candidates)

    async def test_invert_selection(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        user.find("Inverti selezione").click()
        assert all(not c.selected for c in _refs()["state"].candidates)
        user.find("Inverti selezione").click()
        assert all(c.selected for c in _refs()["state"].candidates)

    async def test_individual_checkbox(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        checkbox = _candidate_checkbox(user, 0)
        with user:
            checkbox.set_value(False)
        assert _refs()["state"].candidates[0].selected is False
        assert _refs()["state"].candidates[1].selected is True
        with user:
            checkbox.set_value(True)
        assert _refs()["state"].candidates[0].selected is True

    async def test_toggle_buttons_update_in_place(self, user: User, sample_pdf: Path):
        """I bottoni di selezione devono aggiornare le checkbox senza rigenerare le card."""
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        container = _refs()["candidates_container"]

        def card_ids():
            return [e.id for e in container.descendants() if isinstance(e, ui.card)]

        def checkboxes():
            return [e for e in container.descendants() if isinstance(e, ui.checkbox)]

        cards_before = card_ids()
        boxes_before = [b.id for b in checkboxes()]
        assert len(boxes_before) == 3

        user.find("Deseleziona tutto").click()
        assert card_ids() == cards_before
        assert [b.id for b in checkboxes()] == boxes_before
        assert all(not b.value for b in checkboxes())
        assert all(not c.selected for c in _refs()["state"].candidates)

        user.find("Inverti selezione").click()
        assert card_ids() == cards_before
        assert all(b.value for b in checkboxes())
        assert all(c.selected for c in _refs()["state"].candidates)

        user.find("Seleziona tutto").click()
        assert card_ids() == cards_before
        assert all(b.value for b in checkboxes())


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------


class TestApply:
    async def test_apply_creates_output(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        await _apply(user)
        out = _refs()["state"].output_path
        assert out is not None
        assert out.exists()
        assert out.name.endswith("_nobg.pdf")

    async def test_apply_shows_result(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        text = await _apply(user)
        assert "Fatto! File salvato" in text
        assert "3 immagini" in text

    async def test_apply_reenables_buttons(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        await _apply(user)
        assert _refs()["analyze_btn"].enabled is True
        assert _refs()["apply_btn"].enabled is True

    async def test_apply_shows_progress_done(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        await _apply(user)
        assert _refs()["progress_bar"].value == 1.0
        assert _refs()["progress_pct"].text == "100%"
        assert _refs()["progress_label"].text == "Completato"
        assert "hidden" in _refs()["spinner"]._classes

    async def test_dry_run_no_output_file(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        _set_value(user, "dry_run_check", True)
        await _analyze(user)
        text = await _apply(user)
        assert "Dry-run completato" in text
        out = _refs()["state"].output_path
        assert out is not None
        assert out.name.endswith("_nobg_preview.pdf")
        assert not out.exists()
        assert "hidden" in _refs()["save_row"]._classes

    async def test_apply_offers_download_and_save(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        await _apply(user)
        save_row = _refs()["save_row"]
        labels = [b.text for b in save_row.descendants() if isinstance(b, ui.button)]
        assert "Scarica PDF" in labels
        assert "Salva come..." in labels
        assert "hidden" not in save_row._classes

    async def test_download_button_downloads_output(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        await _apply(user)
        user.find("Scarica PDF").click()
        response = await user.download.next(timeout=5.0)
        assert response.status_code == 200

    async def test_save_as_copies_output_to_chosen_path(
        self, user: User, sample_pdf: Path, tmp_path: Path
    ):
        await user.open("/")
        dest = tmp_path / "scelto.pdf"
        _refs()["pick_save_path"] = lambda name: dest
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        await _apply(user)
        await _wait_for(lambda: _refs()["state"].saved_path is not None)
        assert _refs()["state"].saved_path == dest
        assert dest.exists()
        assert dest.read_bytes() == _refs()["state"].output_path.read_bytes()

    async def test_save_as_cancelled_keeps_output(
        self, user: User, sample_pdf: Path, tmp_path: Path
    ):
        await user.open("/")
        _refs()["pick_save_path"] = lambda name: None
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        await _apply(user)
        await asyncio.sleep(0.2)
        assert _refs()["state"].saved_path is None
        assert _refs()["state"].output_path.exists()

    async def test_apply_with_deselected(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        user.find("Deseleziona tutto").click()
        user.find("Rimuovi immagini selezionate").click()
        await _wait_for(lambda: user.notify.contains("Seleziona almeno"))
        assert _refs()["result_label"].text == ""
        assert _refs()["state"].output_path is None

    async def test_apply_with_exclude(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        _set_value(user, "exclude_input", "1")
        await _analyze(user)
        text = await _apply(user)
        assert "Fatto!" in text
        out = _refs()["state"].output_path
        assert out is not None and out.exists()
        with pymupdf.open(out) as d:
            assert len(d) == 3
            contents = [d[i].read_contents().decode("latin-1", "replace") for i in range(3)]
            assert " Do" in contents[0]
            assert all(" Do" not in c for c in contents[1:])

    async def test_output_label_shows_name(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        await _apply(user)
        label = str(_refs()["output_label"].text)
        assert "Output:" in label
        assert "_nobg.pdf" in label


# ---------------------------------------------------------------------------
# Full flow
# ---------------------------------------------------------------------------


class TestFullFlow:
    async def test_complete_workflow(self, user: User, sample_pdf: Path):
        """Upload -> analyze -> deselect one candidate -> apply -> verify."""
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        assert _refs()["analyze_btn"].enabled is True

        await _analyze(user)
        assert len(_refs()["state"].candidates) == 3
        assert _refs()["apply_btn"].enabled is True

        checkbox = _candidate_checkbox(user, 0)
        with user:
            checkbox.set_value(False)
        assert _refs()["state"].candidates[0].selected is False

        text = await _apply(user)
        assert "Fatto!" in text
        assert "(2 immagini)" in text

        out = _refs()["state"].output_path
        assert out is not None and out.exists()
        with pymupdf.open(out) as d:
            assert len(d) == 3
        assert out.stat().st_size < sample_pdf.stat().st_size

    async def test_reanalyze_after_apply(self, user: User, sample_pdf: Path):
        await user.open("/")
        await _upload_pdf(user, sample_pdf)
        await _analyze(user)
        await _apply(user)

        await _analyze(user)
        assert len(_refs()["state"].candidates) == 3
        assert _refs()["analyze_btn"].enabled is True
