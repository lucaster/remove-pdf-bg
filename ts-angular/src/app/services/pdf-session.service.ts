import { Injectable, computed, signal } from '@angular/core';
import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

import {
  analyzeDocument,
  applyRemoval,
  saveDocument,
  yieldToEventLoop,
  type CandidateImage,
  type RemovalResult,
} from '../pdf/core';
import { decodeImage, lookupRawStream, objectNumberMap } from '../pdf/image-decoder';
import { imageToDataUrl } from '../pdf/image-preview';
import { openPreviewDocument, renderPagePreview } from '../pdf/page-preview';

export type SessionStatus =
  | 'idle'
  | 'loading'
  | 'analyzing'
  | 'ready'
  | 'applying'
  | 'done'
  | 'error';

export interface CandidateView extends CandidateImage {
  /** Identificativo stabile della scheda. */
  key: string;
  selected: boolean;
  /** Anteprima dell'immagine estratta (data URL). */
  imagePreview: string | null;
  /** Anteprima della pagina (data URL). */
  pagePreview: string | null;
}

export interface OutputFile {
  name: string;
  url: string;
  size: number;
}

export interface ProgressState {
  fraction: number;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class PdfSessionService {
  private bytes: Uint8Array | null = null;
  private outputUrl: string | null = null;
  /** Caricamento del file in corso: le operazioni attendono la sua fine. */
  private loadPromise: Promise<void> | null = null;
  /** Identificatore del caricamento corrente: invalida i caricamenti precedenti. */
  private loadToken = 0;

  readonly fileName = signal<string | null>(null);
  readonly status = signal<SessionStatus>('idle');
  readonly progress = signal<ProgressState>({ fraction: 0, message: '' });
  readonly candidates = signal<CandidateView[]>([]);
  readonly totalPages = signal(0);
  readonly error = signal<string | null>(null);
  readonly result = signal<RemovalResult | null>(null);
  readonly output = signal<OutputFile | null>(null);
  readonly warnings = signal<string[]>([]);

  readonly threshold = signal(95);
  readonly exclude = signal('');
  readonly dryRun = signal(false);

  readonly hasFile = computed(() => this.fileName() !== null);
  readonly busy = computed(
    () =>
      this.status() === 'loading' ||
      this.status() === 'analyzing' ||
      this.status() === 'applying',
  );
  readonly selectedCount = computed(
    () => this.candidates().filter((candidate) => candidate.selected).length,
  );
  readonly hasOutput = computed(() => this.output() !== null);

  /** Carica un PDF dal filesystem (o da un upload). */
  async loadFile(file: File): Promise<void> {
    this.reset();
    this.fileName.set(file.name);
    this.status.set('loading');
    const token = this.loadToken;
    this.loadPromise = this.readFile(file, token);
    await this.loadPromise;
    if (this.loadToken === token) this.loadPromise = null;
  }

  private async readFile(file: File, token: number): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (token !== this.loadToken) return; // il file e' stato sostituito meanwhile
      this.bytes = bytes;
      this.status.set('idle');
    } catch (error) {
      if (token !== this.loadToken) return;
      this.fail(error);
    }
  }

  /** Attende la fine del caricamento del file, se in corso. */
  private async waitForLoad(): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise;
      this.loadPromise = null;
    }
  }

  /** Analizza il PDF e calcola le anteprime. */
  async analyze(): Promise<void> {
    await this.waitForLoad();
    if (!this.bytes) {
      this.error.set('Seleziona prima un PDF');
      return;
    }
    this.status.set('analyzing');
    this.progress.set({ fraction: 0, message: 'Caricamento del PDF...' });
    this.error.set(null);
    this.result.set(null);
    this.warnings.set([]);

    try {
      const doc = await PDFDocument.load(this.bytes);
      const analysis = await analyzeDocument(doc, this.threshold(), this.exclude(), (p) =>
        this.progress.set(p),
      );
      this.totalPages.set(analysis.totalPages);
      this.candidates.set(
        analysis.candidates.map((candidate) => ({
          ...candidate,
          key: candidateKey(candidate),
          selected: true,
          imagePreview: null,
          pagePreview: null,
        })),
      );

      await this.buildPreviews(doc);
      this.status.set('ready');
    } catch (error) {
      this.fail(error);
    }
  }

  /** Genera le anteprime (immagine estratta + contesto pagina). */
  private async buildPreviews(doc: PDFDocument): Promise<void> {
    const objects = objectNumberMap(doc);
    const candidates = this.candidates();
    if (candidates.length === 0) return;

    let previewTask: PDFDocumentLoadingTask | null = null;
    let previewDoc: PDFDocumentProxy | null = null;
    const pagePreviews = new Map<number, string | null>();
    try {
      previewTask = openPreviewDocument(this.bytes!);
      previewDoc = await previewTask.promise;
    } catch {
      previewTask = null;
      previewDoc = null;
    }

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      this.progress.set({
        fraction: (i + 1) / candidates.length,
        message:
          'Anteprima pagina ' + (candidate.pageIndex + 1) + ' (' + (i + 1) + '/' + candidates.length + ')',
      });

      let imagePreview: string | null = null;
      let pagePreview: string | null = null;
      try {
        const stream = lookupRawStream(objects, candidate.xref);
        if (stream) {
          const decoded = decodeImage(doc, stream);
          if (decoded) imagePreview = await imageToDataUrl(decoded);
        }

        const cached = pagePreviews.get(candidate.pageIndex);
        if (cached !== undefined) {
          pagePreview = cached;
        } else {
          pagePreview = previewDoc ? await renderPagePreview(previewDoc, candidate.pageIndex) : null;
          pagePreviews.set(candidate.pageIndex, pagePreview);
        }
      } catch {
        // un'anticipo non disponibile non deve bloccare l'analisi
        imagePreview = null;
        pagePreview = null;
      }

      this.candidates.update((list) =>
        list.map((item) =>
          item.key === candidate.key ? { ...item, imagePreview, pagePreview } : item,
        ),
      );
      await yieldToEventLoop();
    }

    if (previewTask) {
      try {
        await previewTask.destroy();
      } catch {
        // il worker puo' gia' essere stato terminato
      }
    }
  }

  /** Rimuove le immagini selezionate e prepara il file di output. */
  async apply(): Promise<void> {
    await this.waitForLoad();
    if (!this.bytes) {
      this.error.set('Seleziona prima un PDF');
      return;
    }
    const selected = this.candidates().filter((candidate) => candidate.selected);
    if (selected.length === 0) {
      this.error.set('Seleziona almeno un\'immagine');
      return;
    }

    this.status.set('applying');
    this.progress.set({ fraction: 0, message: 'Elaborazione in corso...' });
    this.error.set(null);
    this.warnings.set([]);

    try {
      const doc = await PDFDocument.load(this.bytes);
      const selectedByPage = new Map<number, Set<number>>();
      for (const candidate of selected) {
        const set = selectedByPage.get(candidate.pageIndex) ?? new Set<number>();
        set.add(candidate.xref);
        selectedByPage.set(candidate.pageIndex, set);
      }

      const dryRun = this.dryRun();
      const removal = await applyRemoval(
        doc,
        this.threshold(),
        this.exclude(),
        selectedByPage,
        dryRun,
        (p) => this.progress.set(p),
      );
      this.result.set(removal);
      this.warnings.set(removal.warnings);

      if (!dryRun) {
        const saved = await saveDocument(doc);
        this.setOutput(this.buildOutputName(), saved);
      } else {
        this.clearOutput();
      }
      this.status.set('done');
    } catch (error) {
      this.fail(error);
    }
  }

  toggleCandidate(key: string): void {
    this.candidates.update((list) =>
      list.map((candidate) =>
        candidate.key === key ? { ...candidate, selected: !candidate.selected } : candidate,
      ),
    );
  }

  setCandidateSelected(key: string, selected: boolean): void {
    this.candidates.update((list) =>
      list.map((candidate) => (candidate.key === key ? { ...candidate, selected } : candidate)),
    );
  }

  selectAll(selected: boolean): void {
    this.candidates.update((list) => list.map((candidate) => ({ ...candidate, selected })));
  }

  invertSelection(): void {
    this.candidates.update((list) =>
      list.map((candidate) => ({ ...candidate, selected: !candidate.selected })),
    );
  }

  /** Svuota lo stato (nuovo file). */
  reset(): void {
    this.loadToken++;
    this.loadPromise = null;
    this.bytes = null;
    this.fileName.set(null);
    this.status.set('idle');
    this.progress.set({ fraction: 0, message: '' });
    this.candidates.set([]);
    this.totalPages.set(0);
    this.error.set(null);
    this.result.set(null);
    this.warnings.set([]);
    this.clearOutput();
  }

  private buildOutputName(): string {
    const name = this.fileName() ?? 'documento.pdf';
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.substring(0, dot) : name;
    return stem + '_nobg.pdf';
  }

  private setOutput(name: string, bytes: Uint8Array): void {
    this.clearOutput();
    const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
    this.outputUrl = URL.createObjectURL(blob);
    this.output.set({ name, url: this.outputUrl, size: blob.size });
  }

  private clearOutput(): void {
    if (this.outputUrl) {
      URL.revokeObjectURL(this.outputUrl);
      this.outputUrl = null;
    }
    this.output.set(null);
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.error.set(message);
    this.status.set('error');
  }
}

export function candidateKey(candidate: CandidateImage): string {
  return candidate.pageIndex + ':' + candidate.xref;
}
