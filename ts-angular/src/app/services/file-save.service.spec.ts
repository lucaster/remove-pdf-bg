import { FileSaveService } from './file-save.service';

type PickerWindow = Window & { showSaveFilePicker?: unknown };

function withPicker(picker: unknown): void {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    writable: true,
    value: picker,
  });
}

describe('FileSaveService', () => {
  afterEach(() => {
    delete (window as PickerWindow).showSaveFilePicker;
  });

  it('non offre "Salva come" senza la File System Access API', () => {
    delete (window as PickerWindow).showSaveFilePicker;
    expect(new FileSaveService().canSaveAs()).toBe(false);
  });

  it('offre "Salva come" con la File System Access API', () => {
    withPicker(() => undefined);
    expect(new FileSaveService().canSaveAs()).toBe(true);
  });

  it('scarica il file quando il browser non supporta il picker', async () => {
    delete (window as PickerWindow).showSaveFilePicker;
    const clicks: string[] = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      clicks.push(this.download);
    };

    try {
      const outcome = await new FileSaveService().saveAs('documento_nobg.pdf', 'blob:fake');
      expect(outcome).toBe('downloaded');
      expect(clicks).toEqual(['documento_nobg.pdf']);
    } finally {
      HTMLAnchorElement.prototype.click = original;
    }
  });

  it('scrive il file scelto con il picker', async () => {
    const written: Blob[] = [];
    let closed = false;
    withPicker(async () => ({
      createWritable: async () => ({
        write: async (data: Blob) => {
          written.push(data);
        },
        close: async () => {
          closed = true;
        },
      }),
    }));

    const outcome = await new FileSaveService().saveAs(
      'documento_nobg.pdf',
      'data:application/pdf;base64,JVBERi0=',
    );

    expect(outcome).toBe('saved');
    expect(closed).toBe(true);
    expect(written.length).toBe(1);
  });

  it('riporta l\'annullamento quando l\'utente chiude il picker', async () => {
    withPicker(async () => {
      throw new DOMException('annullato', 'AbortError');
    });

    const outcome = await new FileSaveService().saveAs(
      'documento_nobg.pdf',
      'data:application/pdf;base64,JVBERi0=',
    );
    expect(outcome).toBe('cancelled');
  });
});
