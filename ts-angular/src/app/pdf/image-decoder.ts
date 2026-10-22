import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFString,
} from 'pdf-lib';
import { inflate, inflateRaw } from 'pako';

export const MAX_PREVIEW_DIM = 512;

export type DecodedImage =
  | {
      kind: 'pixels';
      width: number;
      height: number;
      /** RGBA, 4 byte per pixel. */
      data: Uint8ClampedArray;
    }
  | {
      kind: 'encoded';
      /** Formato compresso da decodificare dal browser (es. image/jpeg). */
      mime: string;
      bytes: Uint8Array;
      /** Dimensioni dichiarate nell'immagine PDF. */
      width: number;
      height: number;
    };

type ColorSpace =
  | { type: 'gray' }
  | { type: 'rgb' }
  | { type: 'cmyk' }
  | { type: 'indexed'; base: 'gray' | 'rgb' | 'cmyk'; palette: Uint8Array; hival: number }
  | { type: 'unsupported' };

interface PredictorParams {
  predictor: number;
  colors: number;
  bpc: number;
  columns: number;
}

const NAME_FILTER = PDFName.of('Filter');
const NAME_DECODE_PARMS = PDFName.of('DecodeParms');
const NAME_DECODE = PDFName.of('Decode');
const NAME_WIDTH = PDFName.of('Width');
const NAME_HEIGHT = PDFName.of('Height');
const NAME_COLORSPACE = PDFName.of('ColorSpace');
const NAME_BPC = PDFName.of('BitsPerComponent');
const NAME_IMAGE_MASK = PDFName.of('ImageMask');

function resolve(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  if (obj === undefined) return undefined;
  return doc.context.lookup(obj) ?? undefined;
}

function resolveAll(doc: PDFDocument, obj: PDFObject): PDFObject[] {
  if (obj instanceof PDFArray) {
    const out: PDFObject[] = [];
    for (let i = 0; i < obj.size(); i++) {
      const item = obj.get(i);
      out.push(item ? (doc.context.lookup(item) ?? PDFName.of('null')) : PDFName.of('null'));
    }
    return out;
  }
  return [doc.context.lookup(obj) ?? PDFName.of('null')];
}

function asNumber(doc: PDFDocument, obj: PDFObject | undefined): number | null {
  if (obj === undefined) return null;
  const value = resolve(doc, obj);
  return value instanceof PDFNumber ? value.asNumber() : null;
}

function asName(doc: PDFDocument, obj: PDFObject | undefined): string | null {
  if (obj === undefined) return null;
  const value = resolve(doc, obj);
  return value instanceof PDFName ? value.decodeText() : null;
}

// ---------------------------------------------------------------------------
// Filtri
// ---------------------------------------------------------------------------

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (const byte of data) {
    if (byte === 0x3e) break; // '>'
    let value = -1;
    if (byte >= 0x30 && byte <= 0x39) value = byte - 0x30;
    else if (byte >= 0x41 && byte <= 0x46) value = byte - 0x41 + 10;
    else if (byte >= 0x61 && byte <= 0x66) value = byte - 0x61 + 10;
    else continue;
    if (hi < 0) hi = value;
    else {
      out.push((hi << 4) | value);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi << 4);
  return Uint8Array.from(out);
}

