import { deflateSync } from 'node:zlib';

/**
 * A small PDF writer for the reports of the server (A4, no dependencies): text in Helvetica and
 * Helvetica-Bold (WinAnsi, so Italian accents work), lines, filled boxes, circles, SVG-like paths
 * and JPEG photos. Coordinates are in points from the top-left corner of the page.
 */

export const A4 = { w: 595.28, h: 841.89 };
export type Rgb = [number, number, number];
export type FontName = 'regular' | 'bold';

/** Helvetica / Helvetica-Bold advance widths (1/1000 em) for ASCII 32–126. */
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Characters of WinAnsiEncoding beyond Latin-1, and their codes. */
const WIN_ANSI: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };

/** The WinAnsi byte of a character (accents of Latin-1 as they are), '?' for anything else. */
function winAnsi(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c >= 32 && c <= 126) return c;
  if (c >= 160 && c <= 255) return c;
  return WIN_ANSI[ch] ?? 63;
}

/** The base letter of an accented one, for its width (à → a). */
const base = (ch: string) => ch.normalize('NFD').charAt(0);

export function textWidth(text: string, size: number, font: FontName = 'regular'): number {
  const table = font === 'bold' ? W_BOLD : W_REG;
  let w = 0;
  for (const ch of text) {
    const c = base(ch).charCodeAt(0);
    w += c >= 32 && c <= 126 ? table[c - 32]! : ch === '•' ? 350 : ch === '—' ? 1000 : 556;
  }
  return (w * size) / 1000;
}

/** Words of [text] in lines no wider than [width]. */
export function wrap(text: string, size: number, width: number, font: FontName = 'regular'): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, font) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const pdfString = (text: string) => {
  let s = '(';
  for (const ch of text) {
    const b = winAnsi(ch);
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
};

const n = (v: number) => (Math.round(v * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((x) => n(x / 255)).join(' ');

/** Width, height and colour components of a JPEG, from its start-of-frame marker. */
export function jpegInfo(data: Buffer): { width: number; height: number; components: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    const len = data.readUInt16BE(i + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7), components: data[i + 9]! };
    }
    i += 2 + len;
  }
  return null;
}

class Page {
  ops: string[] = [];
  images = new Map<string, number>();
}

export class PdfDoc {
  readonly pages: Page[] = [];
  private images: Array<{ data: Buffer; width: number; height: number; components: number }> = [];
  page!: Page;

  constructor() {
    this.addPage();
  }

  addPage() {
    this.page = new Page();
    this.pages.push(this.page);
  }

  private y = (top: number) => A4.h - top;

  text(x: number, top: number, text: string, opt: { size?: number; font?: FontName; color?: Rgb; align?: 'left' | 'right' | 'center' } = {}) {
    const size = opt.size ?? 10;
    const font = opt.font ?? 'regular';
    const w = textWidth(text, size, font);
    const left = opt.align === 'right' ? x - w : opt.align === 'center' ? x - w / 2 : x;
    // [top] is the top of the line: the baseline is about 0.8 em below
    this.page.ops.push(`BT /${font === 'bold' ? 'F2' : 'F1'} ${n(size)} Tf ${rgb(opt.color ?? [20, 23, 28])} rg 1 0 0 1 ${n(left)} ${n(this.y(top + size * 0.8))} Tm ${pdfString(text)} Tj ET`);
    return w;
  }

  /** Wrapped text from [top]; returns the height used. */
  paragraph(x: number, top: number, width: number, text: string, opt: { size?: number; font?: FontName; color?: Rgb; leading?: number } = {}) {
    const size = opt.size ?? 10;
    const lead = opt.leading ?? size * 1.35;
    const lines = wrap(text, size, width, opt.font);
    lines.forEach((l, i) => this.text(x, top + i * lead, l, opt));
    return lines.length * lead;
  }

  rect(x: number, top: number, w: number, h: number, fill?: Rgb, stroke?: Rgb, lineWidth = 0.75) {
    const ops = `${fill ? `${rgb(fill)} rg ` : ''}${stroke ? `${rgb(stroke)} RG ${n(lineWidth)} w ` : ''}${n(x)} ${n(this.y(top + h))} ${n(w)} ${n(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`;
    this.page.ops.push(ops);
  }

  line(x1: number, top1: number, x2: number, top2: number, color: Rgb, width = 0.75) {
    this.page.ops.push(`${rgb(color)} RG ${n(width)} w 1 J ${n(x1)} ${n(this.y(top1))} m ${n(x2)} ${n(this.y(top2))} l S`);
  }

