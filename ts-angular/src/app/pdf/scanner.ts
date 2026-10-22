import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

export class PdfIOException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfIOException';
  }
}

class MissingOperandError extends PdfIOException {
  constructor() {
    super('Missing operand');
    this.name = 'MissingOperandError';
  }
}

class EmptyGraphicsStackError extends PdfIOException {
  constructor() {
    super('Empty graphics stack');
    this.name = 'EmptyGraphicsStackError';
  }
}

// ---------------------------------------------------------------------------
// Floating point helpers (mimic Java float semantics)
// ---------------------------------------------------------------------------

const FLOAT_MAX = 2 ** 128 - 2 ** 104;
const FLOAT_MIN_NORMAL = 2 ** -126;
const INT_MAX_F32 = 2147483648;
const JAVA_LONG_MAX = 9223372036854775807n;
const JAVA_LONG_MIN = -9223372036854775808n;

function f32(v: number): number {
  return Math.fround(v);
}

function javaFloatParse(s: string): number | null {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  if (Number.isNaN(v)) return null;
  if (v === Infinity) return FLOAT_MAX;
  if (v === -Infinity) return -FLOAT_MAX;
  const r = f32(v);
  if (Math.abs(r) < FLOAT_MIN_NORMAL) return 0;
  return r;
}

function javaIntFromFloat(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v >= INT_MAX_F32) return 2147483647;
  if (v <= -INT_MAX_F32) return -2147483648;
  return Math.trunc(v);
}

interface NumToken {
  readonly t: 'num';
  readonly flt: boolean;
  readonly f: number;
  readonly i: number;
  readonly l: number;
  readonly valid: boolean;
}

function intToken(value: bigint, valid: boolean): NumToken {
  return {
    t: 'num',
    flt: false,
    f: f32(Number(value)),
    i: Number(BigInt.asIntN(32, value)),
    l: Number(value),
    valid,
  };
}

function floatToken(value: number): NumToken {
  return { t: 'num', flt: true, f: value, i: javaIntFromFloat(value), l: 0, valid: false };
}

function cosFloatParse(s: string): number {
  const direct = javaFloatParse(s);
  if (direct !== null) return direct;
  let a = s;
  if (a.startsWith('--')) {
    a = a.slice(1);
  } else if (/^0\.0*-\d+$/.test(a)) {
    a = '-' + a.replace('-', '');
  } else if (/^-\d+\.-\d+$/.test(a)) {
    a = '-' + a.replace(/-/g, '');
  } else {
    throw new PdfIOException("Error expected floating point number actual='" + a + "'");
  }
  const repaired = javaFloatParse(a);
  if (repaired === null) {
    throw new PdfIOException("Error expected floating point number actual='" + a + "'");
  }
  return repaired;
}

function cosNumberGet(number: string): NumToken {
  if (number.length === 1) {
    const code = number.charCodeAt(0);
    if (code >= 48 && code <= 57) return intToken(BigInt(code - 48), true);
    if (code === 45 || code === 46) return intToken(0n, true);
    throw new PdfIOException('Not a number: ' + number);
  }
  if (number.includes('.') || number.includes('e') || number.includes('E')) {
    return floatToken(cosFloatParse(number));
  }
  try {
    const value = BigInt(number);
    if (value >= JAVA_LONG_MIN && value <= JAVA_LONG_MAX) return intToken(value, true);
  } catch {
    /* not an integer literal */
  }
  let digits = number;
  if (digits.startsWith('-') || digits.startsWith('+')) digits = digits.slice(1);
  if (digits.length === 0 || !/^\d+$/.test(digits)) {
    throw new PdfIOException('Not a number: ' + number);
  }
  const magnitude = BigInt(digits);
  if (magnitude > JAVA_LONG_MAX) return intToken(JAVA_LONG_MAX, false);
  const signed = number.startsWith('-') ? -magnitude : magnitude;
  if (signed < JAVA_LONG_MIN) return intToken(JAVA_LONG_MIN, false);
  return intToken(signed, false);
}

// ---------------------------------------------------------------------------
// Token model
// ---------------------------------------------------------------------------

interface NullVal {
  readonly t: 'null';
}
interface BoolVal {
  readonly t: 'bool';
  readonly v: boolean;
}
interface NameVal {
  readonly t: 'name';
  readonly n: PDFName;
}
interface StrVal {
  readonly t: 'str';
  readonly bytes: Uint8Array;
}
interface ArrVal {
  readonly t: 'arr';
  readonly items: Val[];
}
interface DictVal {
  readonly t: 'dict';
  readonly entries: Array<[PDFName, Val]>;
}
interface ObjRefVal {
  readonly t: 'objref';
}

type Val = NullVal | BoolVal | NumToken | NameVal | StrVal | ArrVal | DictVal | ObjRefVal;

interface OpTok {
  readonly t: 'op';
  readonly op: string;
  readonly imageData?: Uint8Array;
}
type Token = Val | OpTok | null;

function isNumVal(v: Val | null): v is NumToken {
  return v !== null && v.t === 'num';
}
function isIntVal(v: Val | null): v is NumToken {
  return v !== null && v.t === 'num' && !v.flt;
}
function isNameVal(v: Token): v is NameVal {
  return v !== null && v.t === 'name';
}
function isOpTok(v: Token): v is OpTok {
  return v !== null && v.t === 'op';
}
function isObjRefVal(v: Val): v is ObjRefVal {
  return v.t === 'objref';
}

// ---------------------------------------------------------------------------
// Byte source
// ---------------------------------------------------------------------------

export class ByteSource {
  private readonly bytes: Uint8Array;
  private position = 0;
  private closed = false;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  isClosed(): boolean {
    return this.closed;
  }
  close(): void {
    this.closed = true;
  }
  isEOF(): boolean {
    return this.position >= this.bytes.length;
  }
  getPosition(): number {
    return this.position;
  }
  read(): number {
    if (this.position >= this.bytes.length) return -1;
    return this.bytes[this.position++];
  }
  peek(): number {
    return this.position < this.bytes.length ? this.bytes[this.position] : -1;
  }
  rewind(count: number): void {
    this.position = Math.max(0, this.position - count);
  }
  readInto(target: Uint8Array, offset: number, length: number): number {
    if (this.position >= this.bytes.length) return -1;
    const n = Math.min(length, this.bytes.length - this.position);
    target.set(this.bytes.subarray(this.position, this.position + n), offset);
    this.position += n;
    return n;
  }
}

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

