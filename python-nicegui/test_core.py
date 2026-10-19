"""Unit test per la logica core (parse_pages, analyze_pdf, apply_removal)."""
from pathlib import Path

import pymupdf
import pytest

from gui import (
    AnalysisResult,
    CandidateImage,
    analyze_pdf,
    apply_removal,
    can_strip_image_from_page,
    coverage_pct,
    data_url,
    get_image_name_on_page,
    parse_pages,
    pick_pdf_file,
    preview_image,
    visible_rect_size,
)


# ---------------------------------------------------------------------------
# parse_pages
# ---------------------------------------------------------------------------


class TestParsePages:
    def test_empty(self):
        assert parse_pages("", 10) == set()
        assert parse_pages("  ", 10) == set()

    def test_single(self):
        assert parse_pages("1", 10) == {0}
        assert parse_pages("5", 10) == {4}

    def test_multiple(self):
        assert parse_pages("1,3", 10) == {0, 2}
        assert parse_pages("1,3,5", 10) == {0, 2, 4}

    def test_range(self):
        assert parse_pages("3-5", 10) == {2, 3, 4}

    def test_open_range_end(self):
        assert parse_pages("8-", 10) == {7, 8, 9}

    def test_open_range_start(self):
        assert parse_pages("-3", 10) == {0, 1, 2}

    def test_mixed(self):
        assert parse_pages("1,3,5-7", 10) == {0, 2, 4, 5, 6}
        assert parse_pages("1, 3 , 5-7", 10) == {0, 2, 4, 5, 6}

    def test_full_range(self):
        assert parse_pages("1-10", 10) == set(range(10))

    def test_invalid_single(self):
        with pytest.raises(ValueError):
            parse_pages("15", 10)

    def test_invalid_range(self):
        with pytest.raises(ValueError):
            parse_pages("5-15", 10)

    def test_invalid_reversed(self):
        with pytest.raises(ValueError):
            parse_pages("7-3", 10)

    def test_invalid_zero(self):
        with pytest.raises(ValueError):
            parse_pages("0", 10)


# ---------------------------------------------------------------------------
# coverage_pct
# ---------------------------------------------------------------------------


class TestCoveragePct:
    def test_full_coverage(self):
        page = pymupdf.Rect(0, 0, 100, 100)
        img = pymupdf.Rect(0, 0, 100, 100)
        assert coverage_pct(img, page) == pytest.approx(100.0)

    def test_half_coverage(self):
        page = pymupdf.Rect(0, 0, 100, 100)
        img = pymupdf.Rect(0, 0, 50, 100)
        assert coverage_pct(img, page) == pytest.approx(50.0)

    def test_quarter_coverage(self):
        page = pymupdf.Rect(0, 0, 100, 100)
        img = pymupdf.Rect(0, 0, 50, 50)
        assert coverage_pct(img, page) == pytest.approx(25.0)

    def test_no_coverage(self):
        page = pymupdf.Rect(0, 0, 100, 100)
        img = pymupdf.Rect(200, 200, 300, 300)
        assert coverage_pct(img, page) == 0.0

    def test_partial_overlap(self):
        page = pymupdf.Rect(0, 0, 100, 100)
        img = pymupdf.Rect(50, 0, 150, 100)
        assert coverage_pct(img, page) == pytest.approx(50.0)

    def test_overflow_coverage(self):
        page = pymupdf.Rect(0, 0, 100, 100)
        img = pymupdf.Rect(-50, -50, 150, 150)
        assert coverage_pct(img, page) == pytest.approx(100.0)


# ---------------------------------------------------------------------------
# analyze_pdf
# ---------------------------------------------------------------------------


