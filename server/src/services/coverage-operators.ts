import { HttpError } from '../auth.ts';
import type { Config } from '../config.ts';
import { nowIso, type Db } from '../db.ts';
import type { MyWicClient } from './mywic.ts';

/**
 * The coverage of the other operators (fibre, FTTC, FWA, mobile) for a point: read from the
 * multi-operator coverage connector, grouped by the AGCOM sticker (delibere 292/18, 285/25, 207/26)
 * that we compute ourselves from technology and speed. A lookup is kept for some days, and the
 * calls to the service are capped (60 a minute on their side).
 */

export type Sticker = 'F' | 'FWA' | 'FR' | 'R';
export type OpsState = 'available' | 'planned' | 'none';
export type OpsKind = 'fibra' | 'fibra-rame' | 'fibra-radio' | 'radio' | 'mobile' | 'rame' | 'altro';

export const STICKERS: Record<Sticker, { label: string; color: string }> = {
  F: { label: 'F · fibra', color: '#0f940f' },
  FWA: { label: 'FWA · radio VHCN', color: '#1e63d6' },
  FR: { label: 'FR · misto fibra', color: '#ffc007' },
  R: { label: 'R · rame o radio', color: '#ef2929' },
};
const ORDER: Sticker[] = ['F', 'FWA', 'FR', 'R'];

/** One operator × technology at the address, as we keep it (the technical details of the source stay out). */
export interface OpsRow {
  operator: string;
  technology: string;
  technologyLabel: string;
  family: string;
  /** The source's own sticker (f, fr, fw, w, r), a fallback for unknown technologies. */
  sourceSticker: string;
  state: OpsState;
  maxMbps: number | null;
  downMbps: number | null;
  upMbps: number | null;
}
export interface OpsAddress {
  label: string;
  city: string;
  lat: number | null;
  lon: number | null;
  geoid: string | null;
}
interface Lookup {
  address: OpsAddress | null;
  rows: OpsRow[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : null);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A row of the source → ours (pure). */
export function opsRow(r: Record<string, unknown>): OpsRow | null {
  const carrier = (r.carrier ?? {}) as Record<string, unknown>;
  const tech = (r.technology ?? {}) as Record<string, unknown>;
  const data = (r.data && !Array.isArray(r.data) ? r.data : {}) as Record<string, unknown>;
  const technology = str(tech.value) || str(tech.name);
  const operator = str(carrier.description) || str(carrier.name) || str(carrier.value);
  if (!technology || !operator) return null;
  const status = str(r.status).toUpperCase();
  const state: OpsState = status.includes('STUDIO') ? 'planned' : r.covered === true && !status.startsWith('NON') ? 'available' : 'none';
  return {
    operator,
    technology,
    technologyLabel: str(tech.description) || technology,
    family: str(r.family) || str((tech.family as Record<string, unknown> | undefined)?.value),
    sourceSticker: str(tech.sticker).toLowerCase(),
    state,
    maxMbps: num(data.max_speed),
    downMbps: num(data.velocita_down),
    upMbps: num(data.velocita_up),
  };
}

/** The AGCOM sticker of a row and what it is made of (pure). */
export function stickerOf(r: Pick<OpsRow, 'technology' | 'family' | 'sourceSticker' | 'maxMbps'>, rules: { fwaMinMbps: number; vhcnTechs: string[] }): { sticker: Sticker; kind: OpsKind } {
  const t = r.technology.toUpperCase();
  const fam = r.family.toUpperCase();
  if (/^(FTTC|FTTE|FTTS|FTTDP|VDSL|EVDSL)/.test(t)) return { sticker: 'FR', kind: 'fibra-rame' };
  if (fam === 'MOBILE' || /^(LTE|4G|5G|UMTS|HSPA)/.test(t)) return { sticker: 'R', kind: 'mobile' };
  if (fam.startsWith('FWA') || t.startsWith('WIRELESS') || t.startsWith('FWA')) {
    if (rules.vhcnTechs.includes(t)) return { sticker: 'FWA', kind: 'radio' };
    return (r.maxMbps ?? 0) >= rules.fwaMinMbps ? { sticker: 'FR', kind: 'fibra-radio' } : { sticker: 'R', kind: 'radio' };
  }
  if (/^(ADSL|SHDSL|HDSL|XDSL|RAME)/.test(t)) return { sticker: 'R', kind: 'rame' };
  if (/^(FTTH|FTTO|FTTB|GPON|XGS|FIBRA|P2P)/.test(t) || fam === 'P2P' || r.sourceSticker === 'f') return { sticker: 'F', kind: 'fibra' };
  if (r.sourceSticker === 'fr' || r.sourceSticker === 'fw') return { sticker: 'FR', kind: 'altro' };
  return { sticker: 'R', kind: 'altro' };
}

const STATE_ORDER: Record<OpsState, number> = { available: 0, planned: 1, none: 2 };

/** The rows grouped by sticker, best first; the best sticker among what can be activated (pure). */
export function groupOps(rows: OpsRow[], rules: { fwaMinMbps: number; vhcnTechs: string[] }) {
  const by = new Map<Sticker, Array<OpsRow & { kind: OpsKind }>>();
  for (const r of rows) {
    const { sticker, kind } = stickerOf(r, rules);
    by.set(sticker, [...(by.get(sticker) ?? []), { ...r, kind }]);
  }
  const groups = ORDER.filter((s) => by.has(s)).map((s) => ({
    sticker: s,
    ...STICKERS[s],
    available: by.get(s)!.filter((r) => r.state === 'available').length,
    rows: by
      .get(s)!
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (b.maxMbps ?? 0) - (a.maxMbps ?? 0) || a.operator.localeCompare(b.operator, 'it'))
      .map(({ sourceSticker: _, ...r }) => r),
  }));
  return {
    best: groups.find((g) => g.available > 0)?.sticker ?? null,
    available: rows.filter((r) => r.state === 'available').length,
    groups,
  };
}

