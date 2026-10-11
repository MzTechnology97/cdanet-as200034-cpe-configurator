import type { Sealer } from '../crypto.ts';
import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { HttpError } from '../auth.ts';

/**
 * Mapbox (Connettori): satellite and hybrid imagery for the admins' maps in the console. The token
 * stays on the server (sealed); tiles are fetched here for authenticated admins only, so it never
 * reaches a browser and installers keep the basemap they have.
 */

const KEY = 'connector.mapbox';

interface Stored {
  enabled: boolean;
  tokenSealed: string;
}

export type SatelliteKind = 'satellite' | 'hybrid';

export const MAPBOX_ATTRIBUTION = '© Mapbox © OpenStreetMap © Maxar';

/** Upstream URL of one 256 px tile (served at 512 px, @2x, for sharp screens). */
export function mapboxTileUrl(kind: SatelliteKind, z: number, x: number, y: number, token: string): string {
  const t = encodeURIComponent(token);
  return kind === 'satellite'
    ? `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg90?access_token=${t}`
    : `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/256/${z}/${x}/${y}@2x?access_token=${t}`;
}

/** Mapbox access tokens: "pk." (public) or "sk." (secret) and the encoded token. */
export const isMapboxToken = (v: string) => /^(pk|sk)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v);

export function createMapboxSettings(db: Db, sealer: Sealer, opts: { fetchImpl?: typeof fetch | undefined } = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const read = () => {
    const r = db
      .prepare('SELECT s.value, s.updated_at, u.username FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?')
      .get(KEY) as { value: string; updated_at: string; username: string | null } | undefined;
    return r ? { stored: JSON.parse(r.value) as Stored, updatedAt: r.updated_at, updatedBy: r.username } : null;
  };
  const savedToken = () => {
    const c = read()?.stored;
    return c?.tokenSealed ? sealer.open(c.tokenSealed) : null;
  };
  /** The token in use: saved and switched on. */
  const active = () => (read()?.stored.enabled ? savedToken() : null);

  async function tile(kind: SatelliteKind, z: number, x: number, y: number, token = active()) {
    if (!token) throw new HttpError(503, 'mapbox_not_configured');
    const r = await doFetch(mapboxTileUrl(kind, z, x, y, token), { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!r) throw new HttpError(502, 'mapbox_unreachable');
    if (r.status === 401 || r.status === 403) throw new HttpError(502, 'mapbox_token_rejected');
    if (r.status === 404) return null; // no imagery there
    if (!r.ok) throw new HttpError(502, 'mapbox_error', { detail: `HTTP ${r.status}` });
    return { type: r.headers.get('content-type') ?? 'image/jpeg', body: Buffer.from(await r.arrayBuffer()) };
  }

  return {
    available: () => !!active(),
    tile,
    /** One tile with the given (or the saved) token: is it accepted? */
    async test(token?: string) {
      const t = token || savedToken();
      if (!t) throw new HttpError(400, 'mapbox_incomplete');
      try {
        const r = await tile('satellite', 10, 551, 405, t);
        return { ok: true, bytes: r?.body.length ?? 0 };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    /** Never contains the token: only whether it is set and its last characters. */
    view() {
      const c = read();
      const t = savedToken() ?? '';
      return { configured: !!t, enabled: c?.stored.enabled ?? false, tokenSet: !!t, tokenHint: t ? `…${t.slice(-4)}` : '', updatedAt: c?.updatedAt ?? null, updatedBy: c?.updatedBy ?? null };
    },
    /** An empty token keeps the saved one. */
    save(input: { enabled: boolean; token?: string | undefined }, userId: number) {
      const prev = read()?.stored;
      const tokenSealed = input.token ? sealer.seal(input.token) : (prev?.tokenSealed ?? '');
      if (input.enabled && !tokenSealed) throw new HttpError(400, 'mapbox_incomplete');
      db.prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(KEY, JSON.stringify({ enabled: input.enabled, tokenSealed } satisfies Stored), nowIso(), userId);
    },
    reset() {
      db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
    },
  };
}
export type MapboxSettings = ReturnType<typeof createMapboxSettings>;
