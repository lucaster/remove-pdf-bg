import { PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib';

import { analyzeDocument, applyRemoval, parsePages, saveDocument } from './core';
import { createFixturePdf } from '../../testing/pdf-fixture';

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true });
}

/** Trova tutti gli stream immagine presenti nel documento. */
function imageStreams(doc: PDFDocument): PDFRawStream[] {
  const out: PDFRawStream[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      out.push(obj);
    }
  }
  return out;
}

function numberOf(stream: PDFStream, key: string): number | null {
  const value = stream.dict.get(PDFName.of(key));
  if (value instanceof PDFName) return null;
  const resolved = value && 'asNumber' in value ? (value as { asNumber: () => number }) : null;
  return resolved ? resolved.asNumber() : null;
}

describe('parsePages', () => {
  it('restituisce un set vuoto per una specifica vuota', () => {
    expect(parsePages('', 10).size).toBe(0);
    expect(parsePages('   ', 10).size).toBe(0);
  });

  it('converte una lista di pagine in indici 0-based', () => {
    expect([...parsePages('1,3,5', 10)]).toEqual([0, 2, 4]);
  });

  it('supporta gli intervalli', () => {
    expect([...parsePages('2-4', 10)]).toEqual([1, 2, 3]);
  });

  it('supporta gli intervalli aperti', () => {
    expect([...parsePages('9-', 10)]).toEqual([8, 9]);
    expect([...parsePages('-2', 10)]).toEqual([0, 1]);
  });

  it('ignora spazi', () => {
    expect([...parsePages('1, 3 , 5', 10)]).toEqual([0, 2, 4]);
  });

  it('rifiuta pagine fuori intervallo', () => {
    expect(() => parsePages('0', 10)).toThrow(/non valido/);
    expect(() => parsePages('11', 10)).toThrow(/non valido/);
    expect(() => parsePages('5-2', 10)).toThrow(/non valido/);
    expect(() => parsePages('abc', 10)).toThrow(/non valido/);
  });
});

describe('analyzeDocument', () => {
  it('trova lo sfondo a pieno pagina su ogni pagina', async () => {
    const doc = await load(await createFixturePdf({ pages: 3, background: true }));
    const result = await analyzeDocument(doc, 80, '');

    expect(result.totalPages).toBe(3);
    expect(result.candidates.length).toBe(3);
    for (const candidate of result.candidates) {
      expect(candidate.coveragePct).toBeGreaterThan(99);
      expect(candidate.imgName).toBeTruthy();
      expect(candidate.canStripPerPage).toBe(true);
      expect(candidate.isProtected).toBe(false);
    }
    expect(result.candidates.map((c) => c.pageIndex)).toEqual([0, 1, 2]);
  });

  it('non segnala immagini con copertura sotto la soglia', async () => {
    const doc = await load(await createFixturePdf({ pages: 1, background: false, smallImage: true }));
    const result = await analyzeDocument(doc, 80, '');

    expect(result.candidates.length).toBe(0);
  });

  it('segnala le immagini piccole solo con soglia bassa', async () => {
    const doc = await load(await createFixturePdf({ pages: 1, background: false, smallImage: true }));
    const result = await analyzeDocument(doc, 0.5, '');

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].coveragePct).toBeLessThan(2);
  });

  it('salta le pagine escluse', async () => {
    const doc = await load(await createFixturePdf({ pages: 3, background: true }));
    const result = await analyzeDocument(doc, 80, '2');

    expect(result.candidates.length).toBe(2);
    expect(result.candidates.map((c) => c.pageIndex)).toEqual([0, 2]);
  });

  it('propaga l\'errore per una specifica di pagine non valida', async () => {
    const doc = await load(await createFixturePdf({ pages: 2, background: true }));
    await expect(analyzeDocument(doc, 80, '7')).rejects.toThrow(/non valido/);
  });

  it('segnala le immagini condivise con pagine escluse come protette', async () => {
    const doc = await load(await createFixturePdf({ pages: 2, background: true, sharedBackground: true }));
    const result = await analyzeDocument(doc, 80, '1');

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].pageIndex).toBe(1);
    expect(result.candidates[0].isProtected).toBe(true);
    expect(result.candidates[0].canStripPerPage).toBe(true);
  });

  it('notifica l\'avanzamento', async () => {
    const doc = await load(await createFixturePdf({ pages: 2, background: true }));
    const fractions: number[] = [];
    await analyzeDocument(doc, 80, '', (progress) => fractions.push(progress.fraction));

    expect(fractions.length).toBeGreaterThanOrEqual(2);
    expect(fractions[fractions.length - 1]).toBe(1);
  });
});

