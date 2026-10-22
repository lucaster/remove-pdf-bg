import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFStream,
} from 'pdf-lib';

import {
  ContentScanner,
  Res,
  XrefResolver,
  collectImageXrefs,
  coverage,
  pageContentBytes,
  pageHasContents,
  pageLevelImageNames,
  pageRect,
  pageResourcesRes,
} from './scanner';

/** Immagine candidata come sfondo da rimuovere. */
export interface CandidateImage {
  /** Indice pagina 0-based. */
  pageIndex: number;
  /** Numero oggetto (xref) dell'immagine nel PDF. */
  xref: number;
  /** Nome della risorsa XObject a livello di pagina, se presente. */
  imgName: string | null;
  /** Bounding box del disegno in coordinate PDF. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** Percentuale di pagina coperta dall'immagine (0-100). */
  coveragePct: number;
  /** Condivisa con una pagina esclusa: va rimossa solo dalla pagina. */
  isProtected: boolean;
  /** Rimovibile dalla singola pagina tramite l'operatore Do. */
  canStripPerPage: boolean;
}

export interface AnalysisResult {
  candidates: CandidateImage[];
  totalPages: number;
}

export interface RemovalResult {
  /** Numero di immagini rimosse (o che sarebbero state rimosse in dry-run). */
  removed: number;
  /** Numero di pagine su cui e' avvenuta almeno una rimozione. */
  pagesTouched: number;
  /** Messaggi per le immagini non rimovibili. */
  warnings: string[];
}

export interface ProgressInfo {
  /** Frazione di avanzamento 0..1. */
  fraction: number;
  /** Messaggio descrittivo. */
  message: string;
}

const CONTENTS = PDFName.of('Contents');
const TYPE = PDFName.of('Type');
const SUBTYPE = PDFName.of('Subtype');
const WIDTH = PDFName.of('Width');
const HEIGHT = PDFName.of('Height');
const COLORSPACE = PDFName.of('ColorSpace');
const BITS_PER_COMPONENT = PDFName.of('BitsPerComponent');
const SMASK = PDFName.of('SMask');
const XOBJECT = PDFName.of('XObject');
const IMAGE = PDFName.of('Image');
const DEVICEGRAY = PDFName.of('DeviceGray');

/**
 * Converte '1,3,5-7' (1-based) in un set di indici 0-based.
 * Supporta anche intervalli aperti: '5-', '-3'.
 */
