/**
 * jsdom non implementa il canvas: senza il pacchetto npm `canvas` le chiamate a
 * `getContext()` e `toDataURL()` falliscono e l'errore viene stampato in console.
 * Qui viene fornito un contesto 2D finto, sufficiente a far girare il codice di
 * generazione delle anteprime nei test (nessun rendering reale avviene).
 */

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

class FakeCanvasContext2D {
  putImageData(): void {}
  drawImage(): void {}
  clearRect(): void {}
  fillRect(): void {}
  save(): void {}
  restore(): void {}
}

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  writable: true,
  value: function getContext(this: HTMLCanvasElement): FakeCanvasContext2D {
    return new FakeCanvasContext2D();
  },
});

Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
  configurable: true,
  writable: true,
  value: function toDataURL(): string {
    return PNG_1X1;
  },
});

/** Anche `ImageData` manca in jsdom: si simula con i soli dati RGBA. */
class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

Object.defineProperty(globalThis, 'ImageData', {
  configurable: true,
  writable: true,
  value: FakeImageData,
});

/** Anche `createImageBitmap` manca in jsdom: si simula con le dimensioni richieste. */
Object.defineProperty(globalThis, 'createImageBitmap', {
  configurable: true,
  writable: true,
  value: async (
    _blob: Blob,
    options?: { resizeWidth?: number; resizeHeight?: number },
  ): Promise<{ width: number; height: number; close: () => void }> => ({
    width: options?.resizeWidth ?? 1,
    height: options?.resizeHeight ?? 1,
    close: () => {},
  }),
});
