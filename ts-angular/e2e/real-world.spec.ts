import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

/** PDF di prova del repository (non tracciato in git: i PDF sono ignorati). */
const REAL_PDF = join(__dirname, '..', '..', 'test.pdf');

test('PDF reale: analisi, anteprime e rimozione', async ({ page }) => {
  test.setTimeout(300_000);
  test.skip(!existsSync(REAL_PDF), 'test.pdf non presente nel repository');

  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles(REAL_PDF);
  await expect(page.getByTestId('file-label')).toContainText('test.pdf');

  await page.getByTestId('analyze-button').click();
  await expect(page.getByTestId('info-label')).not.toContainText('Nessuna analisi', {
    timeout: 240_000,
  });

  // il documento ha 22 pagine con sfondo a pieno pagina
  await expect(page.getByTestId('candidate-card')).toHaveCount(22);

  await expect(page.getByTestId('candidate-image').first()).toBeVisible();
  await expect(page.getByTestId('candidate-page').first()).toBeVisible();

  await page.getByTestId('apply-button').click();
  await expect(page.getByTestId('result-label')).toContainText('22 immagini rimosse', {
    timeout: 240_000,
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-button').click();
  const download = await downloadPromise;
  const path = await download.path();
  const bytes = await readFile(path!);

  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(22);

  let images = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      images++;
    }
  }
  expect(images).toBeGreaterThan(0);
});