function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple: number[] = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2; // '<~'
  for (; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0x7e) break; // '~'
    if (byte === 0x7a && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    tuple.push(byte - 0x21);
    if (tuple.length === 5) {
      let value = 0;
      for (const digit of tuple) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const count = tuple.length;
    for (let j = count; j < 5; j++) tuple.push(84);
    let value = 0;
    for (const digit of tuple) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Uint8Array.from(out);
}

function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const length = data[i++];
    if (length === 128) break;
    if (length < 128) {
      for (let j = 0; j <= length; j++) out.push(data[i++]);
    } else {
      const byte = data[i++];
      for (let j = 0; j < 257 - length; j++) out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

function lzwDecode(data: Uint8Array, earlyChange = 1): Uint8Array {
  const out: number[] = [];
  const dictionary: Uint8Array[] = [];
  const resetDictionary = (): void => {
    dictionary.length = 0;
    for (let i = 0; i < 256; i++) dictionary.push(Uint8Array.of(i));
    dictionary.push(new Uint8Array(0)); // 256: clear table
    dictionary.push(new Uint8Array(0)); // 257: EOD
  };
  resetDictionary();

  let codeWidth = 9;
  let previous: Uint8Array | null = null;
  let bitBuffer = 0;
  let bitCount = 0;

  for (let i = 0; i < data.length; i++) {
    bitBuffer = (bitBuffer << 8) | data[i];
    bitCount += 8;
    while (bitCount >= codeWidth) {
      const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;
      if (code === 256) {
        resetDictionary();
        codeWidth = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);
      let entry: Uint8Array;
      if (code < dictionary.length) {
        entry = dictionary[code];
      } else if (previous) {
        entry = new Uint8Array(previous.length + 1);
        entry.set(previous, 0);
        entry[previous.length] = previous[0];
      } else {
        return Uint8Array.from(out);
      }
      for (const byte of entry) out.push(byte);
      if (previous) {
        const added = new Uint8Array(previous.length + 1);
        added.set(previous, 0);
        added[previous.length] = entry[0];
        dictionary.push(added);
      }
      previous = entry;
      const limit = dictionary.length + earlyChange;
      if (limit >= 512 && codeWidth === 9) codeWidth = 10;
      else if (limit >= 1024 && codeWidth === 10) codeWidth = 11;
      else if (limit >= 2048 && codeWidth === 11) codeWidth = 12;
    }
  }
  return Uint8Array.from(out);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Applica il predictor PNG (10-15) o TIFF (2) a un buffer di dati gia' decompresso. */
export function applyPredictor(data: Uint8Array, params: PredictorParams): Uint8Array {
  const { predictor, colors, bpc, columns } = params;
  if (predictor <= 1) return data;
  if (predictor === 2) {
    if (bpc !== 8) return data;
    const rowBytes = colors * columns;
    const out = new Uint8Array(data.length);
    for (let row = 0; row * rowBytes < data.length; row++) {
      const base = row * rowBytes;
      for (let i = 0; i < colors; i++) out[base + i] = data[base + i];
      for (let i = colors; i < rowBytes && base + i < data.length; i++) {
        out[base + i] = (data[base + i] + out[base + i - colors]) & 0xff;
      }
    }
    return out;
  }
  // PNG predictors
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let previous = new Uint8Array(rowBytes);
  for (let row = 0; row < rows; row++) {
    const type = data[row * (rowBytes + 1)];
    const src = data.subarray(row * (rowBytes + 1) + 1, row * (rowBytes + 1) + 1 + rowBytes);
    const current = new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? current[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      let value = src[i];
      switch (type) {
        case 0:
          break;
        case 1:
          value = value + left;
          break;
        case 2:
          value = value + up;
          break;
        case 3:
          value = value + ((left + up) >> 1);
          break;
        case 4:
          value = value + paeth(left, up, upLeft);
          break;
        default:
          break;
      }
      current[i] = value & 0xff;
    }
    out.set(current, row * rowBytes);
    previous = current;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Color space
// ---------------------------------------------------------------------------

function parseColorSpace(doc: PDFDocument, obj: PDFObject | undefined): ColorSpace {
  if (obj === undefined) return { type: 'unsupported' };
  const value = resolve(doc, obj);
  if (value instanceof PDFName) {
    switch (value.decodeText()) {
      case 'DeviceGray':
      case 'CalGray':
        return { type: 'gray' };
      case 'DeviceRGB':
      case 'CalRGB':
        return { type: 'rgb' };
      case 'DeviceCMYK':
        return { type: 'cmyk' };
      default:
        return { type: 'unsupported' };
    }
  }
  if (value instanceof PDFArray) {
    const items = resolveAll(doc, value);
    const family = items[0] instanceof PDFName ? items[0].decodeText() : '';
    switch (family) {
      case 'ICCBased': {
        const n = asNumber(doc, items[1]);
        if (n === 1) return { type: 'gray' };
        if (n === 3) return { type: 'rgb' };
        if (n === 4) return { type: 'cmyk' };
        return { type: 'unsupported' };
      }
      case 'Indexed':
      case 'I': {
        const base = parseColorSpace(doc, items[1]);
        const hival = asNumber(doc, items[2]) ?? 0;
        const lookup = items[3];
        if (base.type !== 'gray' && base.type !== 'rgb' && base.type !== 'cmyk') {
          return { type: 'unsupported' };
        }
        const bytes =
          lookup instanceof PDFRawStream
            ? (decodeStreamContents(doc, lookup) ?? new Uint8Array(0))
            : lookup instanceof PDFHexString || lookup instanceof PDFString
              ? lookup.asBytes()
              : new Uint8Array(0);
        return { type: 'indexed', base: base.type, palette: bytes, hival };
      }
      case 'CalGray':
        return { type: 'gray' };
      case 'CalRGB':
        return { type: 'rgb' };
      case 'DeviceN': {
        const names = items[1];
        const count = names instanceof PDFArray ? names.size() : 0;
        if (count === 4) return { type: 'cmyk' };
        if (count === 1) return { type: 'gray' };
        return { type: 'unsupported' };
      }
      case 'Separation':
        return { type: 'gray' };
      default:
        return { type: 'unsupported' };
    }
  }
  return { type: 'unsupported' };
}

function componentsOf(space: ColorSpace): number {
  switch (space.type) {
    case 'gray':
      return 1;
    case 'rgb':
      return 3;
    case 'cmyk':
      return 4;
    case 'indexed':
      return 1;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Decodifica
// ---------------------------------------------------------------------------

function readPredictorParams(
  doc: PDFDocument,
  obj: PDFObject | undefined,
  colors: number,
  bpc: number,
  columns: number,
): PredictorParams {
  const params: PredictorParams = { predictor: 1, colors, bpc, columns };
  if (obj === undefined) return params;
  const dict = resolve(doc, obj);
  if (!(dict instanceof PDFDict)) return params;
  const predictor = asNumber(doc, dict.get(PDFName.of('Predictor'), false));
  const parmColors = asNumber(doc, dict.get(PDFName.of('Colors'), false));
  const parmBpc = asNumber(doc, dict.get(PDFName.of('BitsPerComponent'), false));
  const parmColumns = asNumber(doc, dict.get(PDFName.of('Columns'), false));
  if (predictor !== null) params.predictor = predictor;
  if (parmColors !== null) params.colors = parmColors;
  if (parmBpc !== null) params.bpc = parmBpc;
  if (parmColumns !== null) params.columns = parmColumns;
  return params;
}

/**
 * Decodifica un'immagine XObject PDF in pixel RGBA.
 * Restituisce null se il formato non e' supportato.
 */
export function decodeImage(
  doc: PDFDocument,
  stream: PDFRawStream,
  maxDim: number = MAX_PREVIEW_DIM,
): DecodedImage | null {
  const dict = stream.dict;
  const width = asNumber(doc, dict.get(NAME_WIDTH, false));
  const height = asNumber(doc, dict.get(NAME_HEIGHT, false));
  if (width === null || height === null || width <= 0 || height <= 0) return null;

  const isMask = asNumber(doc, dict.get(NAME_IMAGE_MASK, false)) === 1;
  const bpc = isMask ? 1 : (asNumber(doc, dict.get(NAME_BPC, false)) ?? 8);
  if (![1, 2, 4, 8, 16].includes(bpc)) return null;

  const colorSpace: ColorSpace = isMask
    ? { type: 'gray' }
    : parseColorSpace(doc, dict.get(NAME_COLORSPACE, false));
  if (colorSpace.type === 'unsupported') return null;
  const components = isMask ? 1 : componentsOf(colorSpace);
  if (components === 0) return null;

  // Filtri
  const filterObj = dict.get(NAME_FILTER, false);
  const filters: string[] = [];
  if (filterObj) {
    for (const item of resolveAll(doc, filterObj)) {
      if (item instanceof PDFName) filters.push(item.decodeText());
    }
  }
  const parmsObj = dict.get(NAME_DECODE_PARMS, false);
  const parms: (PDFObject | undefined)[] = [];
  if (parmsObj) {
    const resolved = resolveAll(doc, parmsObj);
    for (const item of resolved) parms.push(item);
  }

  // DCTDecode: i dati sono gia' un JPEG, li lasciamo al browser.
  const dctIndex = filters.indexOf('DCTDecode');
  if (dctIndex >= 0) {
    let bytes: Uint8Array = stream.contents;
    for (let i = 0; i < dctIndex; i++) {
      const filtered = applySingleFilter(bytes, filters[i], parms[i], doc, components, bpc, width);
      if (!filtered) return null;
      bytes = filtered;
    }
    return { kind: 'encoded', mime: 'image/jpeg', bytes, width, height };
  }
  if (filters.includes('JPXDecode') || filters.includes('CCITTFaxDecode')) return null;

  let data: Uint8Array = stream.contents;
  for (let i = 0; i < filters.length; i++) {
    const filtered = applySingleFilter(data, filters[i], parms[i], doc, components, bpc, width);
    if (!filtered) return null;
    data = filtered;
  }

  // Inversione (Decode array)
  let invert = false;
  const decodeObj = dict.get(NAME_DECODE, false);
  if (decodeObj) {
    const items = resolveAll(doc, decodeObj);
    if (items.length >= 2) {
      const a = asNumber(doc, items[0]);
      const b = asNumber(doc, items[1]);
      if (a !== null && b !== null && a > b) invert = true;
    }
  }

  return rasterize(data, width, height, bpc, colorSpace, components, invert, maxDim);
}

function applySingleFilter(
  data: Uint8Array,
  filter: string,
  parm: PDFObject | undefined,
  doc: PDFDocument,
  components: number,
  bpc: number,
  columns: number,
): Uint8Array | null {
  switch (filter) {
    case 'FlateDecode':
    case 'Fl': {
      let inflated: Uint8Array;
      try {
        inflated = inflate(data);
      } catch {
        try {
          inflated = inflateRaw(data);
        } catch {
          return null;
        }
      }
      const params = readPredictorParams(doc, parm, components, bpc, columns);
      return applyPredictor(inflated, params);
    }
    case 'LZWDecode':
    case 'LZW': {
      const early = readEarlyChange(doc, parm);
      const decoded = lzwDecode(data, early);
      const params = readPredictorParams(doc, parm, components, bpc, columns);
      return applyPredictor(decoded, params);
    }
    case 'ASCIIHexDecode':
    case 'AHx':
      return asciiHexDecode(data);
    case 'ASCII85Decode':
    case 'A85':
      return ascii85Decode(data);
    case 'RunLengthDecode':
    case 'RL':
      return runLengthDecode(data);
    case 'Crypt':
      return null;
    default:
      return null;
  }
}

function readEarlyChange(doc: PDFDocument, obj: PDFObject | undefined): number {
  if (obj === undefined) return 1;
  const dict = resolve(doc, obj);
  if (!(dict instanceof PDFDict)) return 1;
  const value = asNumber(doc, dict.get(PDFName.of('EarlyChange'), false));
  return value === 0 ? 0 : 1;
}

/** Applica i filtri dichiarati in uno stream grezzo (usato per le palette indicizzate). */
function decodeStreamContents(doc: PDFDocument, stream: PDFRawStream): Uint8Array | null {
  const filterObj = stream.dict.get(NAME_FILTER, false);
  const filters: string[] = [];
  if (filterObj) {
    for (const item of resolveAll(doc, filterObj)) {
      if (item instanceof PDFName) filters.push(item.decodeText());
    }
  }
  const parmsObj = stream.dict.get(NAME_DECODE_PARMS, false);
  const parms: (PDFObject | undefined)[] = [];
  if (parmsObj) {
    for (const item of resolveAll(doc, parmsObj)) parms.push(item);
  }
  let data = stream.contents;
  for (let i = 0; i < filters.length; i++) {
    const filtered = applySingleFilter(data, filters[i], parms[i], doc, 1, 8, 1);
    if (!filtered) return null;
    data = filtered;
  }
  return data;
}

function rasterize(
  data: Uint8Array,
  width: number,
  height: number,
  bpc: number,
  colorSpace: ColorSpace,
  components: number,
  invert: boolean,
  maxDim: number,
): DecodedImage | null {
  const rowBytes = Math.ceil((width * components * bpc) / 8);
  if (data.length < rowBytes) return null;

  const maxValue = (1 << bpc) - 1;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);

  const row = new Uint8Array(rowBytes);
  const samples = new Array<number>(components);

  for (let y = 0; y < height; y++) {
    const base = y * rowBytes;
    row.set(data.subarray(base, base + rowBytes));
    const outY = Math.min(outHeight - 1, Math.floor(y * outHeight / height));
    for (let x = 0; x < width; x++) {
      const outX = Math.min(outWidth - 1, Math.floor(x * outWidth / width));
      readSamples(row, x, bpc, components, maxValue, samples);
      const rgba = toRgba(samples, colorSpace, components, invert, maxValue);
      const offset = (outY * outWidth + outX) * 4;
      out[offset] = rgba[0];
      out[offset + 1] = rgba[1];
      out[offset + 2] = rgba[2];
      out[offset + 3] = rgba[3];
    }
  }

  return { kind: 'pixels', width: outWidth, height: outHeight, data: out };
}

function readSamples(
  row: Uint8Array,
  x: number,
  bpc: number,
  components: number,
  maxValue: number,
  out: number[],
): void {
  for (let c = 0; c < components; c++) {
    const index = x * components + c;
    let value: number;
    if (bpc === 8) {
      value = row[index] ?? 0;
    } else if (bpc === 16) {
      value = row[index * 2] ?? 0; // si usa il byte piu' significativo
    } else {
      const bitOffset = index * bpc;
      const byte = row[bitOffset >> 3] ?? 0;
      const shift = 8 - bpc - (bitOffset & 7);
      value = (byte >> shift) & maxValue;
    }
    out[c] = value;
  }
}

function scaleTo8(value: number, maxValue: number): number {
  if (maxValue === 255) return value;
  return Math.round((value * 255) / maxValue);
}

function toRgba(
  samples: number[],
  colorSpace: ColorSpace,
  components: number,
  invert: boolean,
  maxValue: number,
): [number, number, number, number] {
  const gray0 = scaleTo8(samples[0], maxValue);
  switch (colorSpace.type) {
    case 'gray': {
      const value = invert ? 255 - gray0 : gray0;
      return [value, value, value, 255];
    }
    case 'rgb': {
      const r = scaleTo8(samples[0], maxValue);
      const g = scaleTo8(samples[1], maxValue);
      const b = scaleTo8(samples[2], maxValue);
      if (invert) return [255 - r, 255 - g, 255 - b, 255];
      return [r, g, b, 255];
    }
    case 'cmyk': {
      const c = samples[0] / maxValue;
      const m = samples[1] / maxValue;
      const y = samples[2] / maxValue;
      const k = samples[3] / maxValue;
      return [
        Math.round(255 * (1 - c) * (1 - k)),
        Math.round(255 * (1 - m) * (1 - k)),
        Math.round(255 * (1 - y) * (1 - k)),
        255,
      ];
    }
    case 'indexed': {
      const index = samples[0];
      const base = colorSpace.base;
      const per = base === 'gray' ? 1 : 3;
      const offset = index * per;
      if (offset + per > colorSpace.palette.length) return [0, 0, 0, 255];
      if (base === 'gray') {
        const value = scaleTo8(colorSpace.palette[offset], 255);
        return [value, value, value, 255];
      }
      return [
        colorSpace.palette[offset],
        colorSpace.palette[offset + 1],
        colorSpace.palette[offset + 2],
        255,
      ];
    }
    default:
      return [0, 0, 0, 255];
  }
}

/**
 * Mappa numero oggetto -> oggetto indiretto del documento.
 * pdf-lib non espone un lookup per numero oggetto, quindi si enumera tutto.
 */
export function objectNumberMap(doc: PDFDocument): Map<number, PDFObject> {
  const map = new Map<number, PDFObject>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!map.has(ref.objectNumber)) map.set(ref.objectNumber, obj);
  }
  return map;
}

/** Recupera l'oggetto immagine grezzo (xref) dal documento. */
export function lookupRawStream(
  objects: Map<number, PDFObject>,
  xref: number,
): PDFRawStream | null {
  const obj = objects.get(xref);
  if (obj instanceof PDFRawStream) return obj;
  return null;
}