export function parsePages(spec: string, nPages: number): Set<number> {
  const result = new Set<number>();
  if (!spec || spec.trim().length === 0) return result;
  for (const part of spec.replace(/ /g, '').split(',')) {
    if (part.length === 0) continue;
    let start: number;
    let end: number;
    const dash = part.indexOf('-');
    if (dash >= 0) {
      const a = part.substring(0, dash);
      const b = part.substring(dash + 1);
      start = a.length === 0 ? 1 : parseInt(a, 10);
      end = b.length === 0 ? nPages : parseInt(b, 10);
    } else {
      start = end = parseInt(part, 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(
        "Intervallo di pagine non valido: '" + part + "' (il PDF ha " + nPages + ' pagine)',
      );
    }
    if (start < 1 || end > nPages || start > end) {
      throw new Error(
        "Intervallo di pagine non valido: '" + part + "' (il PDF ha " + nPages + ' pagine)',
      );
    }
    for (let p = start; p <= end; p++) result.add(p - 1);
  }
  return result;
}

/**
 * Concede il controllo al browser fra una pagina e l'altra, cosi' la UI resta reattiva.
 * Usa MessageChannel e non setTimeout: i timer sono soggetti a throttling
 * (fino a una volta al minuto) quando la scheda del browser e' in background.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function collectProtectedXrefs(
  doc: PDFDocument,
  excluded: Set<number>,
  xref: XrefResolver,
): Set<number> {
  const protectedXrefs = new Set<number>();
  for (const i of excluded) {
    collectImageXrefs(pageResourcesRes(doc.getPage(i)) as Res, protectedXrefs, xref, 0);
  }
  return protectedXrefs;
}

/**
 * Analizza il documento e restituisce i candidati con copertura >= soglia.
 */
export async function analyzeDocument(
  doc: PDFDocument,
  thresholdPct: number,
  excludeSpec: string,
  onProgress?: (progress: ProgressInfo) => void,
): Promise<AnalysisResult> {
  const nPages = doc.getPageCount();
  const excluded = parsePages(excludeSpec, nPages);
  const xref = new XrefResolver(doc);
  const protectedXrefs = collectProtectedXrefs(doc, excluded, xref);
  const objects = new Map<number, PDFObject>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    objects.set(ref.objectNumber, obj);
  }

  const candidates: CandidateImage[] = [];

  for (let i = 0; i < nPages; i++) {
    if (excluded.has(i)) continue;

    const page = doc.getPage(i);
    const rect = pageRect(page);
    const scanner = new ContentScanner(xref);
    scanner.processPage(page);
    const pageNames = pageLevelImageNames(pageResourcesRes(page) as Res, xref);

    for (const [xrefId, entry] of scanner.getPlacements()) {
      const cov = coverage(entry.placement, rect) * 100;
      if (cov < thresholdPct) continue;

      // Ignora lo stub 1x1 creato da replaceImageWithTransparent
      const imgObj = objects.get(xrefId);
      if (imgObj instanceof PDFRawStream) {
        const wv = imgObj.dict.get(PDFName.of('Width'), false);
        const hv = imgObj.dict.get(PDFName.of('Height'), false);
        const wn = wv instanceof PDFNumber ? wv.asNumber() : null;
        const hn = hv instanceof PDFNumber ? hv.asNumber() : null;
        if (wn === 1 && hn === 1) continue;
      }

      const name = pageNames.get(xrefId);
      candidates.push({
        pageIndex: i,
        xref: xrefId,
        imgName: name ?? null,
        bbox: {
          x0: entry.placement.x0,
          y0: entry.placement.y0,
          x1: entry.placement.x1,
          y1: entry.placement.y1,
        },
        coveragePct: cov,
        isProtected: protectedXrefs.has(xrefId),
        canStripPerPage: name !== undefined,
      });
    }

    onProgress?.({
      fraction: (i + 1) / nPages,
      message: 'Pagina ' + (i + 1) + '/' + nPages + ' - ' + candidates.length + ' immagini identificate',
    });
    await yieldToEventLoop();
  }

  onProgress?.({ fraction: 1, message: 'Analisi completata' });
  return { candidates, totalPages: nPages };
}

function latin1Decode(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const end = Math.min(i + chunk, bytes.length);
    out += String.fromCharCode.apply(
      null,
      Array.prototype.slice.call(bytes.subarray(i, end)) as number[],
    );
  }
  return out;
}

