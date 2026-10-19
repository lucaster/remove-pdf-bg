# remove-pdf-bg - Detailed Implementation Analysis Report

**Repository:** C:\Users\Luca\Projects\remove-pdf-bg  
**Date:** 2026-10-18  

This report thoroughly documents the two existing implementations (Python and Java) to guide creation of a third JavaScript/TypeScript version with identical behavior.

## 1. Directory Structure (core files, excluding node_modules/.git/__pycache__/target/.specify/.opencode)
- .gitignore
- 35 Fiends & Flames 5e - Lair Magazine November 2023.pdf
- analysis-report-final.md
- java-cli\dependency-reduced-pom.xml
- java-cli\pom.xml
- java-cli\src\main\java\RemovePdfBg.java
- LICENSE
- Loot & Lore PDF v1.pdf
- python-cli\remove-pdf-bg.py
- python-nicegui\README.md
- python-nicegui\requirements.txt
- README.md
- test.pdf
- tests\compare.py



## 2. Two Implementations Overview

Both tools remove background images from PDFs (images covering >= threshold of page area). Text and vector graphics remain intact. They share identical CLI, validation, output format, and error messages.

### 2.1 Python Implementation

- **Language:** Python 3.11
- **Library:** PyMuPDF 1.28.2 (pymupdf/fitz)
- **Location:** python-cli/remove-pdf-bg.py (213 lines)
- **Entry point:** main() (l. 169-213)
- **Dependencies:** pymupdf (install with pip)

Key functions:
- parse_pages(spec, n_pages) (28-48): parse page ranges like '1,3,5-7','5-','-3' (1-based), return 0-based set
- isible_rect_size(page) (51-57): non-rotated page rect; handles 90/270° rotation (swaps width/height)
- coverage(bbox, page_rect) (60-66): intersection area / page area
- strip_image_from_page(page, xref) (69-93): per-page removal by regex replacing /(?<!\w/)/name\s+Do\b in all content streams; returns False if image name not found (e.g. inside Form XObject). Uses ISO-8859-1 decode/encode.
- emove_backgrounds(src, dst, threshold, excluded, dry_run) (95-166): core processing
- main() (169-213): CLI parsing, validation

Behavior (Python):
1. Open PDF, build protected set: for each excluded page, add all image xrefs from that page via page.get_images(full=True) (img[0]) - these images are shared with excluded pages.
2. For each non-excluded page: scan images via page.get_image_info(xrefs=True). Skip if xref==0 (inline) or already seen on page. Compute coverage = intersection(bbox, visible_rect)/page_area. If coverage < threshold, skip.
3. If not dry-run: if xref in protected, try strip_image_from_page() (lookup name in page images). If fails, log warning "sfondo (xref X) non rimovibile (dentro un Form XObject) -> saltato". Else if not already replaced globally, call page.delete_image(xref) and mark replaced.
4. Save with doc.save(dst, garbage=4, deflate=True, use_objstms=True).

### 2.2 Java Implementation

- **Language:** Java 17
- **Library:** Apache PDFBox 3.0.8
- **Location:** java-cli/src/main/java/RemovePdfBg.java (491 lines)
- **Build:** Maven (java-cli/pom.xml) - shaded jar via maven-shade-plugin; jpackage profile for self-contained exe
- **Entry point:** main(String[] args) (l. 391-490)

Key classes/methods:
- Placement and FoundImage (records, l. 63-68)
- ImageScanner extends PDFStreamEngine (l. 76-119): registers Save/Restore/Concatenate; overrides processOperator to catch "Do" with COSName. For PDImageXObject: record first placement (by xref) via CTM of unit square. For PDFormXObject: recurse with showForm() (depth limit 50).
- parsePages() (123-152), boxOfUnitSquare() (154-164), coverage() (166-177), xrefOf() (180-186)
- stripImageFromPage() (193-210): reads all page contents, regex replaces /(?<![\w/])/name\s+Do\b in ISO-8859-1, writes back if changed
- eplaceImageWithTransparent() (217-242): creates 1x1 transparent image with SMask (all zeros) and overwrites COSStream keys to replace image object globally
- collectImageXrefs() (245-269): recursively collects image xrefs from PDResources, including Form XObjects (depth 50)
- pageLevelImageNames() (272-288): maps xref->name for images at page's top-level XObject dict
- emoveBackgrounds() (290-371): core logic; uses page.getCropBox() for page rect
- main/usage/fail() (373-490): CLI parsing, validation, errors

