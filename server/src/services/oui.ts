import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MAC vendor lookup from the official IEEE registries (MA-L 24-bit, MA-M 28-bit, MA-S 36-bit),
 * downloaded by the server and refreshed every 30 days: no third-party API, no rate limit,
 * works for hundreds of MACs per scan. Locally administered (randomised) MACs are reported as such.
 */

const REGISTRIES = [
  { file: 'oui.csv', url: 'https://standards-oui.ieee.org/oui/oui.csv', bits: 24 },
  { file: 'mam.csv', url: 'https://standards-oui.ieee.org/oui28/mam.csv', bits: 28 },
  { file: 'oui36.csv', url: 'https://standards-oui.ieee.org/oui36/oui36.csv', bits: 36 },
] as const;
const MAX_AGE_MS = 30 * 86400_000;

export const RANDOM_MAC = 'MAC casuale (privacy del dispositivo)';

/** "MA-L,0011AA,Some Org,Address" with quoted fields. */
export function parseOuiCsv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const cells: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    const assignment = (cells[1] ?? '').trim().toUpperCase();
    const org = (cells[2] ?? '').trim();
    if (/^[0-9A-F]{6,9}$/.test(assignment) && org) out.set(assignment, org);
  }
  return out;
}

export const macHex = (mac: string) => mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

export function createOui(dir: string, opts: { fetchImpl?: typeof fetch; log?: (m: string) => void } = {}) {
  const f = opts.fetchImpl ?? fetch;
  // prefix length (hex chars: 6, 7, 9) -> map
  const tables = new Map<number, Map<string, string>>();
  let loading: Promise<void> | null = null;
  let loadedAt = 0;

  async function loadOne(r: (typeof REGISTRIES)[number]) {
    const path = join(dir, r.file);
    let text: string | null = null;
    try {
      if (Date.now() - statSync(path).mtimeMs < MAX_AGE_MS) text = readFileSync(path, 'utf8');
    } catch {
      /* not cached yet */
    }
    if (!text) {
      try {
        const res = await f(r.url, { headers: { 'User-Agent': 'CDA-Net-CPE-Configurator (AS200034)' }, signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, text);
      } catch (e) {
        opts.log?.(`oui ${r.file}: ${(e as Error).message}`);
        try {
          text = readFileSync(path, 'utf8'); // stale copy is better than nothing
        } catch {
          return;
        }
      }
    }
    tables.set(r.bits / 4, parseOuiCsv(text));
  }

  async function ensure() {
    if (tables.size && Date.now() - loadedAt < MAX_AGE_MS) return;
    loading ??= Promise.all(REGISTRIES.map(loadOne)).then(() => {
      loadedAt = Date.now();
      loading = null;
    });
    await loading;
  }

  function lookupOne(mac: string): string | null {
    const hex = macHex(mac);
    if (hex.length !== 12) return null;
    // Locally administered bit: phones/PCs randomise their MAC per network.
    if ((parseInt(hex.slice(0, 2), 16) & 0x02) !== 0) return RANDOM_MAC;
    for (const len of [9, 7, 6]) {
      const v = tables.get(len)?.get(hex.slice(0, len));
      if (v) return v;
    }
    return null;
  }

  return {
    async lookup(macs: string[]): Promise<Record<string, string | null>> {
      await ensure();
      return Object.fromEntries(macs.map((m) => [m, lookupOne(m)]));
    },
    async size() {
      await ensure();
      return [...tables.values()].reduce((a, t) => a + t.size, 0);
    },
  };
}
export type Oui = ReturnType<typeof createOui>;
