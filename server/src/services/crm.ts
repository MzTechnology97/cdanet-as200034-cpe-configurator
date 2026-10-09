import { HttpError } from '../auth.ts';
import type { Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * CRM connector: ISP Billing (ispbilling.it) API. Customers, ISPRadius 2.0 accounts and
 * profiles, subscription services, activities and warehouse, read with an API key
 * (Authorization: Bearer {api_id}:{api_key}). The key is sealed with the master key and
 * never leaves the server; installers never see this data source.
 */

export const CRM_DEFAULT_URL = 'https://ispbilling.it';

/** Modules the integration uses, probed one by one by the test (the key has per-module permissions). */
export const CRM_MODULES = [
  { key: 'customers', label: 'Clienti', path: '/api/modules/crm/customers?page=1' },
  { key: 'radius_accounts', label: 'ISPRadius 2.0 · Account', path: '/api/modules/ispradius2/accounts?page=1' },
  { key: 'radius_profiles', label: 'ISPRadius 2.0 · Profili', path: '/api/modules/ispradius2/profiles?page=1' },
  { key: 'services', label: 'Servizi', path: '/api/modules/subscription-services/services' },
  { key: 'service_instances', label: 'Istanze servizi', path: '/api/modules/subscription-services/service-instances?page=1' },
  { key: 'activities', label: 'Attività', path: '/api/modules/activities/activities' },
  { key: 'teams', label: 'Attività · Team', path: '/api/modules/activities/teams' },
  { key: 'warehouse', label: 'Magazzino · Articoli', path: '/api/modules/warehouse/articles?page=1' },
] as const;

export interface CrmClientOptions {
  url: string;
  apiId: string;
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
}

export function createCrmClient(opts: CrmClientOptions) {
  const base = opts.url.replace(/\/+$/, '');
  const f = opts.fetchImpl ?? fetch;

  /** One API call; errors carry crm_unreachable / crm_auth_failed / crm_forbidden / crm_error. */
  async function call(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20_000): Promise<unknown> {
    let r: Response;
    try {
      r = await f(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.apiId}:${opts.apiKey}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new HttpError(502, 'crm_unreachable', { detail: (e as Error).message.slice(0, 200) });
    }
    const text = await r.text().catch(() => '');
    let json: { status?: string; message?: string | null; data?: unknown } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: reported below */
    }
    const message = String(json?.message ?? '').slice(0, 200);
    if (r.status === 401) throw new HttpError(502, 'crm_auth_failed', { status: 401, detail: message });
    // 403: missing permission for the module, or the server's IP not in the key's whitelist
    if (r.status === 403) throw new HttpError(502, 'crm_forbidden', { status: 403, detail: message });
    if (!r.ok || !json || json.status === 'ERROR') {
      throw new HttpError(502, 'crm_error', { status: r.status, path: path.split('?')[0], detail: message || text.slice(0, 200) });
    }
    return json.data;
  }

  /** Records in a page (offset pagination: { data, total }; cursor pagination: array or { data }). */
  const countOf = (data: unknown): number | null => {
    if (Array.isArray(data)) return data.length;
    const d = data as { total?: unknown; data?: unknown } | null;
    if (d && typeof d.total === 'number') return d.total;
    if (d && Array.isArray(d.data)) return d.data.length;
    return null;
  };

  /**
   * Connection test: every module the integration uses, one read each. The key is valid when at
   * least one module answers; the others are listed with what is missing (permission or whitelist).
   */
  async function test() {
    const started = Date.now();
    const modules: Array<{ key: string; label: string; ok: boolean; count: number | null; error?: string; status?: number | null }> = [];
    for (const m of CRM_MODULES) {
      try {
        const data = await call('GET', m.path, undefined, 15_000);
        modules.push({ key: m.key, label: m.label, ok: true, count: countOf(data) });
      } catch (e) {
        const err = e as HttpError;
        // nothing else can work if the host is unreachable or the key is unknown
        if (err.code === 'crm_unreachable' || err.code === 'crm_auth_failed') {
          return { ok: false, error: err.code, status: (err.extra?.status as number | undefined) ?? null, detail: String(err.extra?.detail ?? '').slice(0, 200) };
        }
        modules.push({ key: m.key, label: m.label, ok: false, count: null, error: err.code, status: (err.extra?.status as number | undefined) ?? null });
      }
    }
    const ok = modules.some((m) => m.ok);
    return {
      ok,
      latencyMs: Date.now() - started,
      modules,
      ...(ok ? {} : { error: modules.every((m) => m.error === 'crm_forbidden') ? 'crm_forbidden' : 'crm_error' }),
    };
  }

  return { call, test };
}
export type CrmClient = ReturnType<typeof createCrmClient>;

// ---- Settings (console only, no .env) -----------------------------------------------------------

interface Stored {
  enabled: boolean;
  url: string;
  apiId: string;
  apiKeySealed: string;
}

export interface CrmView {
  configured: boolean;
  enabled: boolean;
  url: string;
  apiId: string;
  keySet: boolean;
  keyHint: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

const KEY = 'connector.crm';

export function createCrmSettings(db: Db, sealer: Sealer, opts: { fetchImpl?: typeof fetch | undefined } = {}) {
  const read = () => {
    const r = db
      .prepare('SELECT s.value, s.updated_at, u.username FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?')
      .get(KEY) as { value: string; updated_at: string; username: string | null } | undefined;
    return r ? { stored: JSON.parse(r.value) as Stored, updatedAt: r.updated_at, updatedBy: r.username } : null;
  };

  const build = (s: { url: string; apiId: string; apiKey: string }) => createCrmClient({ ...s, fetchImpl: opts.fetchImpl });

  return {
    build,

    /** The client of the saved configuration, or null when not configured or switched off. */
    client(): CrmClient | null {
      const c = read()?.stored;
      if (!c?.enabled || !c.url || !c.apiId || !c.apiKeySealed) return null;
      return build({ url: c.url, apiId: c.apiId, apiKey: sealer.open(c.apiKeySealed) });
    },

    savedKey(): string | null {
      const c = read()?.stored;
      return c?.apiKeySealed ? sealer.open(c.apiKeySealed) : null;
    },

    /** Public view: never contains the API key. */
    view(): CrmView {
      const c = read();
      const key = c?.stored.apiKeySealed ? sealer.open(c.stored.apiKeySealed) : '';
      return {
        configured: !!(c?.stored.url && c.stored.apiId && key),
        enabled: c?.stored.enabled ?? false,
        url: c?.stored.url || CRM_DEFAULT_URL,
        apiId: c?.stored.apiId ?? '',
        keySet: !!key,
        keyHint: key ? `…${key.slice(-4)}` : '',
        updatedAt: c?.updatedAt ?? null,
        updatedBy: c?.updatedBy ?? null,
      };
    },

    /** An empty key keeps the saved one. */
    save(input: { enabled: boolean; url: string; apiId: string; apiKey?: string | undefined }, userId: number) {
      const prev = read()?.stored;
      const apiKeySealed = input.apiKey ? sealer.seal(input.apiKey) : (prev?.apiKeySealed ?? '');
      if (input.enabled && (!input.url || !input.apiId || !apiKeySealed)) throw new HttpError(400, 'crm_incomplete');
      const stored: Stored = { enabled: input.enabled, url: input.url, apiId: input.apiId, apiKeySealed };
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
export type CrmSettings = ReturnType<typeof createCrmSettings>;
