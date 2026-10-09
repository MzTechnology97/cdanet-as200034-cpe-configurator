/**
 * airOS firmware images: a "UBNT" header followed by the build string, e.g.
 * `XC.qca956x.v8.7.4.45112.210415.1103`. The first token is the hardware platform (XC, WA, 2XC…):
 * an image can only go on a CPE whose /etc/version starts with the same platform.
 */

export interface AirosBuild {
  platform: string;
  /** "8.7.4" */
  version: string;
  /** The whole build string. */
  build: string;
}

const BUILD_RX = /^([A-Z0-9]{1,8})\.([A-Za-z0-9_-]{1,32})\.v(\d+\.\d+\.\d+)(?:[.-][A-Za-z0-9._-]*)?$/;

/** Parses a build string (header of the image or the first line of /etc/version on the CPE). */
export function parseAirosBuild(text: string): AirosBuild | null {
  const s = String(text).trim().split(/\s+/)[0] ?? '';
  const m = BUILD_RX.exec(s);
  return m ? { platform: m[1]!, version: m[3]!, build: s } : null;
}

/** Reads the header of an uploaded image; null when it is not an airOS firmware. */
export function parseAirosImage(buf: Buffer): AirosBuild | null {
  if (buf.length < 1024 * 1024 || buf.subarray(0, 4).toString('latin1') !== 'UBNT') return null;
  const raw = buf.subarray(4, 4 + 256);
  const end = raw.indexOf(0);
  return parseAirosBuild(raw.subarray(0, end < 0 ? raw.length : end).toString('latin1'));
}