Behavior (Java):
1. Build protected xrefs by collecting all image xrefs from excluded pages' resources (recursive into Form XObjects): collectImageXrefs() on each excluded page.
2. For each non-excluded page: create ImageScanner and call processPage(page) (scanner recurses into forms). This finds all drawn images with their placement bbox (CTM of unit square). Also get page-level image names map.
3. For each found image (by xref): compute coverage = intersection(bbox, cropBox)/area. If < threshold skip. If not dry-run: if protected, look up name in pageLevelImageNames; if missing or strip fails, warn and skip. Else if not already replaced, replace image COSStream with transparent 1x1 globally.
4. Save with CompressParameters.DEFAULT_COMPRESSION (PDFBox equivalent to PyMuPDF's garbage/deflate/use_objstms).

### 2.3 Key Behavioral Differences & Equivalents

| Aspect | Python (PyMuPDF) | Java (PDFBox) |
|---|---|---|
| Image discovery | page.get_image_info(xrefs=True) - returns images on page | ImageScanner scans content streams + recurses into Form XObjects (depth 50) |
| Bbox computation | From image info | CTM transforms unit square [0,1]^2 |
| Page rect for coverage | isible_rect_size() - non-rotated rect, handles 90/270° | page.getCropBox() (CTM naturally accounts for rotation) |
| Inline images | Skipped if xref==0 | Treated by object identity; rare for backgrounds |
| Protected/shared images | Collect xrefs from excluded pages via page.get_images(full=True) on each excluded page | Collect xrefs from excluded pages' resources recursively (including forms) |
| Per-page stripping | Lookup name in page's image list (via get_images) for that xref; regex on all content streams | Lookup name in page-level XObject dict only; regex on page contents |
| Global removal | page.delete_image(xref) - replaces object globally | eplaceImageWithTransparent() overwrites COSStream with 1x1 transparent + SMask globally |
| Coverage formula | intersect(bbox,page_rect)/page_rect.area (clipped) | Same with crop box |
| Form recursion (detection) | Implicit via get_image_info | Explicit depth 50 |
| Form recursion (protected) | No recursion in collection shown (just page images) | Recursive depth 50 |
| Save | garbage=4, deflate=True, use_objstms=True | CompressParameters.DEFAULT_COMPRESSION |
| Deduplication | Skip if xref in seen_on_page; track already_replaced globally | putIfAbsent by xref in placements; track alreadyReplaced globally |

**Important note from compare.py:** On some PDFs, PyMuPDF reports fewer images removed than Java because page.delete_image() replaces the object globally and subsequent pages no longer see it in accounting; pixel rendering identity remains the decisive verification.


## 3. CLI, Validation, Output Format (Identical)

**CLI arguments:**
- Positional: input.pdf (required)
- -o, --output FILE (default: <input>_nobg.pdf)
- -t, --threshold N (default: 95) - accepts percent (95) or fraction (0.95); normalized as threshold/100 if > 1
- -e, --exclude SPEC - page ranges like 1,3,10-12, 5-, -3 (1-based indexing)
- -d, --dry-run - report only, no output file written
- -h, --help - show usage

**Validation:**
- Input file must exist
- Output file must be different from input (resolved/normalized paths compared)
- Threshold must be in (0,100] after normalization (0 < threshold <= 1)
- Page ranges must be valid: start>=1, end<=nPages, start<=end

**Error messages (Italian):**
- "File non trovato: <path>" (if input doesn't exist)
- "Il file di output deve essere diverso da quello di input." (if same)
- "La soglia deve essere tra 0 e 100 (%)." (if invalid threshold)
- "Intervallo di pagine non valido: '<part>' (il PDF ha <n> pagine)" (if bad range)

**Output messages:**
- Pagina %4d: esclusa - for excluded pages
- Pagina %4d: trovato sfondo (xref %d, copertura %.0f%%) - dry-run match
- Pagina %4d: rimosso sfondo (xref %d, copertura %.0f%%) - actual removal
- Pagina %4d: sfondo (xref %d) non rimovibile (dentro un Form XObject) -> saltato - cannot strip per-page
- Salvataggio in corso... - before saving (Python flushes; Java prints without newline then flushes then newline)
- Immagini %s: %d su %d pagine (totale pagine: %d) - summary ("individuate" if dry-run, "rimosse" if removal)
- File salvato in: <path> - final message (non-dry-run only)

Exit codes: non-zero on errors (both use sys.exit/fail with System.exit).

## 4. Tests, Samples, Test Harness

**Sample PDFs (root):**
- 	est.pdf (7.49 MB, 22 pages) - both find/remove 22 backgrounds (100% coverage)
- 35 Fiends & Flames 5e - Lair Magazine November 2023.pdf (81.18 MB)
- Loot & Lore PDF v1.pdf (66.94 MB)

**Test harness:** 	ests/compare.py (288 lines)
- Compares Java vs Python with identical arguments
- Verifies (1) pixel-per-pixel rendering identity at configurable dpi (default 50) via PyMuPDF; (2) stdout message parity (body lines)
- In dry-run or with --strict-stdout, text must match strictly. In normal removal, text differences are warnings (not fails) because of accounting differences; rendering identity is decisive.
- Supports --dpi, --max-pages (sampling), --threshold, --exclude, --dry-run, --strict-stdout, --keep, --jar, --exe
- Normalizes stdout: strips 'File salvato in:' lines and trailing spaces; splits into body vs summary
- Exit code 0 only if all comparisons pass

**Artifacts:** java-cli/target/remove-pdf-bg.jar, java-cli/target/original-remove-pdf-bg.jar, java-cli/target/dist/remove-pdf-bg/ (exe + app + jlink runtime)


## 5. Critical Implementation Details for JS/TS

To match behavior exactly for a third implementation:

1. **Image discovery & CTM:** Scan content streams for 'Do' operators; maintain graphics state (q/Q, cm/concatenate). For each image XObject draw, compute bbox by transforming unit square [0,1]^2 with current CTM. Record first placement per xref. Recurse into Form XObjects with depth limit (50). Deduplicate by xref per page.

2. **Coverage:** coverage = intersection(bbox, pageRect) / pageRect.area where intersection is clipped to pageRect. Page rect should be non-rotated/visible rect (handle rotation appropriately). Condition is coverage >= threshold.

3. **Protected/shared images:** Build protected set of image xrefs referenced from excluded pages' resources including Form XObjects (recursive). When image needs removal but is protected, attempt per-page stripping: remove the /name Do operator from the drawing page's content streams only. If the name is not found at page/resource level accessible for that draw context (nested in form), stripping fails → log warning and skip.

4. **Global removal:** Replace the image XObject (the actual image stream/object) with a 1x1 transparent image that includes a soft mask (SMask) filled with zeros. This affects all references globally.

5. **Page range parsing:** Parse comma-separated ranges with optional open ends ('5-', '-3'), 1-based in spec, convert to 0-based set. Validate bounds against total pages.

6. **Content stream handling:** For stripping, work with content stream data decoded in a PDF-compatible way (ISO-8859-1 equivalent). Regex: match /name Do not preceded by identifier chars (negative lookbehind (?<![\w/])) with word boundary before Do.

7. **Form traversal:** Both for detection (find images drawn) and for collecting protected xrefs (find all image XObjects in resources), recurse into Form XObjects with depth limit 50.

8. **CLI/messages/validation/exit codes:** Match exactly as specified - important for compatibility with 	ests/compare.py.

## 6. Verification

On 	est.pdf: both implementations detect/remove 22 backgrounds with identical per-page dry-run output. Pixel rendering identity is the key acceptance criterion (as per compare.py).

## 7. Key Files

| File | Lines | Notes |
|---|---|---|
| python-cli/remove-pdf-bg.py | 213 | Reference implementation (PyMuPDF) |
| java-cli/src/main/java/RemovePdfBg.java | 491 | Java implementation (PDFBox 3.0.8) |
| java-cli/pom.xml | 158 | Build config |
| 	ests/compare.py | 288 | Comparison harness - use for validation |
| README.md | 64 | Usage |
| Sample PDFs | - | test.pdf, 35 Fiends & Flames..., Loot & Lore... |
