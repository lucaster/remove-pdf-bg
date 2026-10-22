import { ComponentFixture, TestBed } from '@angular/core/testing';

import { App } from './app';
import { PdfSessionService } from './services/pdf-session.service';
import { createFixturePdf } from '../testing/pdf-fixture';

async function selectFile(
  fixture: ComponentFixture<App>,
  file: File,
): Promise<void> {
  const input: HTMLInputElement = fixture.nativeElement.querySelector('[data-testid="file-input"]');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await fixture.whenStable();
}

/** Attende che la sessione arrivi allo stato richiesto e aggiorna la vista. */
async function waitForStatus(
  fixture: ComponentFixture<App>,
  session: PdfSessionService,
  status: string,
): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (session.status() === status) {
      fixture.detectChanges();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout in attesa dello stato ' + status);
}

function testId<T extends HTMLElement = HTMLElement>(
  fixture: ComponentFixture<App>,
  id: string,
): T {
  return fixture.nativeElement.querySelector('[data-testid="' + id + '"]');
}

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('crea il componente', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('mostra il titolo', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const heading: HTMLElement = fixture.nativeElement.querySelector('h1');
    expect(heading.textContent).toContain('Remove PDF Background');
  });

  it('disabilita "Analizza PDF" senza un file', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const button = testId<HTMLButtonElement>(fixture, 'analyze-button');
    expect(button.disabled).toBe(true);
  });

  it('abilita "Analizza PDF" dopo la selezione del file', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const bytes = await createFixturePdf({ pages: 1, background: true });
    await selectFile(fixture, new File([bytes as BlobPart], 'prova.pdf', { type: 'application/pdf' }));
    fixture.detectChanges();

    const button = testId<HTMLButtonElement>(fixture, 'analyze-button');
    expect(button.disabled).toBe(false);
    expect(testId(fixture, 'file-label').textContent).toContain('prova.pdf');
  });

  it('analizza il PDF e mostra i candidati', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const session = TestBed.inject(PdfSessionService);

    const bytes = await createFixturePdf({ pages: 2, background: true });
    await selectFile(fixture, new File([bytes as BlobPart], 'prova.pdf', { type: 'application/pdf' }));

    testId(fixture, 'analyze-button').click();
    await waitForStatus(fixture, session, 'ready');

    const cards = fixture.nativeElement.querySelectorAll('[data-testid="candidate-card"]');
    expect(cards.length).toBe(2);
    expect(testId(fixture, 'info-label').textContent).toContain('2 immagini candidate');
    expect(testId(fixture, 'selected-count').textContent).toContain('2 / 2');
  });

  it('deseleziona e seleziona i candidati', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const session = TestBed.inject(PdfSessionService);

    const bytes = await createFixturePdf({ pages: 2, background: true });
    await selectFile(fixture, new File([bytes as BlobPart], 'prova.pdf', { type: 'application/pdf' }));
    testId(fixture, 'analyze-button').click();
    await waitForStatus(fixture, session, 'ready');

    testId(fixture, 'select-none').click();
    fixture.detectChanges();
    expect(testId(fixture, 'selected-count').textContent).toContain('0 / 2');

    testId(fixture, 'select-all').click();
    fixture.detectChanges();
    expect(testId(fixture, 'selected-count').textContent).toContain('2 / 2');

    testId(fixture, 'invert-selection').click();
    fixture.detectChanges();
    expect(testId(fixture, 'selected-count').textContent).toContain('0 / 2');
  });

  it('applica la rimozione e prepara il download', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const session = TestBed.inject(PdfSessionService);

    const bytes = await createFixturePdf({ pages: 1, background: true });
    await selectFile(fixture, new File([bytes as BlobPart], 'prova.pdf', { type: 'application/pdf' }));
    testId(fixture, 'analyze-button').click();
    await waitForStatus(fixture, session, 'ready');

    testId(fixture, 'apply-button').click();
    await waitForStatus(fixture, session, 'done');

    expect(testId(fixture, 'result-label').textContent).toContain('1 immagini rimosse');
    expect(testId(fixture, 'output-label').textContent).toContain('prova_nobg.pdf');
    expect(testId(fixture, 'download-button')).toBeTruthy();
  });

  it('nasconde "Salva come" se il browser non supporta il picker', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const session = TestBed.inject(PdfSessionService);

    const bytes = await createFixturePdf({ pages: 1, background: true });
    await selectFile(fixture, new File([bytes as BlobPart], 'prova.pdf', { type: 'application/pdf' }));
    testId(fixture, 'analyze-button').click();
    await waitForStatus(fixture, session, 'ready');
    testId(fixture, 'apply-button').click();
    await waitForStatus(fixture, session, 'done');

    expect(fixture.nativeElement.querySelector('[data-testid="save-as-button"]')).toBeNull();
    expect(testId(fixture, 'no-save-as-hint')).toBeTruthy();
  });

  it('mostra "Salva come" se il browser supporta il picker', async () => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
    try {
      const fixture = TestBed.createComponent(App);
      fixture.detectChanges();
      const session = TestBed.inject(PdfSessionService);

      const bytes = await createFixturePdf({ pages: 1, background: true });
      await selectFile(fixture, new File([bytes as BlobPart], 'prova.pdf', { type: 'application/pdf' }));
      testId(fixture, 'analyze-button').click();
      await waitForStatus(fixture, session, 'ready');
      testId(fixture, 'apply-button').click();
      await waitForStatus(fixture, session, 'done');

      expect(testId(fixture, 'save-as-button')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('[data-testid="no-save-as-hint"]')).toBeNull();
    } finally {
      delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
    }
  });

  it('in dry-run non prepara il file di output', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const session = TestBed.inject(PdfSessionService);

    const bytes = await createFixturePdf({ pages: 1, background: true });
    await selectFile(fixture, new File([bytes as BlobPart], 'prova.pdf', { type: 'application/pdf' }));
    testId(fixture, 'analyze-button').click();
    await waitForStatus(fixture, session, 'ready');

    const dryRun = testId<HTMLInputElement>(fixture, 'dry-run-checkbox');
    dryRun.click();
    fixture.detectChanges();

    testId(fixture, 'apply-button').click();
    await waitForStatus(fixture, session, 'done');

    expect(testId(fixture, 'result-label').textContent).toContain('Dry-run completato');
    expect(fixture.nativeElement.querySelector('[data-testid="download-button"]')).toBeNull();
  });

  it('mostra un errore se il file non e\' un PDF valido', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    await selectFile(
      fixture,
      new File([new Uint8Array([1, 2, 3, 4]) as BlobPart], 'rotto.pdf', { type: 'application/pdf' }),
    );
    testId(fixture, 'analyze-button').click();
    await fixture.whenStable();
    fixture.detectChanges();

    const error = testId(fixture, 'error-label');
    expect(error).toBeTruthy();
    expect(error.textContent.length).toBeGreaterThan(0);
  });

  it('mostra un errore per una specifica di pagine non valida', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const bytes = await createFixturePdf({ pages: 2, background: true });
    await selectFile(fixture, new File([bytes as BlobPart], 'prova.pdf', { type: 'application/pdf' }));

    const exclude = testId<HTMLInputElement>(fixture, 'exclude-input');
    exclude.value = '9';
    exclude.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    testId(fixture, 'analyze-button').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(testId(fixture, 'error-label').textContent).toContain('non valido');
  });
});
