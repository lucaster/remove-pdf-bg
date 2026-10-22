import { getDocument, GlobalWorkerOptions, PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', document.baseURI).href;

const assetUrl = (folder: string): string =>
  new URL(folder + '/', document.baseURI).href;

export const PAGE_PREVIEW_MAX_HEIGHT = 600;

/**
 * Apre il PDF con pdf.js per il rendering delle anteprime di pagina.
 * I dati vengono copiati: pdf.js trasferisce il buffer al suo worker,
 * rendendolo inutilizzabile nel thread principale.
 */
export function openPreviewDocument(bytes: Uint8Array): PDFDocumentLoadingTask {
  return getDocument({
    data: bytes.slice(),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
  });
}

/** Renderizza una pagina in un data URL JPEG. */
export async function renderPagePreview(
  doc: PDFDocumentProxy,
  pageIndex: number,
  maxHeight: number = PAGE_PREVIEW_MAX_HEIGHT,
): Promise<string> {
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1, maxHeight / base.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
  return canvas.toDataURL('image/jpeg', 0.8);
}
