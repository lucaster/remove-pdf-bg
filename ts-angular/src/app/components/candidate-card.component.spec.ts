import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CandidateCardComponent } from './candidate-card.component';
import type { CandidateView } from '../services/pdf-session.service';

function candidate(overrides: Partial<CandidateView> = {}): CandidateView {
  return {
    key: '0:4',
    pageIndex: 0,
    xref: 4,
    imgName: 'Im1',
    bbox: { x0: 0, y0: 0, x1: 200, y1: 200 },
    coveragePct: 100,
    isProtected: false,
    canStripPerPage: true,
    selected: true,
    imagePreview: null,
    pagePreview: null,
    ...overrides,
  };
}

describe('CandidateCardComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CandidateCardComponent],
    }).compileComponents();
  });

  it('mostra i dati del candidato', () => {
    const fixture: ComponentFixture<CandidateCardComponent> =
      TestBed.createComponent(CandidateCardComponent);
    fixture.componentRef.setInput('candidate', candidate());
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Pagina 1 / xref 4');
    expect(text).toContain('Copertura: 100.0%');
    expect(text).toContain('Im1');
    expect(text).toContain('Protetto: No');
    expect(text).toContain('Strip per-pagina: Si');
  });

  it('segnala la checkbox come selezionata', () => {
    const fixture = TestBed.createComponent(CandidateCardComponent);
    fixture.componentRef.setInput('candidate', candidate({ selected: true }));
    fixture.detectChanges();

    const checkbox: HTMLInputElement = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="candidate-checkbox"]',
    )!;
    expect(checkbox.checked).toBe(true);
  });

  it('emette la nuova selezione', () => {
    const fixture = TestBed.createComponent(CandidateCardComponent);
    fixture.componentRef.setInput('candidate', candidate());
    fixture.detectChanges();

    const emitted: { key: string; selected: boolean }[] = [];
    fixture.componentInstance.selectionChange.subscribe((value) => emitted.push(value));

    const checkbox: HTMLInputElement = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="candidate-checkbox"]',
    )!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(emitted).toEqual([{ key: '0:4', selected: false }]);
  });

  it('mostra i segnaposto quando le anteprime mancano', () => {
    const fixture = TestBed.createComponent(CandidateCardComponent);
    fixture.componentRef.setInput('candidate', candidate());
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="candidate-image-missing"]')).toBeTruthy();
    expect(element.querySelector('[data-testid="candidate-page-missing"]')).toBeTruthy();
  });

  it('mostra le anteprime quando sono disponibili', () => {
    const fixture = TestBed.createComponent(CandidateCardComponent);
    fixture.componentRef.setInput(
      'candidate',
      candidate({ imagePreview: 'data:image/png;base64,AAAA', pagePreview: 'data:image/png;base64,BBBB' }),
    );
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const image = element.querySelector('[data-testid="candidate-image"]') as HTMLImageElement;
    const page = element.querySelector('[data-testid="candidate-page"]') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(page.getAttribute('src')).toBe('data:image/png;base64,BBBB');
  });
});