describe('applyRemoval', () => {
  it('sostituisce lo sfondo con un\'immagine trasparente 1x1', async () => {
    const bytes = await createFixturePdf({ pages: 2, background: true });
    const doc = await load(bytes);
    const { candidates } = await analyzeDocument(doc, 80, '');

    const selected = new Map<number, Set<number>>();
    for (const candidate of candidates) {
      if (!selected.has(candidate.pageIndex)) selected.set(candidate.pageIndex, new Set());
      selected.get(candidate.pageIndex)!.add(candidate.xref);
    }

    const result = await applyRemoval(doc, 80, '', selected, false);
    expect(result.removed).toBe(2);
    expect(result.pagesTouched).toBe(2);
    expect(result.warnings.length).toBe(0);

    const output = await saveDocument(doc);
    const reloaded = await load(output);
    expect(reloaded.getPageCount()).toBe(2);

    // ogni immagine di sfondo e' diventata 1x1 con maschera di trasparenza
    const streams = imageStreams(reloaded);
    expect(streams.length).toBe(4); // 2 sfondi + 2 maschere
    for (const stream of streams) {
      expect(numberOf(stream, 'Width')).toBe(1);
      expect(numberOf(stream, 'Height')).toBe(1);
    }
    const withMask = streams.filter((stream) => stream.dict.get(PDFName.of('SMask')));
    expect(withMask.length).toBe(2);
  });

  it('in dry-run non modifica il documento', async () => {
    const bytes = await createFixturePdf({ pages: 1, background: true });
    const doc = await load(bytes);
    const { candidates } = await analyzeDocument(doc, 80, '');
    const candidate = candidates[0];

    const result = await applyRemoval(
      doc,
      80,
      '',
      new Map([[candidate.pageIndex, new Set([candidate.xref])]]),
      true,
    );

    expect(result.removed).toBe(1);
    const output = await saveDocument(doc);
    const reloaded = await load(output);
    const streams = imageStreams(reloaded);
    expect(streams.length).toBe(1);
    expect(numberOf(streams[0], 'Width')).toBe(8);
  });

  it('ignora le immagini non selezionate', async () => {
    const bytes = await createFixturePdf({ pages: 2, background: true });
    const doc = await load(bytes);
    const { candidates } = await analyzeDocument(doc, 80, '');

    const result = await applyRemoval(
      doc,
      80,
      '',
      new Map([[candidates[0].pageIndex, new Set([candidates[0].xref])]]),
      false,
    );

    expect(result.removed).toBe(1);
    expect(result.pagesTouched).toBe(1);

    const output = await saveDocument(doc);
    const reloaded = await load(output);
    const widths = imageStreams(reloaded).map((s) => numberOf(s, 'Width'));
    expect(widths).toContain(1);
    expect(widths).toContain(8);
  });

  it('rimuove dalla singola pagina le immagini condivise con pagine escluse', async () => {
    const bytes = await createFixturePdf({ pages: 2, background: true, sharedBackground: true });
    const doc = await load(bytes);
    const { candidates } = await analyzeDocument(doc, 80, '1');
    const candidate = candidates[0];
    expect(candidate.isProtected).toBe(true);

    const result = await applyRemoval(
      doc,
      80,
      '1',
      new Map([[candidate.pageIndex, new Set([candidate.xref])]]),
      false,
    );

    expect(result.removed).toBe(1);
    expect(result.warnings.length).toBe(0);

    const output = await saveDocument(doc);
    const reloaded = await load(output);
    // l'immagine condivisa non viene sostituita, ma tolta dal content stream della pagina 2
    for (const stream of imageStreams(reloaded)) {
      expect(numberOf(stream, 'Width')).toBe(8);
    }
  });

  it('non rimuove nulla se la selezione e\' vuota', async () => {
    const doc = await load(await createFixturePdf({ pages: 2, background: true }));
    const result = await applyRemoval(doc, 80, '', new Map(), false);

    expect(result.removed).toBe(0);
    expect(result.pagesTouched).toBe(0);
  });

  it('salva un PDF valido con lo stesso numero di pagine', async () => {
    const doc = await load(await createFixturePdf({ pages: 3, background: true, text: true }));
    const output = await saveDocument(doc);
    const reloaded = await load(output);

    expect(reloaded.getPageCount()).toBe(3);
    expect(output.length).toBeGreaterThan(0);
    expect(new TextDecoder('latin1').decode(output.subarray(0, 5))).toBe('%PDF-');
  });
});
