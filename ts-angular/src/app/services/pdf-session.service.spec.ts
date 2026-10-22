import { TestBed } from '@angular/core/testing';

import { PdfSessionService, candidateKey } from './pdf-session.service';
import { createFixturePdf } from '../../testing/pdf-fixture';

async function fileFrom(bytes: Uint8Array, name = 'prova.pdf'): Promise<File> {
  return new File([bytes as BlobPart], name, { type: 'application/pdf' });
}

describe('PdfSessionService', () => {
  let service: PdfSessionService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PdfSessionService);
  });

  it('parte in stato idle', () => {
    expect(service.status()).toBe('idle');
    expect(service.hasFile()).toBe(false);
    expect(service.candidates().length).toBe(0);
    expect(service.selectedCount()).toBe(0);
  });

  it('carica un file', async () => {
    const bytes = await createFixturePdf({ pages: 1, background: true });
    await service.loadFile(await fileFrom(bytes));

    expect(service.fileName()).toBe('prova.pdf');
    expect(service.hasFile()).toBe(true);
    expect(service.error()).toBeNull();
  });

  it('analizza il documento e seleziona tutti i candidati', async () => {
    const bytes = await createFixturePdf({ pages: 3, background: true });
    await service.loadFile(await fileFrom(bytes));
    await service.analyze();

    expect(service.status()).toBe('ready');
    expect(service.totalPages()).toBe(3);
    expect(service.candidates().length).toBe(3);
    expect(service.selectedCount()).toBe(3);
    expect(service.error()).toBeNull();
  });

  it('segnala un errore se non c\'e\' un file', async () => {
    await service.analyze();
    expect(service.error()).toContain('Seleziona prima un PDF');
  });

  it('segnala un errore se non e\' selezionata nessuna immagine', async () => {
    const bytes = await createFixturePdf({ pages: 1, background: true });
    await service.loadFile(await fileFrom(bytes));
    await service.analyze();
    service.selectAll(false);

    await service.apply();
    expect(service.error()).toContain("Seleziona almeno un'immagine");
  });

  it('rimuove lo sfondo e genera l\'output', async () => {
    const bytes = await createFixturePdf({ pages: 2, background: true });
    await service.loadFile(await fileFrom(bytes, 'documento.pdf'));
    await service.analyze();
    await service.apply();

    expect(service.status()).toBe('done');
    expect(service.result()?.removed).toBe(2);
    expect(service.result()?.pagesTouched).toBe(2);
    expect(service.output()?.name).toBe('documento_nobg.pdf');
    expect(service.output()?.size).toBeGreaterThan(0);
    expect(service.output()?.url).toMatch(/^blob:/);
  });

  it('in dry-run non genera l\'output', async () => {
    const bytes = await createFixturePdf({ pages: 1, background: true });
    await service.loadFile(await fileFrom(bytes));
    await service.analyze();
    service.dryRun.set(true);
    await service.apply();

    expect(service.result()?.removed).toBe(1);
    expect(service.output()).toBeNull();
  });

  it('inverte e seleziona i candidati', async () => {
    const bytes = await createFixturePdf({ pages: 2, background: true });
    await service.loadFile(await fileFrom(bytes));
    await service.analyze();

    service.selectAll(false);
    expect(service.selectedCount()).toBe(0);

    service.invertSelection();
    expect(service.selectedCount()).toBe(2);

    const key = service.candidates()[0].key;
    service.setCandidateSelected(key, false);
    expect(service.selectedCount()).toBe(1);

    service.toggleCandidate(key);
    expect(service.selectedCount()).toBe(2);
  });

  it('esclude le pagine indicate', async () => {
    const bytes = await createFixturePdf({ pages: 3, background: true });
    await service.loadFile(await fileFrom(bytes));
    service.exclude.set('2');
    await service.analyze();

    expect(service.candidates().length).toBe(2);
    expect(service.candidates().map((c) => c.pageIndex)).toEqual([0, 2]);
  });

  it('resetta lo stato caricando un nuovo file', async () => {
    const bytes = await createFixturePdf({ pages: 1, background: true });
    await service.loadFile(await fileFrom(bytes));
    await service.analyze();
    expect(service.candidates().length).toBe(1);

    await service.loadFile(await fileFrom(await createFixturePdf({ pages: 2, background: true })));
    expect(service.candidates().length).toBe(0);
    expect(service.result()).toBeNull();
    expect(service.output()).toBeNull();
  });

  it('costruisce una chiave stabile per ogni candidato', () => {
    expect(candidateKey({ pageIndex: 2, xref: 7 } as never)).toBe('2:7');
  });

  it('attende la fine del caricamento del file prima di analizzare', async () => {
    const bytes = await createFixturePdf({ pages: 1, background: true });
    const file = await fileFrom(bytes);

    // si avvia il caricamento e si analizza subito, senza attendere
    const loading = service.loadFile(file);
    const analyzing = service.analyze();
    await Promise.all([loading, analyzing]);

    expect(service.error()).toBeNull();
    expect(service.candidates().length).toBe(1);
  });

  it('ignora un file caricato mentre ne veniva caricato un altro', async () => {
    const first = await fileFrom(await createFixturePdf({ pages: 1, background: true }), 'primo.pdf');
    const second = await fileFrom(await createFixturePdf({ pages: 2, background: true }), 'secondo.pdf');

    const loading = service.loadFile(first);
    await service.loadFile(second);
    await loading;

    expect(service.fileName()).toBe('secondo.pdf');
    await service.analyze();
    expect(service.candidates().length).toBe(2);
  });
});
