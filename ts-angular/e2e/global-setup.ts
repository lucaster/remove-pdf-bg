import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createFixturePdf } from '../src/testing/pdf-fixture';

export const FIXTURE_DIR = join(__dirname, 'fixtures');
export const SAMPLE_PDF = join(FIXTURE_DIR, 'sample.pdf');
export const BROKEN_PDF = join(FIXTURE_DIR, 'broken.pdf');

/** Genera i PDF di prova usati dagli scenari end-to-end. */
export default async function globalSetup(): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });

  const sample = await createFixturePdf({
    pages: 3,
    background: true,
    text: true,
    smallImage: true,
  });
  await writeFile(SAMPLE_PDF, sample);

  await writeFile(BROKEN_PDF, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]));
}
