import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * Push notifications to the app through Firebase Cloud Messaging (HTTP v1), configured from
 * Connettori → Firebase: the service account (its private key sealed with the master key) and the
 * Android apps of google-services.json. Without it the app stays connected to /api/events itself.
 * The phones register their FCM token after login; a token FCM no longer knows is dropped.
 */

interface Stored {
  enabled: boolean;
  projectId: string;
  projectNumber: string;
  clientEmail: string;
  privateKeySealed: string;
  apps: Array<{ packageName: string; appId: string; apiKey: string }>;
}

export interface FirebaseView {
  configured: boolean;
  enabled: boolean;
  projectId: string;
  clientEmail: string;
  apps: string[];
  devices: number;
  updatedAt: string | null;
}

/** What the app needs to start Firebase (all public values of google-services.json). */
export interface FirebaseClient {
  projectId: string;
  senderId: string;
  appId: string;
  apiKey: string;
}

const serviceAccount = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1).max(100),
  client_email: z.string().email().max(200),
  private_key: z.string().includes('PRIVATE KEY').max(4000),
});

const googleServices = z.object({
  project_info: z.object({ project_id: z.string(), project_number: z.string() }),
  client: z
    .array(
      z.object({
        client_info: z.object({ mobilesdk_app_id: z.string(), android_client_info: z.object({ package_name: z.string() }) }),
        api_key: z.array(z.object({ current_key: z.string() })).min(1),
      }),
    )
    .min(1),
});

const KEY = 'connector.firebase';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export function createPush(db: Db, sealer: Sealer, opts: { fetchImpl?: typeof fetch | undefined; log?: (m: string) => void } = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  let access: { token: string; until: number } | null = null;

  const read = () => {
    const r = db.prepare('SELECT value, updated_at FROM settings WHERE key = ?').get(KEY) as { value: string; updated_at: string } | undefined;
    return r ? { stored: JSON.parse(r.value) as Stored, updatedAt: r.updated_at } : null;
  };
  const active = () => {
    const s = read()?.stored;
    return s && s.enabled && s.privateKeySealed ? s : null;
  };

  function view(): FirebaseView {
    const r = read();
    const devices = (db.prepare('SELECT count(*) n FROM push_tokens').get() as { n: number }).n;
    return {
      configured: !!r,
      enabled: !!r?.stored.enabled,
      projectId: r?.stored.projectId ?? '',
      clientEmail: r?.stored.clientEmail ?? '',
      apps: r?.stored.apps.map((a) => a.packageName) ?? [],
      devices,
      updatedAt: r?.updatedAt ?? null,
    };
  }

  /**
   * Saves the connector from the two files of the Firebase project, pasted in the console: the
   * service account (secret, sealed) and google-services.json (public). Either may be left out
   * to keep the saved one.
   */
  function save(input: { enabled: boolean; serviceAccount?: string | undefined; googleServices?: string | undefined }, userId: number) {
    const prev = read()?.stored;
    let next: Stored = prev ?? { enabled: false, projectId: '', projectNumber: '', clientEmail: '', privateKeySealed: '', apps: [] };
    if (input.serviceAccount) {
      const sa = serviceAccount.safeParse(parseJson(input.serviceAccount));
      if (!sa.success) throw new HttpError(400, 'firebase_service_account_invalid');
      next = { ...next, projectId: sa.data.project_id, clientEmail: sa.data.client_email, privateKeySealed: sealer.seal(sa.data.private_key) };
    }
    if (input.googleServices) {
      const gs = googleServices.safeParse(parseJson(input.googleServices));
      if (!gs.success) throw new HttpError(400, 'firebase_google_services_invalid');
      if (next.projectId && gs.data.project_info.project_id !== next.projectId) throw new HttpError(400, 'firebase_project_mismatch');
      next = {
        ...next,
        projectId: gs.data.project_info.project_id,
        projectNumber: gs.data.project_info.project_number,
        apps: gs.data.client.map((c) => ({ packageName: c.client_info.android_client_info.package_name, appId: c.client_info.mobilesdk_app_id, apiKey: c.api_key[0]!.current_key })),
      };
    }
    if (input.enabled && (!next.privateKeySealed || !next.apps.length)) throw new HttpError(400, 'firebase_incomplete');
    next.enabled = input.enabled;
    db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(KEY, JSON.stringify(next), nowIso(), userId);
    access = null;
    return view();
  }

  function remove() {
    db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
    access = null;
  }

  /** The Firebase options of the app [packageName]; null when push is not configured (the app then stays connected itself). */
  function client(packageName: string): FirebaseClient | null {
    const s = active();
    const a = s?.apps.find((x) => x.packageName === packageName);
    return s && a ? { projectId: s.projectId, senderId: s.projectNumber, appId: a.appId, apiKey: a.apiKey } : null;
  }

  function register(userId: number, token: string) {
    const now = nowIso();
    db.prepare(
      `INSERT INTO push_tokens(token, user_id, created_at, last_seen_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, last_seen_at = excluded.last_seen_at`,
    ).run(token, userId, now, now);
  }

  function unregister(token: string) {
    db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
  }

  async function accessToken(s: Stored): Promise<string> {
    if (access && access.until > Date.now() + 60_000) return access.token;
    const key = await importPKCS8(sealer.open(s.privateKeySealed), 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(s.clientEmail)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const r = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!r.ok) throw new Error(`token Google HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    access = { token: j.access_token, until: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  /** One notification to every phone of the users (best effort: never throws). Returns the messages FCM accepted. */
  async function send(userIds: number[], n: { title: string; body: string; kind: string }): Promise<number> {
    const s = active();
    if (!s || !userIds.length) return 0;
    const rows = db.prepare(`SELECT token FROM push_tokens WHERE user_id IN (${userIds.map(() => '?').join(',')})`).all(...userIds) as Array<{ token: string }>;
    if (!rows.length) return 0;
    let sent = 0;
    try {
      const bearer = await accessToken(s);
      for (const { token } of rows) {
        const r = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(s.projectId)}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              // data only: the app always shows it itself (no duplicate with its own feed check)
              data: { kind: n.kind, title: n.title, body: n.body.slice(0, 900) },
              android: { priority: 'HIGH' },
            },
          }),
        });
        if (r.ok) {
          sent++;
          continue;
        }
        const why = await r.text().catch(() => '');
        // the app was removed or the token renewed: FCM will not deliver to it again
        if (r.status === 404 || (r.status === 400 && /registration token|UNREGISTERED/i.test(why))) unregister(token);
        else log(`fcm HTTP ${r.status}: ${why.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    } catch (err) {
      log(`fcm: ${(err as Error).message}`);
    }
    return sent;
  }

  return { view, save, remove, client, register, unregister, send, enabled: () => !!active() };
}
export type Push = ReturnType<typeof createPush>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