  circle(cx: number, top: number, r: number, opt: { fill?: Rgb; stroke?: Rgb; width?: number }) {
    const k = 0.5523 * r;
    const cy = this.y(top);
    const p = `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c`;
    const paint = opt.fill && opt.stroke ? 'B' : opt.fill ? 'f' : 'S';
    this.page.ops.push(`${opt.fill ? `${rgb(opt.fill)} rg ` : ''}${opt.stroke ? `${rgb(opt.stroke)} RG ${n(opt.width ?? 1)} w ` : ''}${p} ${paint}`);
  }

  /**
   * An SVG path made of absolute M, L, Q and Z commands (the logo's lettering), placed with [scale]
   * and its origin at (x, top); filled with [fill].
   */
  svgPath(d: string, x: number, top: number, scale: number, fill: Rgb) {
    const tokens = d.match(/[MLQZ]|-?\d*\.?\d+/g) ?? [];
    const ops: string[] = [];
    let i = 0;
    let cx = 0;
    let cy = 0;
    const px = (v: number) => n(x + v * scale);
    const py = (v: number) => n(this.y(top + v * scale));
    let cmd = '';
    const num = () => Number(tokens[i++]);
    while (i < tokens.length) {
      if (/[MLQZ]/.test(tokens[i]!)) cmd = tokens[i++]!;
      if (cmd === 'M') ((cx = num()), (cy = num()), ops.push(`${px(cx)} ${py(cy)} m`), (cmd = 'L'));
      else if (cmd === 'L') ((cx = num()), (cy = num()), ops.push(`${px(cx)} ${py(cy)} l`));
      else if (cmd === 'Q') {
        // quadratic → cubic: control points at 2/3 of the way to the quadratic one
        const qx = num();
        const qy = num();
        const ex = num();
        const ey = num();
        const c1x = cx + (2 / 3) * (qx - cx);
        const c1y = cy + (2 / 3) * (qy - cy);
        const c2x = ex + (2 / 3) * (qx - ex);
        const c2y = ey + (2 / 3) * (qy - ey);
        ops.push(`${px(c1x)} ${py(c1y)} ${px(c2x)} ${py(c2y)} ${px(ex)} ${py(ey)} c`);
        cx = ex;
        cy = ey;
      } else if (cmd === 'Z') ops.push('h');
      else i++;
    }
    this.page.ops.push(`${rgb(fill)} rg ${ops.join(' ')} f`);
  }

  /** A JPEG photo in the box (x, top, w, h), scaled to fit and centred; false when it is not a JPEG. */
  jpeg(data: Buffer, x: number, top: number, w: number, h: number): { w: number; h: number } | false {
    const info = jpegInfo(data);
    if (!info || (info.components !== 1 && info.components !== 3)) return false;
    let idx = this.images.findIndex((im) => im.data === data);
    if (idx < 0) idx = this.images.push({ data, ...info }) - 1;
    const name = `Im${idx}`;
    this.page.images.set(name, idx);
    const s = Math.min(w / info.width, h / info.height);
    const dw = info.width * s;
    const dh = info.height * s;
    const left = x + (w - dw) / 2;
    const t = top + (h - dh) / 2;
    this.page.ops.push(`q ${n(dw)} 0 0 ${n(dh)} ${n(left)} ${n(this.y(t + dh))} cm /${name} Do Q`);
    return { w: dw, h: dh };
  }

  /** The finished file. */
  build(): Buffer {
    const objs: Buffer[] = [];
    const add = (body: string | Buffer) => objs.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body) ;
    // 1 catalog, 2 pages, 3–4 fonts, then images, then a page and its content per page
    const imageBase = 5;
    const pageBase = imageBase + this.images.length;
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(`<< /Type /Pages /Kids [${this.pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    for (const im of this.images) {
      add(Buffer.concat([
        Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /${im.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`, 'latin1'),
        im.data,
        Buffer.from('\nendstream', 'latin1'),
      ]));
    }
    this.pages.forEach((p, i) => {
      const xobj = [...p.images].map(([name, idx]) => `/${name} ${imageBase + idx} 0 R`).join(' ');
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobj ? ` /XObject << ${xobj} >>` : ''} >> /Contents ${pageBase + i * 2 + 1} 0 R >>`);
      const content = deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
      add(Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]));
    });
    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = parts[0]!.length;
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(offset);
      const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]);
      parts.push(chunk);
      offset += chunk.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}
