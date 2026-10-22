import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

import { BROKEN_PDF, SAMPLE_PDF } from './global-setup';

async function upload(page: Page, path: string): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(path);
}

async function analyze(page: Page): Promise<void> {
  await page.getByTestId('analyze-button').click();
  await expect(page.getByTestId('info-label')).not.toContainText('Nessuna analisi');
}

/** Larghezza delle immagini XObject presenti nel PDF. */
async function imageWidths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  const widths: number[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      const width = obj.dict.get(PDFName.of('Width'));
      widths.push(width && 'asNumber' in width ? (width as { asNumber: () => number }).asNumber() : -1);
    }
  }
  return widths;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('carica un PDF e lo analizza', async ({ page }) => {
  await upload(page, SAMPLE_PDF);
  await expect(page.getByTestId('file-label')).toContainText('sample.pdf');

  await analyze(page);

  await expect(page.getByTestId('candidate-card')).toHaveCount(3);
  await expect(page.getByTestId('info-label')).toContainText('3 immagini candidate');
  await expect(page.getByTestId('selected-count')).toContainText('3 / 3');
  await expect(page.getByTestId('progress-percent')).toContainText('100%');
});

test('mostra le anteprime dell\'immagine e della pagina', async ({ page }) => {
  await upload(page, SAMPLE_PDF);
  await analyze(page);

  const image = page.getByTestId('candidate-image').first();
  await expect(image).toBeVisible();
  expect(await image.getAttribute('src')).toMatch(/^data:image\/png;base64,/);

  const pagePreview = page.getByTestId('candidate-page').first();
  await expect(pagePreview).toBeVisible();
  expect(await pagePreview.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);
});

test('rimuove lo sfondo e produce un PDF scaricabile', async ({ page }) => {
  await upload(page, SAMPLE_PDF);
  await analyze(page);

  await page.getByTestId('apply-button').click();
  await expect(page.getByTestId('result-label')).toContainText('3 immagini rimosse');
  await expect(page.getByTestId('output-label')).toContainText('sample_nobg.pdf');

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-button').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('sample_nobg.pdf');

  // Chromium supporta la File System Access API: il pulsante "Salva come..." e' disponibile
  await expect(page.getByTestId('save-as-button')).toBeVisible();
  await expect(page.getByTestId('no-save-as-hint')).toHaveCount(0);

  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);

  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(3);

  // gli sfondi 8x8 sono stati sostituiti da immagini 1x1, la piccola immagine
  // non selezionata (4x4) e' rimasta al suo posto
  const widths = await imageWidths(bytes);
  expect(widths.length).toBeGreaterThan(0);
  expect(widths).not.toContain(8);
  expect(widths.filter((width) => width === 4).length).toBe(1);
  expect(widths.every((width) => width === 1 || width === 4)).toBe(true);
});

test('deseleziona un candidato prima di applicare', async ({ page }) => {
  await upload(page, SAMPLE_PDF);
  await analyze(page);

  await page.getByTestId('candidate-checkbox').first().click();
  await expect(page.getByTestId('selected-count')).toContainText('2 / 3');

  await page.getByTestId('apply-button').click();
  await expect(page.getByTestId('result-label')).toContainText('2 immagini rimosse');
});

test('in dry-run non genera il file di output', async ({ page }) => {
  await upload(page, SAMPLE_PDF);
  await analyze(page);

  await page.getByTestId('dry-run-checkbox').check();
  await page.getByTestId('apply-button').click();

  await expect(page.getByTestId('result-label')).toContainText('Dry-run completato');
  await expect(page.getByTestId('download-button')).toHaveCount(0);
});

test('esclude le pagine indicate', async ({ page }) => {
  await upload(page, SAMPLE_PDF);
  await page.getByTestId('exclude-input').fill('1');
  await analyze(page);

  await expect(page.getByTestId('candidate-card')).toHaveCount(2);
  await expect(page.getByTestId('info-label')).toContainText('2 immagini candidate');
});

test('segnala un file non valido', async ({ page }) => {
  await upload(page, BROKEN_PDF);
  await page.getByTestId('analyze-button').click();

  await expect(page.getByTestId('error-label')).toBeVisible();
});

test('segnala una specifica di pagine non valida', async ({ page }) => {
  await upload(page, SAMPLE_PDF);
  await page.getByTestId('exclude-input').fill('99');
  await page.getByTestId('analyze-button').click();

  await expect(page.getByTestId('error-label')).toContainText('non valido');
});

test('seleziona e deseleziona tutti i candidati', async ({ page }) => {
  await upload(page, SAMPLE_PDF);
  await analyze(page);

  await page.getByTestId('select-none').click();
  await expect(page.getByTestId('selected-count')).toContainText('0 / 3');

  await page.getByTestId('invert-selection').click();
  await expect(page.getByTestId('selected-count')).toContainText('3 / 3');

  await page.getByTestId('select-all').click();
  await expect(page.getByTestId('selected-count')).toContainText('3 / 3');
});
