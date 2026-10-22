import { imageToDataUrl } from './image-preview';

describe('imageToDataUrl', () => {
  it('converte un\'immagine a pixel in un data URL', async () => {
    const url = await imageToDataUrl({
      kind: 'pixels',
      width: 2,
      height: 2,
      data: new Uint8ClampedArray(16),
    });

    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('converte un\'immagine compressa in un data URL', async () => {
    const url = await imageToDataUrl({
      kind: 'encoded',
      mime: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      width: 2,
      height: 2,
    });

    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('restituisce null se il canvas non e\' disponibile', async () => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      writable: true,
      value: () => null,
    });

    try {
      const url = await imageToDataUrl({
        kind: 'pixels',
        width: 1,
        height: 1,
        data: new Uint8ClampedArray(4),
      });
      expect(url).toBeNull();
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});
