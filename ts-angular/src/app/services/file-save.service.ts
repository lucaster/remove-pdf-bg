import { Injectable, signal } from '@angular/core';

interface FileSystemWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritable>;
}

interface FileSystemAccessWindow {
  showSaveFilePicker?(options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }): Promise<FileSystemFileHandleLike>;
}

export type SaveOutcome = 'saved' | 'cancelled' | 'downloaded';

/**
 * Salva il file di output: usa la File System Access API quando disponibile
 * (solo browser Chromium), altrimenti il download del browser.
 */
@Injectable({ providedIn: 'root' })
export class FileSaveService {
  /**
   * True se il browser espone la File System Access API: solo browser Chromium
   * (Chrome/Edge 86+, Opera 91+, Samsung 29+, Chrome Android 132+). In Firefox
   * e Safari il salvataggio avviene con il download del browser.
   */
  readonly canSaveAs = signal(
    typeof window !== 'undefined' &&
      typeof (window as unknown as FileSystemAccessWindow).showSaveFilePicker === 'function',
  );

  /** Salva il file scegliendo la destinazione (o scarica il file se non supportato). */
  async saveAs(name: string, url: string): Promise<SaveOutcome> {
    const picker = (window as unknown as FileSystemAccessWindow).showSaveFilePicker;
    if (!picker) {
      this.download(name, url);
      return 'downloaded';
    }
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const blob = await (await fetch(url)).blob();
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'saved';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return 'cancelled';
      }
      this.download(name, url);
      return 'downloaded';
    }
  }

  /** Avvia il download del file. */
  download(name: string, url: string): void {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}