function isWhitespace(c: number): boolean {
  return c === 0 || c === 9 || c === 12 || c === 10 || c === 13 || c === 32;
}
function isEOL(c: number): boolean {
  return c === 10 || c === 13;
}
function isAsciiDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isJavaDigit(c: number): boolean {
  return (c >= 48 && c <= 57) || c === 178 || c === 179 || c === 185;
}
function isHexDigit(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}
function isEndOfName(ch: number): boolean {
  switch (ch) {
    case 32:
    case 13:
    case 10:
    case 9:
    case 62:
    case 60:
    case 91:
    case 47:
    case 93:
    case 41:
    case 40:
    case 0:
    case 12:
    case 37:
    case -1:
      return true;
    default:
      return false;
  }
}

function latin1String(bytes: number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xff);
  return s;
}

const NULL_CHARS = [110, 117, 108, 108];
const TRUE_CHARS = [116, 114, 117, 101];
const FALSE_CHARS = [102, 97, 108, 115, 101];

function hexValue(ch: number): number {
  if (ch >= 48 && ch <= 57) return ch - 48;
  if (ch >= 97 && ch <= 102) return ch - 87;
  if (ch >= 65 && ch <= 70) return ch - 55;
  return -1;
}

function cosStringParseHex(hex: string): Uint8Array {
  let end = hex.length;
  while (end > 0 && /\s/.test(hex[end - 1])) end--;
  let start = 0;
  while (start < end && /\s/.test(hex[start])) start++;
  let length = end - start;
  const out: number[] = [];
  const uneven = length % 2 !== 0;
  if (uneven) length--;
  for (let i = 0; i < length; i += 2) {
    const value = 16 * hexValue(hex.charCodeAt(start + i)) + hexValue(hex.charCodeAt(start + i + 1));
    if (value < 0) throw new PdfIOException('Invalid hex string: ' + hex);
    out.push(value & 0xff);
  }
  if (uneven) {
    const value = 16 * hexValue(hex.charCodeAt(start + length));
    if (value < 0) throw new PdfIOException('Invalid hex string: ' + hex);
    out.push(value & 0xff);
  }
  return Uint8Array.from(out);
}

function asciiString(arr: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(arr[i] & 0x7f);
  return s;
}

const MAX_RECURSION_DEPTH = 500;
const MAX_RECURSION_MSG = 'Error: maximum recursion depth reached';
const NUMBER_PATTERN = /^\d*(\.\d*)?$/;

// ---------------------------------------------------------------------------
// Content parser (mimics PDFStreamParser + BaseParser)
// ---------------------------------------------------------------------------

export class ContentParser {
  private readonly source: ByteSource;
  private recursionDepth = 0;
  private inlineImageDepth = 0;
  private inlineOffset = 0;

  constructor(source: ByteSource) {
    this.source = source;
  }

  parseNextToken(): Token {
    if (this.source.isClosed()) return null;
    this.skipSpaces();
    if (this.source.isEOF()) {
      this.close();
      return null;
    }
    const c = this.source.peek();
    switch (c) {
      case 60: {
        this.source.read();
        const c2 = this.source.peek();
        this.source.rewind(1);
        if (c2 === 60) {
          try {
            return this.parseCOSDictionary();
          } catch (e) {
            if (!(e instanceof PdfIOException)) throw e;
            this.close();
            return null;
          }
        }
        return this.parseCOSString();
      }
      case 91:
        try {
          return this.parseCOSArray();
        } catch (e) {
          if (!(e instanceof PdfIOException)) throw e;
          this.close();
          return null;
        }
      case 40:
        return this.parseCOSString();
      case 47:
        return { t: 'name', n: this.parseCOSName() };
      case 110: {
        const s = this.readString();
        return s === 'null' ? { t: 'null' } : { t: 'op', op: s };
      }
      case 116:
      case 102: {
        const s = this.readString();
        if (s === 'true') return { t: 'bool', v: true };
        if (s === 'false') return { t: 'bool', v: false };
        return { t: 'op', op: s };
      }
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
      case 45:
      case 43:
      case 46: {
        const buf: string[] = [String.fromCharCode(c)];
        this.source.read();
        if (c === 45 && this.source.peek() === c) this.source.read();
        let dotNotRead = c !== 46;
        let cc = this.source.peek();
        while (isJavaDigit(cc) || (dotNotRead && cc === 46) || cc === 45) {
          if (cc !== 45) buf.push(String.fromCharCode(cc));
          this.source.read();
          if (dotNotRead && cc === 46) dotNotRead = false;
          cc = this.source.peek();
        }
        const s = buf.join('');
        if (s === '+') return { t: 'null' };
        return cosNumberGet(s);
      }
      case 66: {
        const nextOperator = this.readString();
        if (nextOperator === 'BI') {
          this.inlineImageDepth++;
          if (this.inlineImageDepth > 1) {
            throw new PdfIOException(
              "Nested 'BI' operator not allowed at offset " +
                this.source.getPosition() +
                ', first: ' +
                this.inlineOffset,
            );
          }
          this.inlineOffset = this.source.getPosition();
          let nextToken: Token = null;
          while (isNameVal((nextToken = this.parseNextToken()))) {
            const value = this.parseNextToken();
            if (value === null || isOpTok(value)) break;
          }
          if (isOpTok(nextToken)) {
            const imageData = nextToken.imageData;
            this.inlineImageDepth--;
            return imageData === undefined
              ? { t: 'op', op: 'BI' }
              : { t: 'op', op: 'BI', imageData };
          }
          return { t: 'op', op: 'BI' };
        }
        return { t: 'op', op: nextOperator };
      }
      case 73: {
        const id =
          String.fromCharCode(this.source.read() & 0xff) +
          String.fromCharCode(this.source.read() & 0xff);
        if (id !== 'ID') {
          const currentPosition = this.source.getPosition();
          this.close();
          throw new PdfIOException(
            "Error: Expected operator 'ID' actual='" + id + "' at stream offset " + currentPosition,
          );
        }
        const imageData: number[] = [];
        if (!this.skipLinebreak() && isWhitespace(this.source.peek())) this.source.read();
        let lastByte = this.source.read();
        let currentByte = this.source.read();
        while (
          !(
            lastByte === 69 &&
            currentByte === 73 &&
            this.hasNextSpaceOrReturn() &&
            this.hasNoFollowingBinData()
          ) &&
          !this.source.isEOF()
        ) {
          imageData.push(lastByte & 0xff);
          lastByte = currentByte;
          currentByte = this.source.read();
        }
        return { t: 'op', op: 'ID', imageData: Uint8Array.from(imageData) };
      }
      case 93:
        this.source.read();
        return { t: 'null' };
      default: {
        const operator = this.readOperator().trim();
        if (operator.length > 0) return { t: 'op', op: operator };
        return null;
      }
    }
  }

