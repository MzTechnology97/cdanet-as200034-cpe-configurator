/**
 * Minimal Mapbox Vector Tile (MVT 2.1) reader: the layers, the features with their properties and
 * geometry in tile coordinates (0…extent). Enough to read the buildings of the basemap on the
 * server; no dependency.
 */

export interface MvtFeature {
  type: 1 | 2 | 3;
  props: Record<string, string | number | boolean>;
  /** Rings (polygons), lines or points as [x, y] in tile coordinates. */
  geometry: Array<Array<[number, number]>>;
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

class Pbf {
  pos = 0;
  readonly b: Uint8Array;
  readonly end: number;
  constructor(b: Uint8Array) {
    this.b = b;
    this.end = b.length;
  }
  varint(): number {
    let v = 0;
    let shift = 0;
    for (;;) {
      const x = this.b[this.pos++]!;
      v += (x & 0x7f) * 2 ** shift;
      if (x < 0x80) return v;
      shift += 7;
      if (shift > 63) throw new Error('mvt: bad varint');
    }
  }
  bytes(): Uint8Array {
    const n = this.varint();
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`mvt: wire type ${wire}`);
  }
}

const text = new TextDecoder();
const zigzag = (n: number) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

function readValue(b: Uint8Array): string | number | boolean {
  const p = new Pbf(b);
  let v: string | number | boolean = '';
  while (p.pos < p.end) {
    const key = p.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 1) v = text.decode(p.bytes());
    else if (field === 2) {
      v = new DataView(b.buffer, b.byteOffset + p.pos, 4).getFloat32(0, true);
      p.pos += 4;
    } else if (field === 3) {
      v = new DataView(b.buffer, b.byteOffset + p.pos, 8).getFloat64(0, true);
      p.pos += 8;
    } else if (field === 4 || field === 5) v = p.varint();
    else if (field === 6) v = zigzag(p.varint());
    else if (field === 7) v = p.varint() !== 0;
    else p.skip(wire);
  }
  return v;
}

function packed(b: Uint8Array): number[] {
  const p = new Pbf(b);
  const out: number[] = [];
  while (p.pos < p.end) out.push(p.varint());
  return out;
}

function geometry(cmds: number[]): Array<Array<[number, number]>> {
  const parts: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < cmds.length) {
    const c = cmds[i++]!;
    const id = c & 7;
    const count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzag(cmds[i++]!);
        y += zigzag(cmds[i++]!);
        if (id === 1) {
          if (cur.length) parts.push(cur);
          cur = [];
        }
        cur.push([x, y]);
      }
    } else if (id === 7) {
      if (cur.length) cur.push(cur[0]!);
    } else break;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/** The layers of a tile ([only]: just those names, the others are skipped without decoding). */
export function readMvt(buf: Uint8Array, only?: Set<string>): MvtLayer[] {
  const tile = new Pbf(buf);
  const layers: MvtLayer[] = [];
  while (tile.pos < tile.end) {
    const key = tile.varint();
    if (key >> 3 !== 3 || (key & 7) !== 2) {
      tile.skip(key & 7);
      continue;
    }
    const lb = tile.bytes();
    const l = new Pbf(lb);
    let name = '';
    let extent = 4096;
    const keys: string[] = [];
    const values: Array<string | number | boolean> = [];
    const raw: Uint8Array[] = [];
    while (l.pos < l.end) {
      const k = l.varint();
      const field = k >> 3;
      if (field === 1) name = text.decode(l.bytes());
      else if (field === 2) raw.push(l.bytes());
      else if (field === 3) keys.push(text.decode(l.bytes()));
      else if (field === 4) values.push(readValue(l.bytes()));
      else if (field === 5) extent = l.varint();
      else l.skip(k & 7);
    }
    if (only && !only.has(name)) continue;
    const features: MvtFeature[] = raw.map((fb) => {
      const f = new Pbf(fb);
      let type = 0;
      let tags: number[] = [];
      let geom: number[] = [];
      while (f.pos < f.end) {
        const k = f.varint();
        const field = k >> 3;
        if (field === 2) tags = packed(f.bytes());
        else if (field === 3) type = f.varint();
        else if (field === 4) geom = packed(f.bytes());
        else f.skip(k & 7);
      }
      const props: MvtFeature['props'] = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]!]!] = values[tags[i + 1]!]!;
      return { type: (type || 3) as 1 | 2 | 3, props, geometry: geometry(geom) };
    });
    layers.push({ name, extent, features });
  }
  return layers;
}
