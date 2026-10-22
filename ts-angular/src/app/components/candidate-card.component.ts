import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { CandidateView } from '../services/pdf-session.service';

@Component({
  selector: 'app-candidate-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="candidate" [attr.data-xref]="candidate().xref" data-testid="candidate-card">
      <div class="candidate-info">
        <label class="candidate-check">
          <input
            type="checkbox"
            data-testid="candidate-checkbox"
            [checked]="candidate().selected"
            (change)="onToggle($event)"
          />
          <span>Seleziona (xref {{ candidate().xref }})</span>
        </label>
        <p class="candidate-title">
          Pagina {{ candidate().pageIndex + 1 }} / xref {{ candidate().xref }}
        </p>
        <p class="candidate-coverage">Copertura: {{ candidate().coveragePct.toFixed(1) }}%</p>
        @if (candidate().imgName) {
          <p class="candidate-detail">Nome: {{ candidate().imgName }}</p>
        }
        <p class="candidate-detail">Protetto: {{ candidate().isProtected ? 'Si' : 'No' }}</p>
        <p class="candidate-detail">
          Strip per-pagina: {{ candidate().canStripPerPage ? 'Si' : 'No' }}
        </p>
      </div>

      <div class="candidate-preview">
        <p class="candidate-caption">Immagine rilevata</p>
        @if (candidate().imagePreview) {
          <img
            class="preview-image"
            data-testid="candidate-image"
            [src]="candidate().imagePreview"
            alt="Immagine rilevata"
          />
        } @else {
          <p class="candidate-empty" data-testid="candidate-image-missing">
            Immagine non estratta
          </p>
        }
      </div>

      <div class="candidate-preview">
        <p class="candidate-caption">Contesto pagina</p>
        @if (candidate().pagePreview) {
          <img
            class="preview-page"
            data-testid="candidate-page"
            [src]="candidate().pagePreview"
            alt="Anteprima della pagina"
          />
        } @else {
          <p class="candidate-empty" data-testid="candidate-page-missing">
            Anteprima non disponibile
          </p>
        }
      </div>
    </article>
  `,
  styles: `
    .candidate {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      align-items: flex-start;
      border-left: 4px solid #3874c8;
      padding: 0.75rem;
      background: #fff;
      border-radius: 6px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
    }
    .candidate-info {
      min-width: 18rem;
      flex: 0 0 auto;
    }
    .candidate-check {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      font-weight: 600;
      cursor: pointer;
    }
    .candidate-title {
      font-weight: 700;
      margin: 0.25rem 0;
    }
    .candidate-coverage,
    .candidate-detail {
      margin: 0.1rem 0;
      font-size: 0.85rem;
    }
    .candidate-detail {
      color: #555;
    }
    .candidate-preview {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.35rem;
    }
    .candidate-caption {
      font-size: 0.8rem;
      font-weight: 600;
      margin: 0;
    }
    .candidate-empty {
      font-size: 0.78rem;
      font-style: italic;
      color: #777;
      margin: 0;
    }
    .preview-image {
      max-height: 11rem;
      max-width: 18rem;
      object-fit: contain;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: #fafafa;
    }
    .preview-page {
      max-height: 16rem;
      max-width: 100%;
      object-fit: contain;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: #fafafa;
    }
  `,
})
export class CandidateCardComponent {
  readonly candidate = input.required<CandidateView>();
  readonly selectionChange = output<{ key: string; selected: boolean }>();

  onToggle(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.selectionChange.emit({ key: this.candidate().key, selected: target.checked });
  }
}
