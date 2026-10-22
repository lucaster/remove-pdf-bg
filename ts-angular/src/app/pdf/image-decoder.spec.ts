import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from 'pdf-lib';

import { applyPredictor, decodeImage, lookupRawStream, objectNumberMap } from './image-decoder';
import { createFixturePdf } from '../../testing/pdf-fixture';

function findImageStream(doc: PDFDocument): PDFRawStream {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      return obj;
    }
  }
  throw new Error('nessuna immagine trovata nel documento');
}

/** Crea un'immagine grezza (senza filtri) e la registra nel documento. */
function rawImage(
  doc: PDFDocument,
  entries: Record<string, unknown>,
  contents: Uint8Array,
): PDFRawStream {
  const dict = PDFDict.withContext(doc.context);
  for (const [key, value] of Object.entries(entries)) {
    if (value instanceof PDFName) {
      dict.set(PDFName.of(key), value);
    } else if (value instanceof PDFNumber) {
      dict.set(PDFName.of(key), value);
    } else if (typeof value === 'string') {
      dict.set(PDFName.of(key), PDFName.of(value));
    } else if (typeof value === 'number') {
      dict.set(PDFName.of(key), PDFNumber.of(value));
    }
  }
  const stream = PDFRawStream.of(dict, contents);
  doc.context.register(stream);
  return stream;
}

