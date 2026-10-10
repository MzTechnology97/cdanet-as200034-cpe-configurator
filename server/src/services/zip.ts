import { createWriteStream, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

/**
 * Extracts the first entry of a ZIP archive whose name matches [pattern] to [outPath], streaming
 * (stored or DEFLATE entries, no ZIP64): for the terrain archives, without external tools.
 * Returns the entry name, or null when no entry matches.
 */
export async function extractZipEntry(zipPath: string, pattern: RegExp, outPath: string): Promise<string | null> {
  const fd = openSync(zipPath, 'r');
  let entry: { name: string; method: number; size: number; local: number } | null = null;
  try {
    const size = fstatSync(fd).size;
    // end of central directory: in the last 64 KB + 22 bytes
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('ZIP non valido');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    for (let p = 0; p + 46 <= cdSize && cd.readUInt32LE(p) === 0x02014b50; ) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (pattern.test(name)) {
        entry = { name, method, size: compSize, local };
        break;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (!entry) return null;
    const lh = Buffer.alloc(30);
    readSync(fd, lh, 0, 30, entry.local);
    entry.local += 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  } finally {
    closeSync(fd);
  }
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`ZIP: metodo ${entry.method} non supportato`);
  const src = createReadStream(zipPath, { start: entry.local, end: entry.local + entry.size - 1 });
  if (entry.method === 0) await pipeline(src, createWriteStream(outPath));
  else await pipeline(src, createInflateRaw(), createWriteStream(outPath));
  return entry.name;
}