  private close(): void {
    if (!this.source.isClosed()) this.source.close();
  }

  private skipSpaces(): void {
    let c = this.source.read();
    while (isWhitespace(c) || c === 37) {
      if (c === 37) {
        c = this.source.read();
        while (!isEOL(c) && c !== -1) c = this.source.read();
      } else {
        c = this.source.read();
      }
    }
    if (c !== -1) this.source.rewind(1);
  }

  private skipLinebreak(): boolean {
    if (!this.skipLinebreakCh(this.source.read())) {
      this.source.rewind(1);
      return false;
    }
    return true;
  }

  private skipLinebreakCh(linebreak: number): boolean {
    if (linebreak === 13) {
      if (this.source.read() !== 10) this.source.rewind(1);
    } else if (linebreak !== 10) {
      return false;
    }
    return true;
  }

  private readString(): string {
    this.skipSpaces();
    const buf: number[] = [];
    let c = this.source.read();
    while (!isEndOfName(c)) {
      buf.push(c & 0xff);
      c = this.source.read();
    }
    if (c !== -1) this.source.rewind(1);
    return latin1String(buf);
  }

  private readExpectedChar(ec: number): void {
    const c = this.source.read() & 0xffff;
    if (c !== ec) {
      throw new PdfIOException(
        "expected='" +
          String.fromCharCode(ec) +
          "' actual='" +
          String.fromCharCode(c) +
          "' at offset " +
          this.source.getPosition(),
      );
    }
  }

  private readExpectedString(expectedChars: number[]): void {
    this.skipSpaces();
    for (const ec of expectedChars) {
      if (this.source.read() !== ec) {
        throw new PdfIOException(
          "Expected string '" +
            latin1String(expectedChars) +
            "' but missed at character '" +
            String.fromCharCode(ec) +
            "' at offset " +
            this.source.getPosition(),
        );
      }
    }
    this.skipSpaces();
  }

  private checkForEndOfString(bracesParameter: number): number {
    if (bracesParameter === 0) return 0;
    const nextThree = new Uint8Array(3);
    const amountRead = this.source.readInto(nextThree, 0, 3);
    if (amountRead > 0) this.source.rewind(amountRead);
    if (amountRead < 3) return bracesParameter;
    if (
      ((nextThree[0] === 13 || nextThree[0] === 10) && (nextThree[1] === 47 || nextThree[1] === 62)) ||
      (nextThree[0] === 13 && nextThree[1] === 10 && (nextThree[2] === 47 || nextThree[2] === 62))
    ) {
      return 0;
    }
    return bracesParameter;
  }

  private parseCOSString(): StrVal {
    const nextChar = this.source.read();
    if (nextChar === 60) return this.parseCOSHexString();
    if (nextChar !== 40) {
      throw new PdfIOException(
        "parseCOSString string should start with '(' or '<' and not '" +
          String.fromCharCode(nextChar & 0xffff) +
          "' at offset " +
          this.source.getPosition(),
      );
    }
    const out: number[] = [];
    let braces = 1;
    let c = this.source.read();
    while (braces > 0 && c !== -1) {
      const ch = c & 0xffff;
      let nextc = -2;
      if (ch === 41) {
        braces--;
        braces = this.checkForEndOfString(braces);
        if (braces !== 0) out.push(ch);
      } else if (ch === 40) {
        braces++;
        out.push(ch);
      } else if (ch === 92) {
        const next = this.source.read();
        switch (next) {
          case 110:
            out.push(10);
            break;
          case 114:
            out.push(13);
            break;
          case 116:
            out.push(9);
            break;
          case 98:
            out.push(8);
            break;
          case 102:
            out.push(12);
            break;
          case 41:
            if (this.checkForEndOfString(braces) !== 0) out.push(next);
            else out.push(92);
            break;
          case 40:
          case 92:
            out.push(next);
            break;
          case 10:
          case 13: {
            c = this.source.read();
            while (isEOL(c) && c !== -1) c = this.source.read();
            nextc = c;
            break;
          }
          case 48:
          case 49:
          case 50:
          case 51:
          case 52:
          case 53:
          case 54:
          case 55: {
            const octal: number[] = [next];
            c = this.source.read();
            if (c >= 48 && c <= 55) {
              octal.push(c);
              c = this.source.read();
              if (c >= 48 && c <= 55) octal.push(c);
              else nextc = c;
            } else {
              nextc = c;
            }
            out.push(parseInt(latin1String(octal), 8) & 0xff);
            break;
          }
          default:
            out.push(next & 0xff);
        }
      } else {
        out.push(ch);
      }
      c = nextc !== -2 ? nextc : this.source.read();
    }
    if (c !== -1) this.source.rewind(1);
    return { t: 'str', bytes: Uint8Array.from(out) };
  }

