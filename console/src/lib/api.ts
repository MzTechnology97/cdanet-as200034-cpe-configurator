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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const api = legacyApi as <T = any>(path: string, opts?: ApiOptions) => Promise<T>;

export interface StoredSession {
  token: string;
  user: { id: number; username: string; role: string };
  expiresAt: string;
}

export const session = legacySession as { get(): StoredSession | null; set(s: StoredSession): void; clear(): void };
