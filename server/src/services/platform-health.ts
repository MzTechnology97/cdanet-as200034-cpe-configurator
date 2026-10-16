import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { HttpError } from '../auth.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * «Salute piattaforma»: how each source the server reads is doing (when it last worked, the last
 * error, whether it is late), the server itself (database, disk, backups), an alert to the NOC
 * when a source stops or comes back, and the encrypted backup of the database, downloaded by an
 * admin (and checked again on upload, without replacing anything).
 */

export type HealthState = 'ok' | 'warn' | 'bad' | 'off';
export interface SourceHealth {
  id: string;
  label: string;
  state: HealthState;
  /** The last time it worked (ISO). */
  at: string | null;
  error: string | null;
  /** How often it is read, and after how long without news it is late (minutes). */
  everyMin: number;
  lateMin: number;
  detail?: string;
}
export interface SourceProbe {
  id: string;
  label: string;
  everyMin: number;
  /** After how long without news it is late (minutes); three missed readings when not given. */
  lateMin?: number;
  /** null = not configured (no alert). */
  read: () => { at: string | null; error: string | null; detail?: string } | null;
}

const MIN = 60_000;
/** Late after three missed readings (and never before 30 minutes). */
const late = (everyMin: number) => Math.max(30, everyMin * 3);

/** The state of a source from its last reading (pure). */
export function sourceState(r: { at: string | null; error: string | null } | null, everyMin: number, now = Date.now(), lateMin = late(everyMin)): HealthState {
  if (!r) return 'off';
  if (r.error) return 'bad';
  if (!r.at || now - Date.parse(r.at) > lateMin * MIN) return 'warn';
  return 'ok';
}

// ---- encrypted backup ---------------------------------------------------------------------------

const MAGIC = Buffer.from('CDANETBK1\n');
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * The file: «CDANETBK1\n», a JSON line (what it is, never secret), then salt, IV, GCM tag and the
 * ciphertext of [4 bytes: key length][master key or nothing][database, gzip]. AES-256-GCM with a
 * key from the password (scrypt): without the password the file is useless.
 */
export function sealBackup(database: Buffer, password: string, meta: Record<string, unknown>, masterKey: Buffer | null): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, KDF);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(masterKey ? masterKey.length : 0);
  const plain = Buffer.concat([len, masterKey ?? Buffer.alloc(0), gzipSync(database)]);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from(`${JSON.stringify({ ...meta, includesKey: !!masterKey })}\n`), salt, iv, c.getAuthTag(), body]);
}

export function openBackup(file: Buffer, password: string): { meta: Record<string, unknown>; database: Buffer; masterKey: Buffer | null } {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new HttpError(400, 'backup_invalid');
  const nl = file.indexOf(10, MAGIC.length);
  if (nl < 0) throw new HttpError(400, 'backup_invalid');
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(file.subarray(MAGIC.length, nl).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'backup_invalid');
  }
  const at = nl + 1;
  const salt = file.subarray(at, at + 16);
  const iv = file.subarray(at + 16, at + 28);
  const tag = file.subarray(at + 28, at + 44);
  const body = file.subarray(at + 44);
  let plain: Buffer;
  try {
    const d = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32, KDF), iv);
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(body), d.final()]);
  } catch {
    // a wrong password and a damaged file look the same to GCM
    throw new HttpError(400, 'backup_wrong_password');
  }
  const len = plain.readUInt32BE(0);
  return { meta, masterKey: len ? plain.subarray(4, 4 + len) : null, database: gunzipSync(plain.subarray(4 + len)) };
}