describe('applyPredictor', () => {
  it('non modifica i dati con predictor 1', () => {
    const data = Uint8Array.of(1, 2, 3, 4);
    expect([...applyPredictor(data, { predictor: 1, colors: 1, bpc: 8, columns: 4 })]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('applica il predictor TIFF 2', () => {
    // somma cumulativa degli byte della riga
    const data = Uint8Array.of(10, 5, 20, 10);
    const out = applyPredictor(data, { predictor: 2, colors: 1, bpc: 8, columns: 4 });
    expect([...out]).toEqual([10, 15, 35, 45]);
  });

  it('applica il filtro PNG "up"', () => {
    // 2 righe da 2 byte, filtro 2 (Up)
    const data = Uint8Array.of(2, 10, 20, 2, 5, 5);
    const out = applyPredictor(data, { predictor: 12, colors: 1, bpc: 8, columns: 2 });
    expect([...out]).toEqual([10, 20, 15, 25]);
  });

  it('applica il filtro PNG "sub"', () => {
    const data = Uint8Array.of(1, 10, 20, 1, 1, 2);
    const out = applyPredictor(data, { predictor: 12, colors: 1, bpc: 8, columns: 2 });
    expect([...out]).toEqual([10, 30, 1, 3]);
  });

  it('applica il filtro PNG "average"', () => {
    const data = Uint8Array.of(3, 10, 20, 3, 5, 5);
    const out = applyPredictor(data, { predictor: 12, colors: 1, bpc: 8, columns: 2 });
    expect([...out]).toEqual([10, 25, 10, 22]);
  });

  it('applica il filtro PNG "paeth"', () => {
    const data = Uint8Array.of(4, 10, 20, 4, 0, 0);
    const out = applyPredictor(data, { predictor: 12, colors: 1, bpc: 8, columns: 2 });
    expect([...out]).toEqual([10, 30, 10, 30]);
  });
});

describe('decodeImage', () => {
  it('decodifica un\'immagine PNG compressa con predictor', async () => {
    const bytes = await createFixturePdf({ pages: 1, background: true, color: [200, 100, 50] });
    const doc = await PDFDocument.load(bytes);
    const stream = findImageStream(doc);

    const decoded = decodeImage(doc, stream);
    expect(decoded).not.toBeNull();
    expect(decoded!.kind).toBe('pixels');
    if (decoded!.kind !== 'pixels') return;

    expect(decoded!.width).toBe(8);
    expect(decoded!.height).toBe(8);
    const pixel = [decoded!.data[0], decoded!.data[1], decoded!.data[2], decoded!.data[3]];
    expect(pixel).toEqual([200, 100, 50, 255]);
  });

  it('decodifica un\'immagine DeviceRGB grezza', async () => {
    const doc = await PDFDocument.create();
    const stream = rawImage(
      doc,
      {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 2,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
      },
      Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0),
    );

    const decoded = decodeImage(doc, stream);
    expect(decoded!.kind).toBe('pixels');
    if (decoded!.kind !== 'pixels') return;
    expect(decoded!.width).toBe(2);
    expect(decoded!.height).toBe(2);
    expect([decoded!.data[0], decoded!.data[1], decoded!.data[2]]).toEqual([255, 0, 0]);
    expect([decoded!.data[4], decoded!.data[5], decoded!.data[6]]).toEqual([0, 255, 0]);
  });

  it('decodifica un\'immagine DeviceGray', async () => {
    const doc = await PDFDocument.create();
    const stream = rawImage(
      doc,
      {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 1,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      },
      Uint8Array.of(0, 255),
    );

    const decoded = decodeImage(doc, stream);
    expect(decoded!.kind).toBe('pixels');
    if (decoded!.kind !== 'pixels') return;
    expect([decoded!.data[0], decoded!.data[1], decoded!.data[2]]).toEqual([0, 0, 0]);
    expect([decoded!.data[4], decoded!.data[5], decoded!.data[6]]).toEqual([255, 255, 255]);
  });

  it('decodifica un\'immagine con palette indicizzata', async () => {
    const doc = await PDFDocument.create();
    const dict = PDFDict.withContext(doc.context);
    dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    dict.set(PDFName.of('Subtype'), PDFName.of('Image'));
    dict.set(PDFName.of('Width'), PDFNumber.of(2));
    dict.set(PDFName.of('Height'), PDFNumber.of(1));
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));

    const colorSpace = PDFArray.withContext(doc.context);
    colorSpace.push(PDFName.of('Indexed'));
    colorSpace.push(PDFName.of('DeviceRGB'));
    colorSpace.push(PDFNumber.of(1));
    colorSpace.push(PDFHexString.of('FF000000FF00'));
    dict.set(PDFName.of('ColorSpace'), colorSpace);

    const stream = PDFRawStream.of(dict, Uint8Array.of(0, 1));
    doc.context.register(stream);

    const decoded = decodeImage(doc, stream);
    expect(decoded!.kind).toBe('pixels');
    if (decoded!.kind !== 'pixels') return;
    expect([decoded!.data[0], decoded!.data[1], decoded!.data[2]]).toEqual([255, 0, 0]);
    expect([decoded!.data[4], decoded!.data[5], decoded!.data[6]]).toEqual([0, 255, 0]);
  });

  it('decodifica un\'immagine ICCBased leggendo /N dal profilo', async () => {
    const doc = await PDFDocument.create();
    const profileDict = PDFDict.withContext(doc.context);
    profileDict.set(PDFName.of('N'), PDFNumber.of(3));
    const profile = PDFRawStream.of(profileDict, new Uint8Array(0));
    const profileRef = doc.context.register(profile);

    const dict = PDFDict.withContext(doc.context);
    dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    dict.set(PDFName.of('Subtype'), PDFName.of('Image'));
    dict.set(PDFName.of('Width'), PDFNumber.of(2));
    dict.set(PDFName.of('Height'), PDFNumber.of(1));
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    const colorSpace = PDFArray.withContext(doc.context);
    colorSpace.push(PDFName.of('ICCBased'));
    colorSpace.push(profileRef);
    dict.set(PDFName.of('ColorSpace'), colorSpace);

    const stream = PDFRawStream.of(dict, Uint8Array.of(255, 0, 0, 0, 255, 0));
    doc.context.register(stream);

    const decoded = decodeImage(doc, stream);
    expect(decoded!.kind).toBe('pixels');
    if (decoded!.kind !== 'pixels') return;
    expect([decoded!.data[0], decoded!.data[1], decoded!.data[2]]).toEqual([255, 0, 0]);
    expect([decoded!.data[4], decoded!.data[5], decoded!.data[6]]).toEqual([0, 255, 0]);
  });

  it('restituisce null per un formato non supportato', async () => {
    const doc = await PDFDocument.create();
    const stream = rawImage(
      doc,
      {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 2,
        ColorSpace: 'DeviceCMYK',
        BitsPerComponent: 8,
        Filter: 'JPXDecode',
      },
      Uint8Array.of(0, 0, 0, 0),
    );

    expect(decodeImage(doc, stream)).toBeNull();
  });

  it('restituisce null se mancano le dimensioni', async () => {
    const doc = await PDFDocument.create();
    const stream = rawImage(doc, { Type: 'XObject', Subtype: 'Image' }, Uint8Array.of(0));

    expect(decodeImage(doc, stream)).toBeNull();
  });

  it('scala l\'immagine alla dimensione massima', async () => {
    const doc = await PDFDocument.create();
    const contents = new Uint8Array(100 * 100 * 3).fill(120);
    const stream = rawImage(
      doc,
      {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 100,
        Height: 100,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
      },
      contents,
    );

    const decoded = decodeImage(doc, stream, 50);
    expect(decoded!.kind).toBe('pixels');
    if (decoded!.kind !== 'pixels') return;
    expect(decoded!.width).toBe(50);
    expect(decoded!.height).toBe(50);
  });
});

describe('objectNumberMap / lookupRawStream', () => {
  it('collega il numero oggetto allo stream immagine', async () => {
    const bytes = await createFixturePdf({ pages: 1, background: true });
    const doc = await PDFDocument.load(bytes);
    const stream = findImageStream(doc);

    const objects = objectNumberMap(doc);
    const numbers = [...objects.entries()].filter(([, obj]) => obj === stream).map(([n]) => n);

    expect(numbers.length).toBe(1);
    expect(lookupRawStream(objects, numbers[0])).toBe(stream);
    expect(lookupRawStream(objects, 999999)).toBeNull();
  });
});