  private parseCOSHexString(): StrVal {
    const sBuf: number[] = [];
    for (;;) {
      const c = this.source.read();
      if (isHexDigit(c)) {
        sBuf.push(c);
      } else if (c === 62) {
        break;
      } else if (c < 0) {
        throw new PdfIOException('Missing closing bracket for hex string. Reached EOS.');
      } else if (c === 32 || c === 10 || c === 9 || c === 13 || c === 8 || c === 12) {
        continue;
      } else {
        if (sBuf.length % 2 !== 0) sBuf.pop();
        let cc = this.source.read();
        while (cc !== 62 && cc >= 0) cc = this.source.read();
        if (cc < 0) {
          throw new PdfIOException('Missing closing bracket for hex string. Reached EOS.');
        }
        break;
      }
    }
    return { t: 'str', bytes: cosStringParseHex(latin1String(sBuf)) };
  }

  private parseCOSName(): PDFName {
    this.readExpectedChar(47);
    const bytes: number[] = [];
    let c = this.source.read();
    while (!isEndOfName(c)) {
      bytes.push(c & 0xff);
      c = this.source.read();
    }
    if (c !== -1) this.source.rewind(1);
    return PDFName.of(latin1String(bytes));
  }

  private parseCOSNumber(): NumToken {
    const buf: number[] = [];
    let c = this.source.read();
    while (isJavaDigit(c) || c === 45 || c === 43 || c === 46 || c === 69 || c === 101) {
      buf.push(c & 0xff);
      c = this.source.read();
    }
    if (c !== -1) this.source.rewind(1);
    if (buf.length > 0 && (buf[buf.length - 1] === 101 || buf[buf.length - 1] === 69)) {
      buf.pop();
      this.source.rewind(1);
    }
    return cosNumberGet(latin1String(buf));
  }

  private parseDirObject(): Val | null {
    try {
      this.recursionDepth++;
      if (this.recursionDepth > MAX_RECURSION_DEPTH) throw new PdfIOException(MAX_RECURSION_MSG);
      this.skipSpaces();
      const c = this.source.peek();
      switch (c) {
        case 60: {
          this.source.read();
          const c2 = this.source.peek();
          this.source.rewind(1);
          return c2 === 60 ? this.parseCOSDictionary() : this.parseCOSString();
        }
        case 91:
          return this.parseCOSArray();
        case 40:
          return this.parseCOSString();
        case 47:
          return { t: 'name', n: this.parseCOSName() };
        case 110:
          this.readExpectedString(NULL_CHARS);
          return { t: 'null' };
        case 116:
          this.readExpectedString(TRUE_CHARS);
          return { t: 'bool', v: true };
        case 102:
          this.readExpectedString(FALSE_CHARS);
          return { t: 'bool', v: false };
        case 82:
          this.source.read();
          return { t: 'objref' };
        case -1:
          return null;
        default: {
          if (isJavaDigit(c) || c === 45 || c === 43 || c === 46) return this.parseCOSNumber();
          const startOffset = this.source.getPosition();
          const badString = this.readString();
          if (badString.length === 0) {
            const peek = this.source.peek();
            throw new PdfIOException(
              "Unknown dir object c='" +
                String.fromCharCode(c & 0xffff) +
                "' cInt=" +
                c +
                " peek='" +
                String.fromCharCode(peek & 0xffff) +
                "' peekInt=" +
                peek +
                ' at offset ' +
                this.source.getPosition() +
                ' (start offset: ' +
                startOffset +
                ')',
            );
          }
          if (badString === 'endobj' || badString === 'endstream') {
            this.source.rewind(badString.length);
          }
          return null;
        }
      }
    } finally {
      this.recursionDepth--;
    }
  }

  private parseCOSDictionary(): DictVal {
    try {
      this.recursionDepth++;
      if (this.recursionDepth > MAX_RECURSION_DEPTH) throw new PdfIOException(MAX_RECURSION_MSG);
      this.readExpectedChar(60);
      this.readExpectedChar(60);
      this.skipSpaces();
      const entries: Array<[PDFName, Val]> = [];
      for (;;) {
        this.skipSpaces();
        const c = this.source.peek();
        if (c === 62) {
          break;
        } else if (c === 47) {
          if (!this.parseCOSDictionaryNameValuePair(entries)) return { t: 'dict', entries };
        } else if (this.readUntilEndOfCOSDictionary()) {
          return { t: 'dict', entries };
        }
      }
      try {
        this.readExpectedChar(62);
        this.readExpectedChar(62);
      } catch (e) {
        if (!(e instanceof PdfIOException)) throw e;
      }
      return { t: 'dict', entries };
    } finally {
      this.recursionDepth--;
    }
  }

  private parseCOSDictionaryNameValuePair(entries: Array<[PDFName, Val]>): boolean {
    const key = this.parseCOSName();
    const value = this.parseCOSDictionaryValue();
    this.skipSpaces();
    if (value === null) return false;
    if (isIntVal(value) && !value.valid) return true;
    entries.push([key, value]);
    return true;
  }

  private parseCOSDictionaryValue(): Val | null {
    const value = this.parseDirObject();
    this.skipSpaces();
    if (value === null || value.t !== 'num' || !isAsciiDigit(this.source.peek())) return value;
    const generationNumber = this.parseDirObject();
    this.skipSpaces();
    this.readExpectedChar(82);
    if (!isIntVal(value)) return { t: 'null' };
    if (!isIntVal(generationNumber)) return { t: 'null' };
    const objNumber = value.l;
    if (objNumber <= 0) return { t: 'null' };
    const genNumber = generationNumber.i;
    if (genNumber < 0) return { t: 'null' };
    throw new PdfIOException(
      'object reference ' +
        objNumber +
        ' ' +
        genNumber +
        ' R at offset ' +
        this.source.getPosition() +
        ' in content stream',
    );
  }

  private readUntilEndOfCOSDictionary(): boolean {
    let c = this.source.read();
    while (c !== -1 && c !== 47 && c !== 62) {
      if (c === 69) {
        c = this.source.read();
        if (c === 78) {
          c = this.source.read();
          if (c === 68) {
            c = this.source.read();
            const isStream =
              c === 83 &&
              this.source.read() === 84 &&
              this.source.read() === 82 &&
              this.source.read() === 69 &&
              this.source.read() === 65 &&
              this.source.read() === 77;
            const isObj =
              !isStream &&
              c === 79 &&
              this.source.read() === 66 &&
              this.source.read() === 74;
            if (isStream || isObj) return true;
          }
        }
      }
      c = this.source.read();
    }
    if (c === -1) return true;
    this.source.rewind(1);
    return false;
  }