/** A copy of the database taken while it is in use (VACUUM INTO), as bytes. */
export function snapshot(db: Db): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'cdanet-bk-'));
  const file = join(dir, 'snapshot.sqlite');
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Is it a sound database of ours? integrity check and what it holds, on a temporary copy. */
export function inspectDatabase(database: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'cdanet-ck-'));
  const file = join(dir, 'check.sqlite');
  try {
    writeFileSync(file, database);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      const schema = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      const count = (t: string) => (has(t) ? (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n : null);
      return {
        ok: integrity === 'ok' && has('users'),
        integrity,
        schema,
        counts: { users: count('users'), installations: count('provisioning_jobs'), workOrders: count('work_orders'), acceptanceTests: count('job_acceptance'), events: count('events') },
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the service -------------------------------------------------------------------------------

export function createPlatformHealth(
  db: Db,
  opts: { dbPath: string; version: string; probes: () => SourceProbe[]; alert: (ok: boolean, title: string, lines: string[]) => void; log?: (m: string) => void; minFreeBytes?: number },
) {
  const started = Date.now();
  const last = new Map<string, HealthState>();
  let timer: NodeJS.Timeout | null = null;
  const minFree = opts.minFreeBytes ?? 2 * 1024 ** 3;

  const fileSize = (f: string) => (existsSync(f) ? statSync(f).size : 0);
  function server() {
    const dir = dirname(opts.dbPath);
    let free: number | null = null;
    try {
      const s = statfsSync(existsSync(dir) ? dir : '.');
      free = s.bavail * s.bsize;
    } catch {
      free = null;
    }
    // the copies the updater makes before every update (data/backups)
    const bdir = join(dir, 'backups');
    const local = existsSync(bdir) ? readdirSync(bdir).filter((f) => f.endsWith('.sqlite')).sort() : [];
    const lastLocal = local.at(-1);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'platform.backup.last'").get() as { value: string } | undefined;
    return {
      version: opts.version,
      uptimeS: Math.round((Date.now() - started) / 1000),
      dbBytes: fileSize(opts.dbPath) + fileSize(`${opts.dbPath}-wal`),
      diskFreeBytes: free,
      diskLow: free !== null && free < minFree,
      localBackups: { count: local.length, last: lastLocal ? statSync(join(bdir, lastLocal)).mtime.toISOString() : null },
      lastDownload: row ? (JSON.parse(row.value) as { at: string; by: string; bytes: number }) : null,
    };
  }

  function sources(now = Date.now()): SourceHealth[] {
    return opts.probes().map((p) => {
      let r: ReturnType<SourceProbe['read']>;
      try {
        r = p.read();
      } catch (e) {
        r = { at: null, error: (e as Error).message };
      }
      const lateMin = p.lateMin ?? late(p.everyMin);
      return { id: p.id, label: p.label, state: sourceState(r, p.everyMin, now, lateMin), at: r?.at ?? null, error: r?.error ?? null, everyMin: p.everyMin, lateMin, ...(r?.detail ? { detail: r.detail } : {}) };
    });
  }

  /** The NOC hears when a source stops working or comes back, once per change. */
  function check(now = Date.now()) {
    const list = sources(now);
    const s = server();
    const all: Array<{ id: string; label: string; state: HealthState; why: string }> = [
      ...list.map((x) => ({ id: x.id, label: x.label, state: x.state, why: x.error ? `errore: ${x.error}` : x.at ? `nessun dato da ${Math.round((now - Date.parse(x.at)) / MIN)} minuti` : 'mai letto' })),
      { id: 'disk', label: 'Spazio su disco', state: (s.diskLow ? 'bad' : 'ok') as HealthState, why: s.diskFreeBytes !== null ? `liberi ${(s.diskFreeBytes / 1024 ** 3).toFixed(1)} GB` : '' },
    ];
    for (const x of all) {
      const before = last.get(x.id);
      last.set(x.id, x.state);
      if (x.state === 'off' || before === undefined || before === 'off') continue;
      const badNow = x.state === 'bad' || x.state === 'warn';
      const badBefore = before === 'bad' || before === 'warn';
      if (badNow && !badBefore) opts.alert(false, `${x.label}: ${x.state === 'bad' ? 'non funziona' : 'in ritardo'}`, [x.why]);
      else if (!badNow && badBefore) opts.alert(true, `${x.label}: di nuovo regolare`, []);
    }
    return list;
  }

  return {
    server,
    sources,
    check,
    view: () => ({ generatedAt: nowIso(), server: server(), sources: sources() }),
    /** The encrypted copy of the database for an admin's download. */
    backup(password: string, by: string, includeKey: Buffer | null) {
      const database = snapshot(db);
      const file = sealBackup(database, password, { format: 'cdanet-backup', version: opts.version, createdAt: nowIso(), dbBytes: database.length }, includeKey);
      db.prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES('platform.backup.last', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(JSON.stringify({ at: nowIso(), by, bytes: file.length }), nowIso());
      return file;
    },
    verify(file: Buffer, password: string) {
      const b = openBackup(file, password);
      return { meta: b.meta, includesKey: !!b.masterKey, dbBytes: b.database.length, ...inspectDatabase(b.database) };
    },
    start(everyMs = 5 * MIN) {
      if (timer) return;
      // the first reading only learns the states: no alert for what was already down at start
      setTimeout(() => {
        try {
          check();
        } catch (e) {
          opts.log?.(`health: ${(e as Error).message}`);
        }
      }, 60_000).unref();
      timer = setInterval(() => {
        try {
          check();
        } catch (e) {
          opts.log?.(`health: ${(e as Error).message}`);
        }
      }, everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
export type PlatformHealth = ReturnType<typeof createPlatformHealth>;
