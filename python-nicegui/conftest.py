"""Shared fixtures for tests."""
import shutil
from pathlib import Path

import pymupdf
import pytest

pytest_plugins = ['nicegui.testing.user_plugin']


@pytest.fixture(scope="session", autouse=True)
def _clean_uploads_dir() -> None:
    shutil.rmtree("uploads", ignore_errors=True)


def _make_bg_png(width: int = 200, height: int = 200, gray: int = 180) -> bytes:
    """Create a solid-color PNG image."""
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height))
    pix.clear_with(gray)
    return pix.tobytes("png")


@pytest.fixture
def sample_pdf(tmp_path: Path) -> Path:
    """PDF with 3 pages, each having a full-page background image + text."""
    pdf = tmp_path / "sample.pdf"
    doc = pymupdf.open()
    img_bytes = _make_bg_png()
    for i in range(3):
        page = doc.new_page(width=595, height=842)
        page.insert_image(page.rect, stream=img_bytes)
        page.insert_text((72, 72), f"Page {i + 1} content", fontsize=12)
    doc.save(pdf)
    doc.close()
    return pdf


@pytest.fixture
def multi_image_pdf(tmp_path: Path) -> Path:
    """PDF with 4 pages: full-page bg (~100%) + medium image (~70%) per page."""
    pdf = tmp_path / "multi.pdf"
    doc = pymupdf.open()
    bg_bytes = _make_bg_png(200, 200, 200)
    mid_bytes = _make_bg_png(100, 100, 100)
    for i in range(4):
        page = doc.new_page(width=595, height=842)
        page.insert_image(page.rect, stream=bg_bytes)
        page.insert_image(pymupdf.Rect(0, 0, 595, 590), stream=mid_bytes)
        page.insert_text((72, 400), f"Page {i + 1}", fontsize=14)
    doc.save(pdf)
    doc.close()
    return pdf