  private parseCOSArray(): ArrVal {
    try {
      this.recursionDepth++;
      if (this.recursionDepth > MAX_RECURSION_DEPTH) throw new PdfIOException(MAX_RECURSION_MSG);
      this.readExpectedChar(91);
      const items: Val[] = [];
      this.skipSpaces();
      for (;;) {
        const i = this.source.peek();
        if (!(i > 0 && i !== 93)) break;
        let pbo: Val | null = this.parseDirObject();
        if (pbo !== null && isObjRefVal(pbo)) {
          pbo = null;
          if (items.length > 1 && isIntVal(items[items.length - 1])) {
            const gen = items.pop() as NumToken;
            if (items.length > 0 && isIntVal(items[items.length - 1])) {
              const num = items.pop() as NumToken;
              throw new PdfIOException(
                'object reference ' +
                  num.l +
                  ' ' +
                  gen.i +
                  ' R at offset ' +
                  this.source.getPosition() +
                  ' in content stream',
              );
            }
          }
        }
        if (pbo === null) {
          const isThisTheEnd = this.readString();
          if (isThisTheEnd.length === 0 && this.source.peek() === 91) {
            return { t: 'arr', items };
          }
          this.source.rewind(isThisTheEnd.length);
          if (isThisTheEnd === 'endobj' || isThisTheEnd === 'endstream') {
            return { t: 'arr', items };
          }
        } else {
          items.push(pbo);
        }
        this.skipSpaces();
      }
      this.source.read();
      this.skipSpaces();
      return { t: 'arr', items };
    } finally {
      this.recursionDepth--;
    }
  }

  private readOperator(): string {
    this.skipSpaces();
    const buf: number[] = [];
    let nextChar = this.source.peek();
    while (
      nextChar !== -1 &&
      !isWhitespace(nextChar) &&
      nextChar !== 91 &&
      nextChar !== 60 &&
      nextChar !== 40 &&
      nextChar !== 47 &&
      nextChar !== 37 &&
      (nextChar < 48 || nextChar > 57)
    ) {
      const currentChar = this.source.read() & 0xff;
      nextChar = this.source.peek();
      buf.push(currentChar);
      if (currentChar === 100 && (nextChar === 48 || nextChar === 49)) {
        buf.push(this.source.read() & 0xff);
        nextChar = this.source.peek();
      }
    }
    return latin1String(buf);
  }

  private hasNextSpaceOrReturn(): boolean {
    const c = this.source.peek();
    return c === 10 || c === 13 || c === 32;
  }

  private hasNoFollowingBinData(): boolean {
    const arr = new Uint8Array(10);
    const readBytes = this.source.readInto(arr, 0, 10);
    let noBinData = true;
    let startOpIdx = -1;
    let endOpIdx = -1;
    let s = '';
    if (readBytes > 0) {
      for (let bIdx = 0; bIdx < readBytes; bIdx++) {
        const b = arr[bIdx] < 128 ? arr[bIdx] : arr[bIdx] - 256;
        if ((b !== 0 && b < 0x09) || (b > 0x0a && b < 0x20 && b !== 0x0d)) {
          noBinData = false;
          break;
        }
        if (startOpIdx === -1 && !(b === 0 || b === 9 || b === 0x20 || b === 0x0a || b === 0x0d)) {
          startOpIdx = bIdx;
        } else if (
          startOpIdx !== -1 &&
          endOpIdx === -1 &&
          (b === 0 || b === 9 || b === 0x20 || b === 0x0a || b === 0x0d)
        ) {
          endOpIdx = bIdx;
        }
      }
      if (noBinData && endOpIdx !== -1 && startOpIdx !== -1) {
        s = asciiString(arr, startOpIdx, endOpIdx);
        if (s !== 'Q' && s !== 'EMC' && s !== 'S' && !NUMBER_PATTERN.test(s)) noBinData = false;
      }
      if (noBinData && startOpIdx !== -1 && readBytes === 10) {
        if (endOpIdx === -1) {
          endOpIdx = 10;
          s = asciiString(arr, startOpIdx, 10);
        }
        if (endOpIdx - startOpIdx > 3 && !NUMBER_PATTERN.test(s)) noBinData = false;
      }
      this.source.rewind(readBytes);
    }
    return noBinData;
  }
}


// ---------------------------------------------------------------------------
// PDF object helpers
// ---------------------------------------------------------------------------

const EMPTY_RESOURCES = Symbol('empty');
type Res = PDFDict | PDFStream | typeof EMPTY_RESOURCES | null;

export interface Rect {
  llx: number;
  lly: number;
  urx: number;
  ury: number;
  width: number;
  height: number;
}