function latin1Encode(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function quoteRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rimuove dalla pagina l'invocazione '/Name Do' dell'immagine.
 * Restituisce false se il nome non compare nei content stream della pagina.
 */
export function stripImageFromPage(doc: PDFDocument, pageIndex: number, name: string): boolean {
  const page = doc.getPage(pageIndex);
  if (!pageHasContents(page)) return false;
  const pattern = new RegExp('(?<![\\w/])/' + quoteRegExp(name) + '\\s+Do\\b', 'g');
  const text = latin1Decode(pageContentBytes(page));
  const replaced = text.replace(pattern, '');
  if (replaced === text) return false;
  const stream = PDFRawStream.of(PDFDict.withContext(doc.context), latin1Encode(replaced));
  const ref = doc.context.register(stream);
  page.node.set(CONTENTS, ref);
  return true;
}

/** Sostituisce l'oggetto immagine con un'immagine 1x1 trasparente (rimozione globale). */
export function replaceImageWithTransparent(doc: PDFDocument, image: PDFStream): void {
  const maskDict = PDFDict.withContext(doc.context);
  maskDict.set(TYPE, XOBJECT);
  maskDict.set(SUBTYPE, IMAGE);
  maskDict.set(WIDTH, PDFNumber.of(1));
  maskDict.set(HEIGHT, PDFNumber.of(1));
  maskDict.set(COLORSPACE, DEVICEGRAY);
  maskDict.set(BITS_PER_COMPONENT, PDFNumber.of(8));
  const maskRef = doc.context.register(PDFRawStream.of(maskDict, Uint8Array.of(0)));

  const dict = image.dict;
  for (const key of [...dict.keys()]) dict.delete(key);
  dict.set(TYPE, XOBJECT);
  dict.set(SUBTYPE, IMAGE);
  dict.set(WIDTH, PDFNumber.of(1));
  dict.set(HEIGHT, PDFNumber.of(1));
  dict.set(COLORSPACE, DEVICEGRAY);
  dict.set(BITS_PER_COMPONENT, PDFNumber.of(8));
  dict.set(SMASK, maskRef);
  (image as unknown as { contents: Uint8Array }).contents = Uint8Array.of(0);
}

/**
 * Rimuove dal documento solo le immagini selezionate.
 * `selectedByPage` mappa l'indice pagina (0-based) al set di xref da rimuovere.
 */
export async function applyRemoval(
  doc: PDFDocument,
  thresholdPct: number,
  excludeSpec: string,
  selectedByPage: Map<number, Set<number>>,
  dryRun: boolean,
  onProgress?: (progress: ProgressInfo) => void,
): Promise<RemovalResult> {
  const nPages = doc.getPageCount();
  const excluded = parsePages(excludeSpec, nPages);
  const xref = new XrefResolver(doc);
  const protectedXrefs = collectProtectedXrefs(doc, excluded, xref);

  const alreadyReplaced = new Set<number>();
  const warnings: string[] = [];
  let totalRemoved = 0;
  let pagesTouched = 0;

  for (let i = 0; i < nPages; i++) {
    onProgress?.({
      fraction: i / nPages,
      message: 'Elaborando pagina ' + (i + 1) + '/' + nPages + '...',
    });
    if (excluded.has(i)) {
      await yieldToEventLoop();
      continue;
    }

    const page = doc.getPage(i);
    const rect = pageRect(page);
    const scanner = new ContentScanner(xref);
    scanner.processPage(page);
    const pageNames = pageLevelImageNames(pageResourcesRes(page) as Res, xref);
    const allowed = selectedByPage.get(i);
    let removedHere = 0;

    for (const [xrefId, entry] of scanner.getPlacements()) {
      if (!allowed || !allowed.has(xrefId)) continue;
      const cov = coverage(entry.placement, rect) * 100;
      if (cov < thresholdPct) continue;

      if (!dryRun) {
        if (protectedXrefs.has(xrefId)) {
          const name = pageNames.get(xrefId);
          if (name === undefined || !stripImageFromPage(doc, i, name)) {
            const message =
              'Pagina ' +
              (i + 1) +
              ': sfondo (xref ' +
              xrefId +
              ') non rimovibile (dentro un Form XObject) -> saltato';
            warnings.push(message);
            continue;
          }
        } else if (!alreadyReplaced.has(xrefId)) {
          replaceImageWithTransparent(doc, entry.stream);
          alreadyReplaced.add(xrefId);
        }
      }
      removedHere++;
    }

    if (removedHere > 0) {
      pagesTouched++;
      totalRemoved += removedHere;
    }
    await yieldToEventLoop();
  }

  onProgress?.({
    fraction: 1,
    message: 'Completato: ' + totalRemoved + ' immagini rimosse su ' + pagesTouched + ' pagine',
  });
  return { removed: totalRemoved, pagesTouched, warnings };
}

/** Serializza il documento modificato. */
export async function saveDocument(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
}
