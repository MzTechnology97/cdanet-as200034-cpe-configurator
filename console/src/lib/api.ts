import { api as legacyApi, session as legacySession } from '../../../web/js/api.js';

/**
 * The API client of the console (web/js/api.js: token, errors in Italian, session expiry), with
 * its types: the converted pages call the server through this.
 */
export interface ApiOptions {
  method?: string;
  body?: unknown;
  raw?: boolean;
  headers?: Record<string, string>;
}

const call = legacyApi as <T>(path: string, opts?: ApiOptions) => Promise<T>;

/**
 * An admin without two-step verification, when it is required, may only set it up: every other
 * request is refused with mfa_setup_required, and the console takes them to Il mio account.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, opts?: ApiOptions): Promise<T> {
  try {
    return await call<T>(path, opts);
  } catch (e) {
    if ((e as { body?: { error?: string } }).body?.error === 'mfa_setup_required' && !location.hash.startsWith('#/account')) location.hash = '#/account';
    throw e;
  }
}

export interface StoredSession {
  token: string;
  user: { id: number; username: string; role: string };
  expiresAt: string;
}

export const session = legacySession as { get(): StoredSession | null; set(s: StoredSession): void; clear(): void };
