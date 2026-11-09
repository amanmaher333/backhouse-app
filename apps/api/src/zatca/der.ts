/*
 * Minimal ASN.1 DER encoding and decoding: enough for ZATCA certificate signing
 * requests, reading the certificates ZATCA issues, and (in simulated mode) issuing
 * test certificates. Node's crypto has no CSR builder, hence this.
 */

export type Der = Buffer;

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const tlv = (tag: number, value: Buffer): Der => Buffer.concat([Buffer.from([tag]), len(value.length), value]);
export const seq = (...items: Der[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Der[]) => tlv(0x31, Buffer.concat(items));
export const nul = () => Buffer.from([0x05, 0x00]);
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
export const printable = (s: string) => tlv(0x13, Buffer.from(s, 'ascii'));
export const octets = (b: Buffer) => tlv(0x04, b);
export const bitString = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
export const utcTime = (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`, 'ascii'));
/** [n] EXPLICIT (constructed). */
export const explicit = (n: number, inner: Der) => tlv(0xa0 | n, inner);
/** [n] IMPLICIT constructed (e.g. the CSR attributes set, GeneralName directoryName). */
export const implicitConstructed = (n: number, content: Buffer) => tlv(0xa0 | n, content);

export function integer(v: number | bigint | Buffer): Der {
  let b: Buffer;
  if (Buffer.isBuffer(v)) b = v;
  else {
    let hex = BigInt(v).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    b = Buffer.from(hex, 'hex');
  }
  // Positive integers: strip leading zeros, then add one if the high bit is set.
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(dotted: string): Der {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    let n = Math.floor(p / 128);
    while (n > 0) {
      stack.unshift((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

export interface Node {
  tag: number;
  /** Full encoding, header included. */
  raw: Buffer;
  /** Contents, header excluded. */
  value: Buffer;
  children: Node[];
}

/** Parse one DER element (and, for constructed types, its children). */
export function parse(buf: Buffer, offset = 0): Node {
  const tag = buf[offset]!;
  let p = offset + 1;
  let length = buf[p++]!;
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[p++]!;
  }
  const value = buf.subarray(p, p + length);
  const node: Node = { tag, raw: buf.subarray(offset, p + length), value, children: [] };
  if (tag & 0x20) {
    let q = 0;
    while (q < value.length) {
      const child = parse(value, q);
      node.children.push(child);
      q += child.raw.length;
    }
  }
  return node;
}

export function oidToString(value: Buffer): string {
  const out = [Math.floor(value[0]! / 40), value[0]! % 40];
  let n = 0;
  for (const b of value.subarray(1)) {
    n = n * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      out.push(n);
      n = 0;
    }
  }
  return out.join('.');
}

export const pem = (label: string, der: Buffer) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
export const unpem = (text: string) => Buffer.from(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
