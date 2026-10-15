import { HttpError } from '../auth.ts';
import type { Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * Victron VRM connector (vrmapi.victronenergy.com, API v2): the solar and battery systems that
 * power the POPs. Read only, with a personal access token of a VRM user (header
 * `x-authorization: Token …`; the old Bearer tokens stop working in 2026). The token is sealed
 * with the master key and never leaves the server; installers never see this data source.
 * VRM allows about 3 requests a second: one call lists every installation with its alarms.
 */

export const VRM_URL = 'https://vrmapi.victronenergy.com/v2';

/** One VRM installation as the connector keeps it (no owner, phone or e-mail). */
export interface VrmInstallation {
  idSite: number;
  name: string;
  identifier: string;
  /** Unix seconds of the last data received; null when VRM has none. */
  lastTimestamp: number | null;
  alarm: boolean;
  numAlarms: number;
}

/** Installations whose last data is older than this are reported as silent by the test. */
export const VRM_SILENT_SECONDS = 3600;

export interface VrmClientOptions {
  token: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export function createVrmClient(opts: VrmClientOptions) {
  const base = (opts.baseUrl ?? VRM_URL).replace(/\/+$/, '');
  const f = opts.fetchImpl ?? fetch;

  /** One GET; errors carry vrm_unreachable / vrm_auth_failed / vrm_forbidden / vrm_rate_limited / vrm_error. */
  async function get(path: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    let r: Response;
    try {
      r = await f(`${base}${path}`, {
        headers: { 'x-authorization': `Token ${opts.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new HttpError(502, 'vrm_unreachable', { detail: (e as Error).message.slice(0, 200) });
    }
    const text = await r.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      /* not JSON: reported below */
    }
    const errors = json?.errors;
    const detail = (Array.isArray(errors) ? errors.join(' ') : String(errors ?? json?.error_code ?? '')).slice(0, 200);
    if (r.status === 401) throw new HttpError(502, 'vrm_auth_failed', { status: 401, detail });
    if (r.status === 403) throw new HttpError(502, 'vrm_forbidden', { status: 403, detail });
    if (r.status === 429) throw new HttpError(502, 'vrm_rate_limited', { status: 429, retryAfter: r.headers.get('retry-after') });
    if (!r.ok || !json || json.success === false) throw new HttpError(502, 'vrm_error', { status: r.status, path: path.split('?')[0], detail: detail || text.slice(0, 200) });
    return json;
  }

  /** The VRM user of the token: its id is needed to list the installations. */
  async function me(): Promise<{ id: number; name: string }> {
    const j = await get('/users/me');
    const u = (j.user ?? {}) as { id?: unknown; name?: unknown };
    const id = Number(u.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(502, 'vrm_error', { detail: 'utente VRM non riconosciuto' });
    return { id, name: String(u.name ?? '') };
  }

  /** Every installation the user can see, with active alarms and the time of the last data. */
  async function installations(userId: number): Promise<VrmInstallation[]> {
    const j = await get(`/users/${userId}/installations?extended=1`, 30_000);
    const records = Array.isArray(j.records) ? (j.records as Array<Record<string, unknown>>) : [];
    return records
      .map((r) => ({
        idSite: Number(r.idSite),
        name: String(r.name ?? '').slice(0, 120),
        identifier: String(r.identifier ?? '').slice(0, 64),
        lastTimestamp: Number(r.last_timestamp) > 0 ? Number(r.last_timestamp) : null,
        alarm: r.alarm === true || Number(r.num_alarms) > 0,
        numAlarms: Number(r.num_alarms) > 0 ? Number(r.num_alarms) : 0,
      }))
      .filter((i) => Number.isInteger(i.idSite) && i.idSite > 0);
  }

  /**
   * Connection test: the token's user and the installations it sees, as counts (with active
   * alarms, silent for over an hour). Nothing is written to VRM.
   */
  async function test(now = Date.now()) {
    const started = Date.now();
    try {
      const u = await me();
      const list = await installations(u.id);
      const silent = list.filter((i) => i.lastTimestamp === null || now / 1000 - i.lastTimestamp > VRM_SILENT_SECONDS).length;
      return {
        ok: true,
        latencyMs: Date.now() - started,
        user: u.name,
        installations: list.length,
        withAlarms: list.filter((i) => i.alarm).length,
        silent,
      };
    } catch (e) {
      const err = e as HttpError;
      if (!err.code?.startsWith('vrm_')) throw e;
      return { ok: false, error: err.code, status: (err.extra?.status as number | undefined) ?? null, detail: String(err.extra?.detail ?? '').slice(0, 200) };
    }
  }

  return { get, me, installations, test };
}
export type VrmClient = ReturnType<typeof createVrmClient>;

// ---- Settings (console only, no .env) -----------------------------------------------------------

interface Stored {
  enabled: boolean;
  tokenSealed: string;
}

export interface VrmView {
  configured: boolean;
  enabled: boolean;
  tokenSet: boolean;
  tokenHint: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

const KEY = 'connector.victron';

export function createVrmSettings(db: Db, sealer: Sealer, opts: { fetchImpl?: typeof fetch | undefined; baseUrl?: string | undefined } = {}) {
  const read = () => {
    const r = db
      .prepare('SELECT s.value, s.updated_at, u.username FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?')
      .get(KEY) as { value: string; updated_at: string; username: string | null } | undefined;
    return r ? { stored: JSON.parse(r.value) as Stored, updatedAt: r.updated_at, updatedBy: r.username } : null;
  };

  const build = (token: string) => createVrmClient({ token, baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });

  return {
    build,

    /** The client of the saved configuration, or null when not configured or switched off. */
    client(): VrmClient | null {
      const c = read()?.stored;
      if (!c?.enabled || !c.tokenSealed) return null;
      return build(sealer.open(c.tokenSealed));
    },

    savedToken(): string | null {
      const c = read()?.stored;
      return c?.tokenSealed ? sealer.open(c.tokenSealed) : null;
    },

    /** Public view: never contains the token. */
    view(): VrmView {
      const c = read();
      const token = c?.stored.tokenSealed ? sealer.open(c.stored.tokenSealed) : '';
      return {
        configured: !!token,
        enabled: c?.stored.enabled ?? false,
        tokenSet: !!token,
        tokenHint: token ? `…${token.slice(-4)}` : '',
        updatedAt: c?.updatedAt ?? null,
        updatedBy: c?.updatedBy ?? null,
      };
    },

    /** An empty token keeps the saved one. */
    save(input: { enabled: boolean; token?: string | undefined }, userId: number) {
      const prev = read()?.stored;
      const tokenSealed = input.token ? sealer.seal(input.token) : (prev?.tokenSealed ?? '');
      if (input.enabled && !tokenSealed) throw new HttpError(400, 'vrm_incomplete');
      const stored: Stored = { enabled: input.enabled, tokenSealed };
      db.prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(KEY, JSON.stringify(stored), nowIso(), userId);
    },

    reset() {
      db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
    },
  };
}
export type VrmSettings = ReturnType<typeof createVrmSettings>;