export interface Placement {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FoundImage {
  stream: PDFStream;
  placement: Placement;
}

const PDF_NAME_Type = PDFName.of('Type');
const PDF_NAME_Pages = PDFName.of('Pages');
const PDF_NAME_Parent = PDFName.of('Parent');
const PDF_NAME_P = PDFName.of('P');
const PDF_NAME_Resources = PDFName.of('Resources');
const PDF_NAME_MediaBox = PDFName.of('MediaBox');
const PDF_NAME_CropBox = PDFName.of('CropBox');
const PDF_NAME_Contents = PDFName.of('Contents');
const PDF_NAME_XObject = PDFName.of('XObject');
const PDF_NAME_Subtype = PDFName.of('Subtype');
const PDF_NAME_Matrix = PDFName.of('Matrix');
const PDF_NAME_Length = PDFName.of('Length');

function dictOf(d: PDFDict | PDFStream): PDFDict {
  return d instanceof PDFStream ? d.dict : d;
}

function resolveRaw(dict: PDFDict, raw: PDFObject | undefined): PDFObject | undefined {
  if (raw === undefined) return undefined;
  if (raw instanceof PDFRef) return dict.context.lookup(raw);
  return raw;
}

function resolvedValue(dict: PDFDict, key: PDFName): PDFObject | undefined {
  const v = resolveRaw(dict, dict.get(key, false));
  return v === PDFNull ? undefined : v;
}

function asDictLike(v: PDFObject | undefined): Res {
  if (v instanceof PDFDict || v instanceof PDFStream) return v;
  return null;
}

function pageInheritable(node: PDFDict, key: PDFName): PDFObject | undefined {
  const visited = new Set<PDFDict>();
  let cur: PDFDict | undefined = node;
  while (cur !== undefined) {
    if (visited.has(cur)) return undefined;
    visited.add(cur);
    const value = resolvedValue(cur, key);
    if (value !== undefined) return value;
    let parent: PDFDict | undefined;
    const p1 = resolvedValue(cur, PDF_NAME_Parent);
    if (p1 instanceof PDFDict) parent = p1;
    else {
      const p2 = resolvedValue(cur, PDF_NAME_P);
      if (p2 instanceof PDFDict) parent = p2;
    }
    if (parent === undefined) return undefined;
    const type = resolvedValue(parent, PDF_NAME_Type);
    if (!(type instanceof PDFName) || type.decodeText() !== 'Pages') return undefined;
    cur = parent;
  }
  return undefined;
}

function arrayNumber(base: PDFDict, arr: PDFArray, i: number): number {
  const v = resolveRaw(base, arr.get(i));
  return v instanceof PDFNumber ? f32(v.asNumber()) : 0;
}

function newRectFromArray(base: PDFDict, arr: PDFArray): Rect {
  const values = [0, 1, 2, 3].map((i) => {
    const v = i < arr.size() ? arrayNumber(base, arr, i) : 0;
    if (Math.abs(v) > INT_MAX_F32) return v > 0 ? INT_MAX_F32 : -INT_MAX_F32;
    return v;
  });
  const llx = Math.min(values[0], values[2]);
  const lly = Math.min(values[1], values[3]);
  const urx = Math.max(values[0], values[2]);
  const ury = Math.max(values[1], values[3]);
  return { llx, lly, urx, ury, width: f32(urx - llx), height: f32(ury - lly) };
}

const LETTER: Rect = { llx: 0, lly: 0, urx: 612, ury: 792, width: 612, height: 792 };

function pageMediaBox(page: PDFPage): Rect {
  const value = pageInheritable(page.node, PDF_NAME_MediaBox);
  if (value instanceof PDFArray) return newRectFromArray(page.node, value);
  return { ...LETTER };
}

function clipToMediaBox(media: Rect, box: Rect): Rect {
  const llx = Math.max(media.llx, box.llx);
  const lly = Math.max(media.lly, box.lly);
  const urx = Math.min(media.urx, box.urx);
  const ury = Math.min(media.ury, box.ury);
  return { llx, lly, urx, ury, width: f32(urx - llx), height: f32(ury - lly) };
}

export function pageRect(page: PDFPage): Rect {
  const value = pageInheritable(page.node, PDF_NAME_CropBox);
  if (value instanceof PDFArray) return clipToMediaBox(pageMediaBox(page), newRectFromArray(page.node, value));
  return pageMediaBox(page);
}

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------

const IDENTITY9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function multiplyMatrices(a: number[], b: number[]): number[] {
  const c = new Array<number>(9);
  c[0] = f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[3])) + f32(a[2] * b[6]));
  c[1] = f32(f32(f32(a[0] * b[1]) + f32(a[1] * b[4])) + f32(a[2] * b[7]));
  c[2] = f32(f32(f32(a[0] * b[2]) + f32(a[1] * b[5])) + f32(a[2] * b[8]));
  c[3] = f32(f32(f32(a[3] * b[0]) + f32(a[4] * b[3])) + f32(a[5] * b[6]));
  c[4] = f32(f32(f32(a[3] * b[1]) + f32(a[4] * b[4])) + f32(a[5] * b[7]));
  c[5] = f32(f32(f32(a[3] * b[2]) + f32(a[4] * b[5])) + f32(a[5] * b[8]));
  c[6] = f32(f32(f32(a[6] * b[0]) + f32(a[7] * b[3])) + f32(a[8] * b[6]));
  c[7] = f32(f32(f32(a[6] * b[1]) + f32(a[7] * b[4])) + f32(a[8] * b[7]));
  c[8] = f32(f32(f32(a[6] * b[2]) + f32(a[7] * b[5])) + f32(a[8] * b[8]));
  return c;
}

function checkFloatValues(values: number[]): number[] {
  for (let i = 0; i < 9; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error('Multiplying two matrices produces illegal values');
    }
  }
  return values;
}

function toMatrix9(m: number[]): number[] {
  return m.length === 9 ? m : [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1];
}

function premultiply(m: number[], ctm: number[]): number[] {
  return checkFloatValues(multiplyMatrices(toMatrix9(m), ctm));
}

function transformPoint(m: number[], x: number, y: number): { x: number; y: number } {
  const a = m[0];
  const b = m[1];
  const c = m[3];
  const d = m[4];
  const e = m[6];
  const f = m[7];
  return {
    x: f32(f32(f32(x * a) + f32(y * c)) + e),
    y: f32(f32(f32(x * b) + f32(y * d)) + f),
  };
}

function bboxOfUnitSquare(ctm: number[]): Placement {
  const p0 = transformPoint(ctm, 0, 0);
  const p1 = transformPoint(ctm, 1, 0);
  const p2 = transformPoint(ctm, 1, 1);
  const p3 = transformPoint(ctm, 0, 1);
  return {
    x0: Math.min(Math.min(p0.x, p1.x), Math.min(p2.x, p3.x)),
    y0: Math.min(Math.min(p0.y, p1.y), Math.min(p2.y, p3.y)),
    x1: Math.max(Math.max(p0.x, p1.x), Math.max(p2.x, p3.x)),
    y1: Math.max(Math.max(p0.y, p1.y), Math.max(p2.y, p3.y)),
  };
}