/** «PIAZZA NAPOLEONE COLAJANNI 1, 94100 Enna (EN)» from the source's geodata (pure). */
export function opsAddress(g: Record<string, unknown> | null | undefined): OpsAddress | null {
  if (!g || typeof g !== 'object') return null;
  const city = str(g.name_utf8) || str((g.city as Record<string, unknown> | undefined)?.name_utf8);
  const street = [str(g.street_type), str(g.street), str(g.number)].filter(Boolean).join(' ');
  const label = [street, [str(g.zip), city].filter(Boolean).join(' ') + (str(g.abbreviation) ? ` (${str(g.abbreviation)})` : '')].filter((x) => x.trim()).join(', ');
  return { label, city, lat: typeof g.lat === 'number' ? g.lat : null, lon: typeof g.lng === 'number' ? g.lng : null, geoid: str(g.id) || null };
}

export function createCoverageOps(db: Db, cfg: Config, client: () => MyWicClient | null) {
  const calls: number[] = [];
  const rules = () => ({ fwaMinMbps: cfg.coverageOps.fwaMinMbps, vhcnTechs: cfg.coverageOps.vhcnTechs.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean) });

  const cached = (key: string) => {
    const r = db.prepare('SELECT at, payload FROM coverage_ops_cache WHERE key = ?').get(key) as { at: string; payload: string } | undefined;
    if (!r || Date.now() - Date.parse(r.at) > cfg.coverageOps.cacheDays * 86_400_000) return null;
    return { at: r.at, ...(JSON.parse(r.payload) as Lookup) };
  };
  const keep = (keys: string[], l: Lookup) => {
    const at = nowIso();
    const put = db.prepare('INSERT INTO coverage_ops_cache(key, at, payload) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, payload = excluded.payload');
    for (const k of keys) put.run(k, at, JSON.stringify(l));
    // what nobody will reuse any more
    db.prepare('DELETE FROM coverage_ops_cache WHERE at < ?').run(new Date(Date.now() - 90 * 86_400_000).toISOString());
    return at;
  };
  /** Our share of the service's 60 calls a minute. */
  const take = () => {
    const now = Date.now();
    while (calls.length && now - calls[0]! > 60_000) calls.shift();
    if (calls.length >= 40) throw new HttpError(429, 'operators_busy');
    calls.push(now);
  };

  return {
    /** The coverage at a point (the service finds the address and its GeoID there). */
    async atPoint(lat: number, lon: number, opts: { refresh?: boolean } = {}) {
      const key = `ll:${lat.toFixed(5)},${lon.toFixed(5)}`;
      const hit = opts.refresh ? null : cached(key);
      let l: Lookup & { at: string };
      let fresh = false;
      if (hit) l = hit;
      else {
        const c = client();
        if (!c) throw new HttpError(409, 'operators_not_configured');
        take();
        const j = (await c.get(`/coverage/check?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}`)) as { coverage?: unknown; geodata?: Record<string, unknown> };
        const list = Array.isArray(j?.coverage) ? (j.coverage as Array<Record<string, unknown>>) : [];
        const look: Lookup = { address: opsAddress(j?.geodata), rows: list.map(opsRow).filter((r): r is OpsRow => !!r) };
        const at = keep([key, ...(look.address?.geoid ? [`geo:${look.address.geoid}`] : [])], look);
        l = { ...look, at };
        fresh = true;
      }
      return { at: l.at, cached: !fresh, fresh, address: l.address, ...groupOps(l.rows, rules()), stickers: STICKERS };
    },
  };
}
export type CoverageOps = ReturnType<typeof createCoverageOps>;
