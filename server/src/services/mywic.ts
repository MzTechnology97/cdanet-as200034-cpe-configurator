import { HttpError } from '../auth.ts';
import type { Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * Multi-operator coverage connector: the MyWic coverage platform (coverage.mywic.it, API v1).
 * FTTH, FTTC/FTTx and the radio networks (Eolo FWA) of the operators enabled on the account,
 * read with an API token generated in the MyWic dashboard (Authorization: Bearer …). Read only;
 * the token is sealed with the master key and never leaves the server.
 */

export const MYWIC_URL = 'https://coverage.mywic.it/api/v1';

export interface MyWicClientOptions {
  token: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export function createMyWicClient(opts: MyWicClientOptions) {
  const base = (opts.baseUrl ?? MYWIC_URL).replace(/\/+$/, '');
  const f = opts.fetchImpl ?? fetch;

  /** One GET; errors carry mywic_unreachable / mywic_auth_failed / mywic_forbidden / mywic_rate_limited / mywic_error. */
  async function get(path: string, timeoutMs = 20_000): Promise<unknown> {
    let r: Response;
    try {
      r = await f(`${base}${path}`, { headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new HttpError(502, 'mywic_unreachable', { detail: (e as Error).message.slice(0, 200) });
    }
    const text = await r.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: reported below */
    }
    const detail = String((json as { message?: unknown } | null)?.message ?? '').slice(0, 200);
    if (r.status === 401) throw new HttpError(502, 'mywic_auth_failed', { status: 401, detail });
    if (r.status === 403) throw new HttpError(502, 'mywic_forbidden', { status: 403, detail });
    if (r.status === 429) throw new HttpError(502, 'mywic_rate_limited', { status: 429, retryAfter: r.headers.get('retry-after') });
    if (!r.ok || json === null) throw new HttpError(502, 'mywic_error', { status: r.status, path: path.split('?')[0], detail: detail || text.slice(0, 200) });
    return json;
  }

  /** The operators and technologies enabled on the account: [{ name, technology }]. */
  async function providers(): Promise<Array<{ name: string; technology: string }>> {
    const j = await get('/coverage/providers');
    const list = Array.isArray(j) ? j : Array.isArray((j as { data?: unknown })?.data) ? ((j as { data: unknown[] }).data as unknown[]) : [];
    return list
      .map((p) => ({ name: String((p as { name?: unknown }).name ?? ''), technology: String((p as { technology?: unknown }).technology ?? '') }))
      .filter((p) => p.name);
  }

  /** Connection test: the operators and technologies the token can check. Nothing is written. */
  async function test() {
    const started = Date.now();
    try {
      const list = await providers();
      const byProvider = new Map<string, Set<string>>();
      for (const p of list) byProvider.set(p.name, (byProvider.get(p.name) ?? new Set()).add(p.technology));
      return {
        ok: true,
        latencyMs: Date.now() - started,
        providers: [...byProvider].map(([name, techs]) => ({ name, technologies: [...techs].filter(Boolean).sort() })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch (e) {
      const err = e as HttpError;
      if (!err.code?.startsWith('mywic_')) throw e;
      return { ok: false, error: err.code, status: (err.extra?.status as number | undefined) ?? null, detail: String(err.extra?.detail ?? '').slice(0, 200) };
    }
  }

  return { get, providers, test };
}
export type MyWicClient = ReturnType<typeof createMyWicClient>;

// ---- Settings (console only, no .env) -----------------------------------------------------------

interface Stored {
  enabled: boolean;
  tokenSealed: string;
}

export interface MyWicView {
  configured: boolean;
  enabled: boolean;
  tokenSet: boolean;
  tokenHint: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

const KEY = 'connector.mywic';

export function createMyWicSettings(db: Db, sealer: Sealer, opts: { fetchImpl?: typeof fetch | undefined; baseUrl?: string | undefined } = {}) {
  const read = () => {
    const r = db
      .prepare('SELECT s.value, s.updated_at, u.username FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?')
      .get(KEY) as { value: string; updated_at: string; username: string | null } | undefined;
    return r ? { stored: JSON.parse(r.value) as Stored, updatedAt: r.updated_at, updatedBy: r.username } : null;
  };

  const build = (token: string) => createMyWicClient({ token, baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });

  return {
    build,

    /** The client of the saved configuration, or null when not configured or switched off. */
    client(): MyWicClient | null {
      const c = read()?.stored;
      if (!c?.enabled || !c.tokenSealed) return null;
      return build(sealer.open(c.tokenSealed));
    },

    savedToken(): string | null {
      const c = read()?.stored;
      return c?.tokenSealed ? sealer.open(c.tokenSealed) : null;
    },

    /** Public view: never contains the token. */
    view(): MyWicView {
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
      if (input.enabled && !tokenSealed) throw new HttpError(400, 'mywic_incomplete');
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
export type MyWicSettings = ReturnType<typeof createMyWicSettings>;
