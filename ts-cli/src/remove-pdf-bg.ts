#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
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

const USAGE = `Rimuove le immagini di sfondo a pagina intera da un PDF.

Uso: java -jar remove-pdf-bg.jar [opzioni] INPUT.pdf

  -o, --output FILE     PDF di output (default: <input>_nobg.pdf)
  -t, --threshold N     copertura minima della pagina, in % (default: 95)
  -e, --exclude SPEC    pagine da NON trattare, numerate da 1: es. '1,3,10-12' o '5-'
  -d, --dry-run         mostra cosa verrebbe rimosso senza scrivere alcun file
  -h, --help            mostra questo messaggio`;

function usage(): void {
  process.stdout.write(USAGE + '\n');
}

function fail(message: string): never {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function padLeft(value: number, width: number): string {
  return String(value).padStart(width, ' ');
}

function javaParseInt(s: string): number {
  if (!/^[+-]?\d+$/.test(s)) throw new Error('For input string: "' + s + '"');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < -2147483648 || n > 2147483647) {
    throw new Error('For input string: "' + s + '"');
  }
  return n;
}

function javaParseDouble(s: string): number {
  const t = s.trim();
  if (/^[+-]?NaN$/.test(t)) return NaN;
  if (/^[+-]?Infinity$/.test(t)) return t.charCodeAt(0) === 45 ? -Infinity : Infinity;
  const u = t.replace(/[dDfF]$/, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(u)) {
    throw new Error('For input string: "' + s + '"');
  }
  return Number(u);
}

function parsePages(spec: string, nPages: number): Set<number> {
  const result = new Set<number>();
  if (spec.length === 0 || spec.trim().length === 0) return result;
  for (const part of spec.replace(/ /g, '').split(',')) {
    if (part.length === 0) continue;
    let start: number;
    let end: number;
    const dash = part.indexOf('-');
    if (dash >= 0) {
      const a = part.substring(0, dash);
      const b = part.substring(dash + 1);
      start = a.length === 0 ? 1 : javaParseInt(a);
      end = b.length === 0 ? nPages : javaParseInt(b);
    } else {
      start = end = javaParseInt(part);
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

function stripImageFromPage(doc: PDFDocument, pageIndex: number, name: string): boolean {
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

function replaceImageWithTransparent(doc: PDFDocument, image: PDFStream): void {
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

async function removeBackgrounds(
  doc: PDFDocument,
  dst: string,
  threshold: number,
  excluded: Set<number>,
  dryRun: boolean,
): Promise<void> {  const nPages = doc.getPageCount();
  const xref = new XrefResolver(doc);

  const protectedXrefs = new Set<number>();
  for (const i of excluded) {
    collectImageXrefs(pageResourcesRes(doc.getPage(i)) as Res, protectedXrefs, xref, 0);
  }

  const alreadyReplaced = new Set<number>();
  let totalRemoved = 0;
  let pagesTouched = 0;

  for (let i = 0; i < nPages; i++) {
    if (excluded.has(i)) {
      process.stdout.write('Pagina ' + padLeft(i + 1, 4) + ': esclusa\n');
      continue;
    }
    const page = doc.getPage(i);
    const rect = pageRect(page);

    const scanner = new ContentScanner(xref);
    scanner.processPage(page);

    const pageNames = pageLevelImageNames(pageResourcesRes(page) as Res, xref);
    let removedHere = 0;

    for (const [xrefId, entry] of scanner.getPlacements()) {
      const cov = coverage(entry.placement, rect);
      if (cov < threshold) continue;
      if (!dryRun) {
        if (protectedXrefs.has(xrefId)) {
          const name = pageNames.get(xrefId);
          if (name === undefined || !stripImageFromPage(doc, i, name)) {
            process.stdout.write(
              'Pagina ' +
                padLeft(i + 1, 4) +
                ': sfondo (xref ' +
                xrefId +
                ') non rimovibile (dentro un Form XObject) -> saltato\n',
            );
            continue;
          }
        } else if (!alreadyReplaced.has(xrefId)) {
          replaceImageWithTransparent(doc, entry.stream);
          alreadyReplaced.add(xrefId);
        }
      }
      removedHere++;
      process.stdout.write(
        'Pagina ' +
          padLeft(i + 1, 4) +
          ': ' +
          (dryRun ? 'trovato' : 'rimosso') +
          ' sfondo (xref ' +
          xrefId +
          ', copertura ' +
          Math.round(cov * 100) +
          '%)\n',
      );
    }

    if (removedHere > 0) {
      pagesTouched++;
      totalRemoved += removedHere;
    }
  }

  if (!dryRun) {
    process.stdout.write('\nSalvataggio in corso...');
    const bytes = await doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
    fs.writeFileSync(dst, Buffer.from(bytes));
    process.stdout.write('\n');
  }

  process.stdout.write(
    '\nImmagini ' +
      (dryRun ? 'individuate' : 'rimosse') +
      ': ' +
      totalRemoved +
      ' su ' +
      pagesTouched +
      ' pagine (totale pagine: ' +
      nPages +
      ')\n',
  );
  if (!dryRun) {
    process.stdout.write('File salvato in: ' + dst + '\n');
  }
}

async function main(): Promise<void> {
  let input: string | null = null;
  let output: string | null = null;
  let exclude = '';
  let threshold = 95.0;
  let dryRun = false;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      usage();
      return;
    } else if (arg === '-o' || arg === '--output') {
      i++;
      if (i >= args.length) fail('Manca il valore di --output.');
      output = args[i];
    } else if (arg === '-t' || arg === '--threshold') {
      i++;
      if (i >= args.length) fail('Manca il valore di --threshold.');
      try {
        threshold = javaParseDouble(args[i]);
      } catch {
        fail('Soglia non valida: ' + args[i]);
      }
    } else if (arg === '-e' || arg === '--exclude') {
      i++;
      if (i >= args.length) fail('Manca il valore di --exclude.');
      exclude = args[i];
    } else if (arg === '-d' || arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('-')) {
      process.stderr.write('Opzione sconosciuta: ' + arg + '\n');
      usage();
      process.exit(2);
    } else {
      if (input !== null) fail('È stato indicato più di un file di input.');
      input = arg;
    }
  }

  if (input === null) {
    usage();
    process.exit(2);
  }

  const src = input;
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    fail('File non trovato: ' + src);
  }

  const fileName = path.basename(src);
  const dot = fileName.lastIndexOf('.');
  const stem = dot >= 0 ? fileName.substring(0, dot) : fileName;
  const dst =
    output !== null ? output : path.join(path.dirname(src), stem + '_nobg.pdf');
  if (path.resolve(src) === path.resolve(dst)) {
    fail('Il file di output deve essere diverso da quello di input.');
  }

  if (threshold > 1) {
    threshold /= 100;
  }
  if (threshold <= 0 || threshold > 1) {
    fail('La soglia deve essere tra 0 e 100 (%).');
  }

  const bytes = fs.readFileSync(src);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes);
  } catch (e) {
    fail('Impossibile aprire il PDF: ' + (e instanceof Error ? e.message : String(e)));
  }
  doc = doc!;
  const nPages = doc.getPageCount();

  let excluded: Set<number>;
  try {
    excluded = parsePages(exclude, nPages);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  excluded = excluded!;

  try {
    await removeBackgrounds(doc, dst, threshold, excluded, dryRun);
  } catch (e) {
    fail('Errore durante l\'elaborazione: ' + (e instanceof Error ? e.message : String(e)));
  }
}

main();