class TestAnalyzePdf:
    def test_finds_candidates(self, sample_pdf: Path):
        result = analyze_pdf(sample_pdf, 95.0, "", progress_callback=None)
        assert isinstance(result, AnalysisResult)
        assert result.total_pages == 3
        assert len(result.candidates) == 3
        for c in result.candidates:
            assert c.coverage_pct >= 95.0
            assert c.selected is True
            assert c.image_data is not None
            assert c.page_pixmap_data is not None

    def test_threshold_filters(self, multi_image_pdf: Path):
        # At 95% only the full-page bg qualifies
        high = analyze_pdf(multi_image_pdf, 95.0, "", progress_callback=None)
        # At 50% the medium image (~70% coverage) qualifies too
        mid = analyze_pdf(multi_image_pdf, 50.0, "", progress_callback=None)
        # At 1% everything qualifies
        low = analyze_pdf(multi_image_pdf, 1.0, "", progress_callback=None)
        assert len(high.candidates) == 4  # one bg per page
        assert len(mid.candidates) == 8  # bg + medium image per page
        assert len(low.candidates) == 8
        assert len(high.candidates) < len(mid.candidates) == len(low.candidates)

    def test_exclude_pages(self, sample_pdf: Path):
        result = analyze_pdf(sample_pdf, 95.0, "1", progress_callback=None)
        pages = {c.page_idx for c in result.candidates}
        assert 0 not in pages  # page 1 excluded
        assert len(result.candidates) == 2

    def test_exclude_multiple(self, sample_pdf: Path):
        result = analyze_pdf(sample_pdf, 95.0, "1,3", progress_callback=None)
        pages = {c.page_idx for c in result.candidates}
        assert pages == {1}

    def test_exclude_all(self, sample_pdf: Path):
        result = analyze_pdf(sample_pdf, 95.0, "1-3", progress_callback=None)
        assert len(result.candidates) == 0

    def test_invalid_exclude(self, sample_pdf: Path):
        with pytest.raises(ValueError):
            analyze_pdf(sample_pdf, 95.0, "99", progress_callback=None)

    def test_progress_callback_called(self, sample_pdf: Path):
        calls = []
        analyze_pdf(sample_pdf, 95.0, "", progress_callback=lambda p, m: calls.append((p, m)))
        assert len(calls) > 0
        assert calls[0][0] == pytest.approx(0.0)
        assert calls[-1][0] == pytest.approx(1.0)

    def test_candidate_metadata(self, sample_pdf: Path):
        result = analyze_pdf(sample_pdf, 95.0, "", progress_callback=None)
        c = result.candidates[0]
        assert c.page_idx == 0
        assert c.xref > 0
        assert c.img_name is not None
        assert len(c.bbox) == 4
        assert 95.0 <= c.coverage_pct <= 100.0


# ---------------------------------------------------------------------------
# preview helpers
# ---------------------------------------------------------------------------


class TestPreviewHelpers:
    @staticmethod
    def _jpeg(width: int, height: int) -> bytes:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height))
        pix.clear_with(100)
        return pix.tobytes(output="jpeg")

    @staticmethod
    def _png(width: int, height: int) -> bytes:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height))
        pix.clear_with(100)
        return pix.tobytes(output="png")

    def test_data_url_detects_jpeg(self):
        assert data_url(self._jpeg(4, 4)).startswith("data:image/jpeg;base64,")

    def test_data_url_detects_png(self):
        assert data_url(self._png(4, 4)).startswith("data:image/png;base64,")

    def test_preview_shrinks_large_image(self):
        out = preview_image(self._jpeg(1000, 700), max_dim=512)
        assert out.startswith(b"\xff\xd8\xff")
        pix = pymupdf.Pixmap(out)
        assert pix.width <= 512
        assert pix.height <= 512

    def test_preview_keeps_small_image(self):
        data = self._jpeg(100, 80)
        assert preview_image(data) == data

    def test_preview_shrinks_large_png_to_jpeg(self):
        out = preview_image(self._png(800, 600))
        assert out.startswith(b"\xff\xd8\xff")


# ---------------------------------------------------------------------------
# native file dialog
# ---------------------------------------------------------------------------