export function coverage(bbox: Placement, pageRectangle: Rect): number {
  const ix0 = Math.max(bbox.x0, pageRectangle.llx);
  const iy0 = Math.max(bbox.y0, pageRectangle.lly);
  const ix1 = Math.min(bbox.x1, f32(pageRectangle.llx + pageRectangle.width));
  const iy1 = Math.min(bbox.y1, f32(pageRectangle.lly + pageRectangle.height));
  if (ix1 <= ix0 || iy1 <= iy0) return 0.0;
  const denom = f32(pageRectangle.width * pageRectangle.height);
  return ((ix1 - ix0) * (iy1 - iy0)) / denom;
}

function createMatrix9(base: PDFObject | undefined, dict: PDFDict): number[] {
  if (!(base instanceof PDFArray)) return IDENTITY9.slice();
  if (base.size() < 6) return IDENTITY9.slice();
  for (let i = 0; i < 6; i++) {
    if (!(resolveRaw(dict, base.get(i)) instanceof PDFNumber)) return IDENTITY9.slice();
  }
  const m = IDENTITY9.slice();
  m[0] = arrayNumber(dict, base, 0);
  m[1] = arrayNumber(dict, base, 1);
  m[3] = arrayNumber(dict, base, 2);
  m[4] = arrayNumber(dict, base, 3);
  m[6] = arrayNumber(dict, base, 4);
  m[7] = arrayNumber(dict, base, 5);
  return m;
}

function formMatrix(form: PDFStream): number[] {
  return createMatrix9(resolvedValue(form.dict, PDF_NAME_Matrix), form.dict);
}

function formLength(form: PDFStream): number {
  const v = resolvedValue(form.dict, PDF_NAME_Length);
  return v instanceof PDFNumber ? javaIntFromFloat(v.asNumber()) : 0;
}

function decodeStream(stream: PDFStream): Uint8Array {
  return decodePDFRawStream(stream as PDFRawStream).decode();
}

function getNameAsString(dict: PDFDict, key: PDFName): string | null {
  const v = resolvedValue(dict, key);
  if (v instanceof PDFName) return v.decodeText();
  if (v instanceof PDFString) return v.decodeText();
  return null;
}

interface XObjectImage {
  kind: 'image';
  stream: PDFStream;
}
interface XObjectForm {
  kind: 'form';
  stream: PDFStream;
}
interface XObjectOther {
  kind: 'other';
  stream: PDFStream;
}
type XObject = XObjectImage | XObjectForm | XObjectOther;

function createXObject(stream: PDFStream): XObject {
  const subtype = getNameAsString(stream.dict, PDF_NAME_Subtype);
  if (subtype === 'Image') return { kind: 'image', stream };
  if (subtype === 'Form') return { kind: 'form', stream };
  if (subtype === 'PS') return { kind: 'other', stream };
  throw new PdfIOException('Invalid XObject Subtype: ' + (subtype === null ? 'null' : subtype));
}

function getResourceObject(res: Res, kind: PDFName, name: PDFName): PDFObject | undefined {
  if (res === null || res === EMPTY_RESOURCES) return undefined;
  const resBase = dictOf(res);
  const kindObj = asDictLike(resolvedValue(resBase, kind));
  if (kindObj === null || kindObj === EMPTY_RESOURCES) return undefined;
  return resolvedValue(dictOf(kindObj), name);
}

function isImageXObject(res: Res, name: PDFName): boolean {
  const value = getResourceObject(res, PDF_NAME_XObject, name);
  if (!(value instanceof PDFStream)) return false;
  return getNameAsString(value.dict, PDF_NAME_Subtype) === 'Image';
}

function getXObject(res: Res, name: PDFName): XObject | null {
  const value = getResourceObject(res, PDF_NAME_XObject, name);
  if (value === undefined) return null;
  if (!(value instanceof PDFStream)) {
    const cls = (value as { constructor: { name: string } }).constructor.name;
    throw new PdfIOException('Unexpected object type: ' + cls);
  }
  return createXObject(value);
}

function contentsValue(page: PDFPage): PDFObject | undefined {
  return resolvedValue(page.node, PDF_NAME_Contents);
}

export function pageHasContents(page: PDFPage): boolean {
  const value = contentsValue(page);
  if (value instanceof PDFStream) return value.dict.keys().length > 0;
  if (value instanceof PDFArray) return value.size() > 0;
  return false;
}

export function pageContentBytes(page: PDFPage): Uint8Array {
  const value = contentsValue(page);
  if (value instanceof PDFStream) {
    try {
      return decodeStream(value);
    } catch {
      return Uint8Array.of(10);
    }
  }
  if (value instanceof PDFArray) {
    const base = page.node;
    const chunks: number[] = [];
    for (let i = 0; i < value.size(); i++) {
      const el = resolveRaw(base, value.get(i));
      if (!(el instanceof PDFStream)) continue;
      try {
        const b = decodeStream(el);
        for (let j = 0; j < b.length; j++) chunks.push(b[j]);
        chunks.push(10);
      } catch {
        /* malformed substream skipped */
      }
    }
    return Uint8Array.from(chunks);
  }
  return new Uint8Array(0);
}

function formContentBytes(form: PDFStream): Uint8Array {
  try {
    return decodeStream(form);
  } catch (e) {
    throw new PdfIOException(e instanceof Error ? e.message : String(e));
  }
}

export function pageResourcesRes(page: PDFPage): Res {
  return asDictLike(pageInheritable(page.node, PDF_NAME_Resources));
}

