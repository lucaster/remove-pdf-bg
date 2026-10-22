import { PDFDocument, PDFImage, StandardFonts, rgb } from 'pdf-lib';

import { solidPng } from './png';

export interface FixtureOptions {
  /** Numero di pagine. */
  pages?: number;
  /** Immagine a pieno pagina su ogni pagina. */
  background?: boolean;
  /** Stessa immagine condivisa fra tutte le pagine (stesso xref). */
  sharedBackground?: boolean;
  /** Piccola immagine (bassa copertura) sull'ultima pagina. */
  smallImage?: boolean;
  /** Testo sulla pagina. */
  text?: boolean;
  /** Colore dello sfondo. */
  color?: [number, number, number];
}

export const PAGE_WIDTH = 200;
export const PAGE_HEIGHT = 200;

/**
 * Crea un PDF di prova con immagini XObject a pieno pagina.
 * E' la base dei test unitari e dei fixture end-to-end.
 */
export async function createFixturePdf(options: FixtureOptions = {}): Promise<Uint8Array> {
  const {
    pages = 2,
    background = true,
    sharedBackground = false,
    smallImage = false,
    text = false,
    color = [200, 200, 200],
  } = options;

  const doc = await PDFDocument.create();
  const font = text ? await doc.embedFont(StandardFonts.Helvetica) : null;

  const sharedImage = sharedBackground && background ? await doc.embedPng(solidPng(8, 8, color)) : null;
  const small = smallImage ? await doc.embedPng(solidPng(4, 4, [10, 120, 200])) : null;

  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    if (background) {
      const image: PDFImage = sharedBackground
        ? (sharedImage as PDFImage)
        : await doc.embedPng(solidPng(8, 8, color));
      page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
    }

    if (font) {
      page.drawText('Pagina ' + (i + 1), {
        x: 20,
        y: 100,
        size: 12,
        font,
        color: rgb(0, 0, 0),
      });
    }

    if (small && i === pages - 1) {
      page.drawImage(small, { x: 10, y: 10, width: 20, height: 20 });
    }
  }

  return doc.save();
}