class TestPickPdfFile:
    class _Proc:
        def __init__(self, stdout: str, returncode: int = 0):
            self.stdout = stdout
            self.returncode = returncode

    def test_returns_selected_path(self, sample_pdf: Path):
        result = pick_pdf_file(run=lambda cmd, **kw: self._Proc(f"{sample_pdf}\r\n"))
        assert result == sample_pdf

    def test_cancelled_returns_none(self):
        assert pick_pdf_file(run=lambda cmd, **kw: self._Proc("")) is None

    def test_whitespace_only_returns_none(self):
        assert pick_pdf_file(run=lambda cmd, **kw: self._Proc("  \n")) is None

    def test_error_exit_returns_none(self):
        assert pick_pdf_file(run=lambda cmd, **kw: self._Proc("", 1)) is None

    def test_exception_returns_none(self):
        def boom(cmd, **kw):
            raise FileNotFoundError("no python")

        assert pick_pdf_file(run=boom) is None


# ---------------------------------------------------------------------------
# apply_removal
# ---------------------------------------------------------------------------


class TestApplyRemoval:
    def _all_selected(self, result: AnalysisResult) -> dict:
        sel: dict = {}
        for c in result.candidates:
            sel.setdefault(c.page_idx, set()).add(c.xref)
        return sel

    def test_removal_reduces_size(self, sample_pdf: Path, tmp_path: Path):
        out = tmp_path / "out.pdf"
        result = analyze_pdf(sample_pdf, 95.0, "", progress_callback=None)
        sel = self._all_selected(result)
        removed = apply_removal(sample_pdf, out, 95.0, "", sel, progress_callback=None)
        assert removed == len(result.candidates)
        assert out.exists()
        assert out.stat().st_size < sample_pdf.stat().st_size

    def test_output_valid_pdf(self, sample_pdf: Path, tmp_path: Path):
        out = tmp_path / "out.pdf"
        result = analyze_pdf(sample_pdf, 95.0, "", progress_callback=None)
        sel = self._all_selected(result)
        apply_removal(sample_pdf, out, 95.0, "", sel, progress_callback=None)
        with pymupdf.open(out) as d:
            assert len(d) == 3

    def test_dry_run_no_file(self, sample_pdf: Path, tmp_path: Path):
        out = tmp_path / "out.pdf"
        result = analyze_pdf(sample_pdf, 95.0, "", progress_callback=None)
        sel = self._all_selected(result)
        apply_removal(sample_pdf, out, 95.0, "", sel, progress_callback=None, dry_run=True)
        assert not out.exists()

    def test_selective_removal(self, multi_image_pdf: Path, tmp_path: Path):
        out = tmp_path / "out.pdf"
        result = analyze_pdf(multi_image_pdf, 95.0, "", progress_callback=None)
        # Select only first 2 candidates
        sel: dict = {}
        for c in result.candidates[:2]:
            sel.setdefault(c.page_idx, set()).add(c.xref)
        removed = apply_removal(multi_image_pdf, out, 95.0, "", sel, progress_callback=None)
        assert removed == 2
        assert out.exists()

    def test_empty_selection(self, sample_pdf: Path, tmp_path: Path):
        out = tmp_path / "out.pdf"
        removed = apply_removal(sample_pdf, out, 95.0, "", {}, progress_callback=None)
        assert removed == 0
        # File is still created (empty removal)
        assert out.exists()

    def test_excluded_pages_untouched(self, sample_pdf: Path, tmp_path: Path):
        out = tmp_path / "out.pdf"
        result = analyze_pdf(sample_pdf, 95.0, "1", progress_callback=None)
        sel = self._all_selected(result)
        apply_removal(sample_pdf, out, 95.0, "1", sel, progress_callback=None)
        with pymupdf.open(out) as d:
            # Excluded page 1 must still draw its image
            assert " Do" in d[0].read_contents().decode("latin-1", "replace")
            # Pages 2-3 had the bg stripped from their content streams
            for idx in (1, 2):
                assert " Do" not in d[idx].read_contents().decode("latin-1", "replace")

    def test_progress_callback(self, sample_pdf: Path, tmp_path: Path):
        calls = []
        out = tmp_path / "out.pdf"
        result = analyze_pdf(sample_pdf, 95.0, "", progress_callback=None)
        sel = self._all_selected(result)
        apply_removal(sample_pdf, out, 95.0, "", sel, progress_callback=lambda p, m: calls.append(p))
        assert len(calls) > 0
        assert calls[-1] == pytest.approx(1.0)
