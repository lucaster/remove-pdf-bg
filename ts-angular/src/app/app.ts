import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { CandidateCardComponent } from './components/candidate-card.component';
import { FileSaveService } from './services/file-save.service';
import { PdfSessionService } from './services/pdf-session.service';

@Component({
  selector: 'app-root',
  imports: [CandidateCardComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly session = inject(PdfSessionService);
  protected readonly saver = inject(FileSaveService);

  protected readonly dragOver = signal(false);
  protected readonly notice = signal<string | null>(null);

  protected readonly fileLabel = computed(() =>
    this.session.fileName() ? 'File: ' + this.session.fileName() : 'Nessun file selezionato',
  );

  protected readonly progressPercent = computed(() =>
    Math.round(this.session.progress().fraction * 100),
  );

  protected readonly infoLabel = computed(() => {
    const candidates = this.session.candidates();
    if (candidates.length === 0) return 'Nessuna analisi ancora effettuata';
    return (
      'Trovate ' +
      candidates.length +
      ' immagini candidate (>= ' +
      this.session.threshold() +
      '% copertura) su ' +
      this.session.totalPages() +
      ' pagine'
    );
  });

  protected readonly outputLabel = computed(() => {
    const output = this.session.output();
    return output ? 'Output: ' + output.name : '';
  });

  protected readonly resultLabel = computed(() => {
    const result = this.session.result();
    if (!result) return '';
    const prefix = this.session.dryRun() ? 'Dry-run completato' : 'Fatto! File salvato';
    return prefix + ': ' + result.removed + ' immagini rimosse su ' + result.pagesTouched + ' pagine';
  });

  protected onThreshold(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.session.threshold.set(Number(input.value));
  }

  protected onExclude(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.session.exclude.set(input.value);
  }

  protected onDryRun(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.session.dryRun.set(input.checked);
  }

  protected async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.notice.set(null);
    await this.session.loadFile(file);
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(true);
  }

  protected onDragLeave(): void {
    this.dragOver.set(false);
  }

  protected async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    this.notice.set(null);
    await this.session.loadFile(file);
  }

  protected async analyze(): Promise<void> {
    this.notice.set(null);
    await this.session.analyze();
  }

  protected async apply(): Promise<void> {
    this.notice.set(null);
    await this.session.apply();
  }

  protected download(): void {
    const output = this.session.output();
    if (!output) return;
    this.saver.download(output.name, output.url);
  }

  protected async saveAs(): Promise<void> {
    const output = this.session.output();
    if (!output) return;
    const outcome = await this.saver.saveAs(output.name, output.url);
    if (outcome === 'saved') {
      this.notice.set('File salvato in: ' + output.name);
    } else if (outcome === 'downloaded') {
      this.notice.set('Download avviato: ' + output.name);
    } else {
      this.notice.set('Salvataggio annullato');
    }
  }

  protected onSelectionChange(event: { key: string; selected: boolean }): void {
    this.session.setCandidateSelected(event.key, event.selected);
  }
}
