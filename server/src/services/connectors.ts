import { Agent, fetch as undiciFetch } from 'undici';
import { HttpError } from '../auth.ts';
import type { Config } from '../config.ts';
import type { Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';
import { createUisp, type Uisp } from './uisp.ts';

/**
 * External connectors configured from the admin console (stored in the DB, secrets
 * sealed with the master key). When a connector has no console configuration the
 * .env values are used, so existing deployments keep working.
 */

export interface UispSettings {
  url: string;
  token: string;
  ignoreTls: boolean;
  cacheSeconds: number;
  autoBackup: boolean;
  coverageMaxKm: number;
}

export interface UispView {
  source: 'console' | 'env' | 'none';
  enabled: boolean;
  url: string;
  tokenSet: boolean;
  tokenHint: string;
  ignoreTls: boolean;
  cacheSeconds: number;
  autoBackup: boolean;
  coverageMaxKm: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface Stored {
  enabled: boolean;
  url: string;
  tokenSealed: string;
  ignoreTls: boolean;
  cacheSeconds: number;
  autoBackup: boolean;
  coverageMaxKm: number;
}

/** fetch that skips certificate verification (self-signed UISP). Only used when explicitly enabled. */
let insecureAgent: Agent | null = null;
export function insecureFetch(): typeof fetch {
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  const agent = insecureAgent;
  return ((input: string | URL, init?: RequestInit) =>
    undiciFetch(input as string, { ...(init as object), dispatcher: agent } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;
}

export function createConnectors(db: Db, sealer: Sealer, cfg: Config, opts: { fetchImpl?: typeof fetch | undefined } = {}) {
  const read = () => {
    const r = db
      .prepare('SELECT s.value, s.updated_at, u.username FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?')
      .get('connector.uisp') as { value: string; updated_at: string; username: string | null } | undefined;
    return r ? { stored: JSON.parse(r.value) as Stored, updatedAt: r.updated_at, updatedBy: r.username } : null;
  };

  /** Effective UISP settings: console configuration, else .env, else disabled. */
  function uispSettings(): (UispSettings & { source: 'console' | 'env' }) | null {
    const c = read();
    if (c) {
      if (!c.stored.enabled || !c.stored.url || !c.stored.tokenSealed) return null;
      return {
        source: 'console',
        url: c.stored.url,
        token: sealer.open(c.stored.tokenSealed),
        ignoreTls: c.stored.ignoreTls,
        cacheSeconds: c.stored.cacheSeconds,
        autoBackup: c.stored.autoBackup,
        coverageMaxKm: c.stored.coverageMaxKm,
      };
    }
    if (cfg.uisp) {
      return { source: 'env', url: cfg.uisp.url, token: cfg.uisp.token, ignoreTls: cfg.uispIgnoreTls, cacheSeconds: cfg.uisp.cacheSeconds, autoBackup: cfg.uispAutoBackup, coverageMaxKm: cfg.coverageMaxKm };
    }
    return null;
  }

  function build(s: Pick<UispSettings, 'url' | 'token' | 'ignoreTls' | 'cacheSeconds'>): Uisp {
    return createUisp({ url: s.url, token: s.token, cacheSeconds: s.cacheSeconds, fetchImpl: s.ignoreTls ? insecureFetch() : opts.fetchImpl });
  }

  return {
    uispSettings,
    build,

    /** Public view: never contains the token. */
    uispView(): UispView {
      const c = read();
      if (c) {
        const token = c.stored.tokenSealed ? sealer.open(c.stored.tokenSealed) : '';
        return {
          source: 'console',
          enabled: c.stored.enabled,
          url: c.stored.url,
          tokenSet: !!token,
          tokenHint: token ? `…${token.slice(-4)}` : '',
          ignoreTls: c.stored.ignoreTls,
          cacheSeconds: c.stored.cacheSeconds,
          autoBackup: c.stored.autoBackup,
          coverageMaxKm: c.stored.coverageMaxKm,
          updatedAt: c.updatedAt,
          updatedBy: c.updatedBy,
        };
      }
      return {
        source: cfg.uisp ? 'env' : 'none',
        enabled: !!cfg.uisp,
        url: cfg.uisp?.url ?? '',
        tokenSet: !!cfg.uisp?.token,
        tokenHint: cfg.uisp?.token ? `…${cfg.uisp.token.slice(-4)}` : '',
        ignoreTls: cfg.uispIgnoreTls,
        cacheSeconds: cfg.uisp?.cacheSeconds ?? 60,
        autoBackup: cfg.uispAutoBackup,
        coverageMaxKm: cfg.coverageMaxKm,
        updatedAt: null,
        updatedBy: null,
      };
    },

    saveUisp(input: Omit<Stored, 'tokenSealed'> & { token?: string | undefined }, userId: number | null) {
      const prev = read()?.stored;
      // Keep the existing token when the form leaves it empty (it is never sent to the browser).
      const tokenSealed = input.token ? sealer.seal(input.token) : (prev?.tokenSealed ?? (cfg.uisp?.token ? sealer.seal(cfg.uisp.token) : ''));
      if (input.enabled && (!input.url || !tokenSealed)) throw new HttpError(400, 'connector_incomplete');
      const stored: Stored = {
        enabled: input.enabled,
        url: input.url.replace(/\/+$/, ''),
        tokenSealed,
        ignoreTls: input.ignoreTls,
        cacheSeconds: input.cacheSeconds,
        autoBackup: input.autoBackup,
        coverageMaxKm: input.coverageMaxKm,
      };
      db.prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES('connector.uisp', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(JSON.stringify(stored), nowIso(), userId);
    },

    resetUisp() {
      db.prepare("DELETE FROM settings WHERE key = 'connector.uisp'").run();
    },

    /** Token of the saved configuration, to test a form that left the token field empty. */
    savedUispToken(): string | null {
      return uispSettings()?.token ?? (read()?.stored.tokenSealed ? sealer.open(read()!.stored.tokenSealed) : null);
    },
  };
}
export type Connectors = ReturnType<typeof createConnectors>;