function formResourcesRes(form: PDFStream): Res {
  const base = form.dict;
  if (base.get(PDF_NAME_Resources, true) !== undefined) {
    const v = resolveRaw(base, base.get(PDF_NAME_Resources, false));
    const dict = asDictLike(v);
    return dict === null ? EMPTY_RESOURCES : dict;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Xref resolution
// ---------------------------------------------------------------------------

export class XrefResolver {
  private readonly map = new WeakMap<PDFObject, number>();
  private readonly fallback = new Map<PDFObject, number>();
  private nextFallback = -1;

  constructor(doc: PDFDocument) {
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      this.map.set(obj, ref.objectNumber);
    }
  }

  of(base: PDFObject | undefined): number {
    if (base === undefined) return -1;
    const known = this.map.get(base);
    if (known !== undefined) return known;
    let f = this.fallback.get(base);
    if (f === undefined) {
      f = this.nextFallback--;
      this.fallback.set(base, f);
    }
    return f;
  }
}

// ---------------------------------------------------------------------------
// Content scanner
// ---------------------------------------------------------------------------

export class ContentScanner {
  private stack: number[][] = [];
  private resources: Res = null;
  private level = 0;
  private readonly images = new Map<number, FoundImage>();
  private currentPage: PDFPage | null = null;

  constructor(private readonly xref: XrefResolver) {}

  getPlacements(): Map<number, FoundImage> {
    return this.images;
  }

  processPage(page: PDFPage): void {
    this.stack = [IDENTITY9.slice()];
    this.resources = null;
    this.currentPage = page;
    if (pageHasContents(page)) {
      this.processStream(pageResourcesRes(page), IDENTITY9, pageContentBytes(page));
    }
  }

  private top(): number[] {
    return this.stack[this.stack.length - 1];
  }

  private activeResources(): Res {
    if (this.resources !== null) return this.resources;
    if (this.currentPage !== null) return pageResourcesRes(this.currentPage);
    return null;
  }

  private pushResources(sr: Res): Res {
    const parent = this.resources;
    if (sr !== null) this.resources = sr;
    else if (this.resources === null) this.resources = this.currentPage === null ? null : pageResourcesRes(this.currentPage);
    return parent;
  }

  private processStream(resources: Res, matrix: number[], contents: Uint8Array): void {
    const parent = this.pushResources(resources);
    const savedStack = this.stack;
    this.stack = [this.top().slice()];
    this.stack[0] = premultiply(matrix, this.top());
    try {
      this.processStreamOperators(contents);
    } finally {
      this.stack = savedStack;
      this.resources = parent;
    }
  }

  private processStreamOperators(contents: Uint8Array): void {
    const parser = new ContentParser(new ByteSource(contents));
    let operands: Val[] = [];
    for (;;) {
      const token = parser.parseNextToken();
      if (token === null) break;
      if (isOpTok(token)) {
        this.processOperator(token.op, operands);
        operands = [];
      } else {
        operands.push(token);
      }
    }
  }

  private processOperator(name: string, operands: Val[]): void {
    if (name === 'Do' && operands.length > 0 && isNameVal(operands[0])) {
      const xname = operands[0].n;
      let xobject: XObject | null;
      try {
        xobject = getXObject(this.activeResources(), xname);
      } catch (e) {
        if (!(e instanceof PdfIOException)) throw e;
        xobject = null;
      }
      if (xobject !== null && xobject.kind === 'image') {
        const xref = this.xref.of(xobject.stream);
        if (!this.images.has(xref)) {
          this.images.set(xref, { stream: xobject.stream, placement: bboxOfUnitSquare(this.top()) });
        }
      } else if (xobject !== null && xobject.kind === 'form') {
        this.level++;
        try {
          if (this.level > 50) return;
          this.showForm(xobject.stream);
        } finally {
          this.level--;
        }
      }
      return;
    }
    this.superProcessOperator(name, operands);
  }

  private superProcessOperator(name: string, operands: Val[]): void {
    try {
      if (name === 'cm') {
        this.opConcatenate(operands);
      } else if (name === 'q') {
        this.stack.push(this.top().slice());
      } else if (name === 'Q') {
        if (this.stack.length > 1) this.stack.pop();
        else throw new EmptyGraphicsStackError();
      }
    } catch (e) {
      if (e instanceof MissingOperandError || e instanceof EmptyGraphicsStackError) return;
      if (name === 'Do') return;
      throw e;
    }
  }

  private opConcatenate(operands: Val[]): void {
    if (operands.length < 6) throw new MissingOperandError();
    for (const op of operands) {
      if (!isNumVal(op)) return;
    }
    const m = [
      (operands[0] as NumToken).f,
      (operands[1] as NumToken).f,
      (operands[2] as NumToken).f,
      (operands[3] as NumToken).f,
      (operands[4] as NumToken).f,
      (operands[5] as NumToken).f,
    ];
    this.stack[this.stack.length - 1] = premultiply(m, this.top());
  }

  private showForm(form: PDFStream): void {
    if (this.currentPage === null) throw new Error('Current page is null');
    if (formLength(form) > 0) {
      this.processStream(formResourcesRes(form), formMatrix(form), formContentBytes(form));
    }
  }
}

// ---------------------------------------------------------------------------
// Resource collection helpers
// ---------------------------------------------------------------------------

export function collectImageXrefs(
  res: Res,
  out: Set<number>,
  xref: XrefResolver,
  depth: number,
): void {
  if (res === null || res === EMPTY_RESOURCES || depth > 50) return;
  const resBase = dictOf(res);
  const xo = asDictLike(resolvedValue(resBase, PDF_NAME_XObject));
  if (xo === null || xo === EMPTY_RESOURCES) return;
  const xoBase = dictOf(xo);
  for (const name of xoBase.keys()) {
    if (isImageXObject(res, name)) {
      out.add(xref.of(resolveRaw(xoBase, xoBase.get(name, false))));
    } else {
      let xobject: XObject | null;
      try {
        xobject = getXObject(res, name);
      } catch {
        continue;
      }
      if (xobject !== null && xobject.kind === 'form') {
        collectImageXrefs(formResourcesRes(xobject.stream), out, xref, depth + 1);
      }
    }
  }
}

export function pageLevelImageNames(res: Res, xref: XrefResolver): Map<number, string> {
  const map = new Map<number, string>();
  if (res === null || res === EMPTY_RESOURCES) return map;
  const resBase = dictOf(res);
  const xo = asDictLike(resolvedValue(resBase, PDF_NAME_XObject));
  if (xo === null || xo === EMPTY_RESOURCES) return map;
  const xoBase = dictOf(xo);
  for (const name of xoBase.keys()) {
    if (isImageXObject(res, name)) {
      const key = xref.of(resolveRaw(xoBase, xoBase.get(name, false)));
      if (!map.has(key)) map.set(key, name.decodeText());
    }
  }
  return map;
}

export { EMPTY_RESOURCES };
export type { Res };
