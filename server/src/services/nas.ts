import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../auth.ts';
import type { Sealer } from '../crypto.ts';
import { nowIso, recordEvent, type Db } from '../db.ts';
import { inspectDatabase, openBackup, sealBackup, snapshot } from './platform-health.ts';

/**
 * Connettori → NAS: the encrypted backup of the database copied every night to a folder of a NAS
 * (SMB/CIFS: Synology, QNAP, a Windows share…), with the last copies kept and each one opened again
 * and checked (the restore test). The admin types the network path in any common form, the server
 * recognizes it (name → address, SMB port, share and folders with their real names) and the folder
 * can be chosen by browsing the NAS from the console. The SMB work is done by smbclient (Samba) in
 * the container: SMB2/SMB3, the NAS password passed in its environment, never on the command line.
 */

// ---- the network path --------------------------------------------------------------------------

export interface SmbPath {
  host: string;
  /** null: only the NAS (its shares are listed). */
  share: string | null;
  dir: string[];
}

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/;
/** Not in an SMB name, and «;» / «"» would break the commands of smbclient. */
const BAD_NAME = /[\\/:*?"<>|;\x00-\x1f\x7f]/;

/** A folder or file name as the NAS can take it (null when fine, else why not). */
export function badName(name: string): string | null {
  if (!name.trim()) return 'nome vuoto';
  if (name === '.' || name === '..') return 'nome non valido';
  if (name.length > 255) return 'nome troppo lungo';
  if (BAD_NAME.test(name)) return 'caratteri non ammessi: \\ / : * ? " < > | ;';
  if (name !== name.trim() || name.endsWith('.')) return 'niente spazi o punti alla fine';
  return null;
}

/**
 * The network path in the forms people write it: \\nas\backup\cdanet, //nas/backup/cdanet,
 * smb://nas/backup/cdanet (also with user@ or %20), nas\backup or nas/backup. A drive letter (Z:\…)
 * is refused: the server does not see the PC's mapped drives.
 */
export function parseSmbPath(input: string): SmbPath {
  let s = input.trim();
  if (/^[A-Za-z]:([\\/]|$)/.test(s)) throw new HttpError(400, 'nas_path_drive');
  const url = /^(?:smb|cifs):\/\/(.*)$/i.exec(s);
  if (url) {
    try {
      s = decodeURIComponent(url[1]!).replace(/^[^@/]*@/, '');
    } catch {
      throw new HttpError(400, 'nas_path_invalid');
    }
  }
  const parts = s
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .filter((p) => p !== '');
  const host = parts.shift()?.toLowerCase() ?? '';
  if (!host || (!HOST.test(host) && isIP(host) !== 4)) throw new HttpError(400, 'nas_path_invalid', { detail: 'nome o indirizzo del NAS non valido' });
  const share = parts.shift() ?? null;
  for (const p of share ? [share, ...parts] : []) {
    const why = badName(p);
    if (why) throw new HttpError(400, 'nas_path_invalid', { detail: `«${p}»: ${why}` });
  }
  if (share?.endsWith('$')) throw new HttpError(400, 'nas_path_invalid', { detail: 'condivisione amministrativa: usa una cartella condivisa' });
  return { host, share, dir: parts };
}

/** \\host\share\dir as Windows writes it. */
export const smbPathText = (p: SmbPath) => `\\\\${[p.host, ...(p.share ? [p.share, ...p.dir] : [])].join('\\')}`;

// ---- smbclient ---------------------------------------------------------------------------------

export interface SmbCred {
  username: string;
  password: string;
  domain: string;
}
export interface SmbEntry {
  name: string;
  dir: boolean;
  size: number;
  /** As the NAS reports it (its local time). */
  modified: string;
}
export interface SmbShare {
  name: string;
  comment: string;
}

/** What the server does on the NAS (smbclient in production, a fake in the tests). */
export interface SmbClient {
  shares(host: string, cred: SmbCred): Promise<SmbShare[]>;
  list(host: string, share: string, dir: string[], cred: SmbCred): Promise<{ entries: SmbEntry[]; freeBytes: number | null }>;
  mkdir(host: string, share: string, dir: string[], name: string, cred: SmbCred): Promise<void>;
  put(host: string, share: string, dir: string[], name: string, data: Buffer, cred: SmbCred): Promise<void>;
  get(host: string, share: string, dir: string[], name: string, cred: SmbCred): Promise<Buffer>;
  remove(host: string, share: string, dir: string[], name: string, cred: SmbCred): Promise<void>;
}

/** «  name    D   0  Wed Oct 16 10:00:00 2026» lines of smbclient's ls, and the free space under them. */
export function parseLs(out: string): { entries: SmbEntry[]; freeBytes: number | null } {
  const entries: SmbEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^ {2}(.+?)\s+([A-Z]*)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*$/.exec(line);
    if (!m || m[1] === '.' || m[1] === '..') continue;
    entries.push({ name: m[1]!, dir: m[2]!.includes('D'), size: Number(m[3]), modified: m[4]! });
  }
  const free = /(\d+) blocks of size (\d+)\. (\d+) blocks available/.exec(out);
  return { entries, freeBytes: free ? Number(free[2]) * Number(free[3]) : null };
}

/** «Disk|backup|comment» lines of smbclient -L -g: the folders shared, without the hidden ones ($). */
export function parseShares(out: string): SmbShare[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.split('|'))
    .filter((p) => p.length >= 2 && p[0] === 'Disk' && p[1] && !p[1].endsWith('$'))
    .map((p) => ({ name: p[1]!, comment: p.slice(2).join('|').trim() }));
}

const NT: Array<[RegExp, string, number]> = [
  [/LOGON_FAILURE|WRONG_PASSWORD|NO_SUCH_USER|ACCOUNT_(DISABLED|LOCKED_OUT|RESTRICTION)|PASSWORD_(EXPIRED|MUST_CHANGE)/, 'nas_auth_failed', 502],
  [/ACCESS_DENIED|NETWORK_ACCESS_DENIED|MEDIA_WRITE_PROTECTED/, 'nas_access_denied', 502],
  [/BAD_NETWORK_NAME/, 'nas_share_not_found', 404],
  [/OBJECT_(NAME|PATH)_NOT_FOUND|NOT_A_DIRECTORY|NO_SUCH_FILE|OBJECT_PATH_SYNTAX_BAD/, 'nas_path_not_found', 404],
  [/OBJECT_NAME_COLLISION/, 'nas_exists', 409],
  [/DISK_FULL|QUOTA_EXCEEDED/, 'nas_disk_full', 502],
  [/INVALID_NETWORK_RESPONSE|NOT_SUPPORTED|NETWORK_SESSION_EXPIRED/, 'nas_protocol', 502],
  [/HOST_UNREACHABLE|NETWORK_UNREACHABLE|CONNECTION_(REFUSED|RESET|DISCONNECTED|ABORTED)|IO_TIMEOUT|BAD_NETWORK_PATH|UNSUCCESSFUL|NOT_FOUND|PORT_UNREACHABLE/, 'nas_unreachable', 502],
];

/** The error of an smbclient run from its output (NT_STATUS_… codes). */
export function smbError(out: string): HttpError {
  const nt = /NT_STATUS_[A-Z_]+/.exec(out)?.[0];
  if (/protocol negotiation failed/i.test(out) && (!nt || /INVALID_NETWORK_RESPONSE|NOT_SUPPORTED|CONNECTION_RESET/.test(nt))) return new HttpError(502, 'nas_protocol', { detail: nt ?? '' });
  if (nt) {
    const hit = NT.find(([re]) => re.test(nt.slice('NT_STATUS_'.length)));
    if (hit) return new HttpError(hit[2], hit[1], { detail: nt });
  }
  const last = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  return new HttpError(502, 'nas_error', { detail: (nt ?? last).slice(0, 200) });
}

const dirArg = (dir: string[]) => `\\${dir.join('\\')}`;

export function createSmbclient(opts: { bin?: string } = {}): SmbClient {
  const bin = opts.bin ?? 'smbclient';

  /**
   * One smbclient run: errors from its exit code and from the NT_STATUS codes it prints, unless
   * [fine] says the output is what was asked anyway.
   */
  function run(args: string[], cred: SmbCred, timeoutMs = 60_000, okStatus: RegExp | null = null, fine: (stdout: string) => boolean = () => false): Promise<string> {
    const auth = cred.username ? ['-U', cred.username, ...(cred.domain ? ['-W', cred.domain] : [])] : ['-N'];
    // the password in the environment (never in argv, visible to ps); no smb.conf of the system
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', HOME: tmpdir(), ...(cred.username ? { PASSWD: cred.password } : {}) };
    return new Promise((resolve, reject) => {
      execFile(bin, ['-s', '/dev/null', '-t', '20', ...auth, ...args], { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`;
        if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return reject(new HttpError(500, 'nas_client_missing'));
        if ((err as { killed?: boolean } | null)?.killed) return reject(new HttpError(504, 'nas_timeout'));
        if (fine(stdout)) return resolve(stdout);
        const nt = /NT_STATUS_[A-Z_]+/.exec(out)?.[0];
        if (nt && !(okStatus && okStatus.test(nt))) return reject(smbError(out));
        if (err && !nt) return reject(smbError(out));
        resolve(stdout);
      });
    });
  }
  const service = (host: string, share: string) => `//${host}/${share}`;
  const inDir = (dir: string[]) => (dir.length ? ['-D', dirArg(dir)] : []);
  const withTemp = async <T>(fn: (dir: string) => Promise<T>) => {
    const d = mkdtempSync(join(tmpdir(), 'cdanet-nas-'));
    try {
      return await fn(d);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  return {
    async shares(host, cred) {
      // after the list it tries SMB1 for the workgroups and fails («Unable to connect with SMB1 --
      // no workgroup available», with an NT_STATUS): the shares listed are the answer
      return parseShares(await run(['-g', '-L', `//${host}`], cred, 60_000, null, (out) => /^(Disk|IPC|Printer)\|/m.test(out)));
    },
    async list(host, share, dir, cred) {
      // an empty folder may answer NO_SUCH_FILE to ls
      return parseLs(await run([service(host, share), ...inDir(dir), '-c', 'ls'], cred, 60_000, /NO_SUCH_FILE$/));
    },
    async mkdir(host, share, dir, name, cred) {
      await run([service(host, share), ...inDir(dir), '-c', `mkdir "${name}"`], cred);
    },
    async put(host, share, dir, name, data, cred) {
      await withTemp(async (d) => {
        const local = join(d, 'upload');
        writeFileSync(local, data, { mode: 0o600 });
        // written under a temporary name, then renamed: a broken transfer never looks like a backup
        await run([service(host, share), ...inDir(dir), '-c', `put "${local}" "${name}.part"; rename "${name}.part" "${name}"`], cred, 30 * 60_000);
      });
    },
    async get(host, share, dir, name, cred) {
      return withTemp(async (d) => {
        const local = join(d, 'download');
        await run([service(host, share), ...inDir(dir), '-c', `get "${name}" "${local}"`], cred, 30 * 60_000);
        return readFileSync(local);
      });
    },
    async remove(host, share, dir, name, cred) {
      await run([service(host, share), ...inDir(dir), '-c', `del "${name}"`], cred);
    },
  };
}

/** The NAS name to an address and its SMB port open (445, else 139): what a firewall or DNS breaks. */
export async function reachSmb(host: string, timeoutMs = 4000): Promise<{ ip: string; port: number }> {
  let ip = host;
  if (!isIP(host)) {
    try {
      ip = (await lookup(host, { family: 4 })).address;
    } catch {
      throw new HttpError(502, 'nas_host_unknown');
    }
  }
  const open = (port: number) =>
    new Promise<boolean>((resolve) => {
      const s = new Socket();
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('error', () => done(false));
      s.connect(port, ip, () => done(true));
    });
  for (const port of [445, 139]) if (await open(port)) return { ip, port };
  throw new HttpError(502, 'nas_unreachable', { ip });
}

// ---- the connector -----------------------------------------------------------------------------

const KEY = 'connector.nas';
const STATE = 'nas.backup.state';
export const BACKUP_FILE = /^cdanet-backup-\d{4}-\d{2}-\d{2}-\d{6}\.cdanet$/;

interface Stored {
  enabled: boolean;
  host: string;
  share: string;
  dir: string[];
  username: string;
  passwordSealed: string;
  domain: string;
  backupPasswordSealed: string;
  includeKey: boolean;
  /** Hour of the night backup (Europe/Rome). */
  hour: number;
  /** How many backups stay on the NAS (the oldest of ours are deleted). */
  keep: number;
}
export interface NasState {
  running: boolean;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastFile: string | null;
  lastBytes: number | null;
  durationMs: number | null;
  /** The restore test of the last copy: opened with the password, database checked. */
  verify: { at: string; ok: boolean; integrity: string; counts: Record<string, number | null> } | null;
  freeBytes: number | null;
}
export interface NasSaveInput {
  enabled: boolean;
  path: string;
  username: string;
  password?: string | undefined;
  domain: string;
  backupPassword?: string | undefined;
  includeKey: boolean;
  hour: number;
  keep: number;
}

const romeParts = (now: Date) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return { day: `${v('year')}-${v('month')}-${v('day')}`, hour: Number(v('hour')), stamp: `${v('year')}-${v('month')}-${v('day')}-${v('hour')}${v('minute')}${v('second')}` };
};
/** Today's backup is due: past its hour (Rome) and none tried today. */
export function nasDue(hour: number, lastRunAt: string | null, now = new Date()): boolean {
  const t = romeParts(now);
  return t.hour >= hour && (!lastRunAt || romeParts(new Date(lastRunAt)).day !== t.day);
}

export function createNas(
  db: Db,
  sealer: Sealer,
  opts: { version: string; masterKey: Buffer | null; smb?: SmbClient | undefined; reach?: typeof reachSmb | undefined; log?: (m: string) => void },
) {
  const smb = opts.smb ?? createSmbclient();
  const reach = opts.reach ?? reachSmb;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const read = () => {
    const r = db
      .prepare('SELECT s.value, s.updated_at, u.username FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?')
      .get(KEY) as { value: string; updated_at: string; username: string | null } | undefined;
    return r ? { stored: JSON.parse(r.value) as Stored, updatedAt: r.updated_at, updatedBy: r.username } : null;
  };
  const state = (): NasState => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE) as { value: string } | undefined;
    const s = r ? (JSON.parse(r.value) as Omit<NasState, 'running'>) : null;
    return { lastRunAt: null, lastOkAt: null, lastError: null, lastFile: null, lastBytes: null, durationMs: null, verify: null, freeBytes: null, ...s, running };
  };
  const setState = (patch: Partial<NasState>) => {
    const { running: _r, ...next } = { ...state(), ...patch };
    db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(STATE, JSON.stringify(next), nowIso());
  };
  const credOf = (c: Stored): SmbCred => ({ username: c.username, password: c.passwordSealed ? sealer.open(c.passwordSealed) : '', domain: c.domain });

  /**
   * Recognizes a path on the NAS: the name and its address, the SMB port, the share and each folder
   * with the name the NAS gives it (\\NAS\Backup typed as \\nas\backup is corrected), how far it
   * exists, and the subfolders and free space of the last folder found.
   */
  async function probe(input: string, cred: SmbCred) {
    const p = parseSmbPath(input);
    const net = await reach(p.host);
    const shares = await smb.shares(p.host, cred);
    const base = { host: p.host, ip: net.ip, port: net.port, shares };
    if (!p.share) return { ...base, path: smbPathText(p), share: null, dir: [] as string[], exists: true, missing: [] as string[], corrected: false, folders: shares.map((s) => s.name), files: 0, freeBytes: null as number | null };
    const share = shares.find((s) => s.name === p.share) ?? shares.find((s) => s.name.toLowerCase() === p.share!.toLowerCase());
    if (!share) throw new HttpError(404, 'nas_share_not_found', { share: p.share, shares: shares.map((s) => s.name) });
    const dir: string[] = [];
    let listing = await smb.list(p.host, share.name, [], cred);
    let missing: string[] = [];
    for (let i = 0; i < p.dir.length; i++) {
      const want = p.dir[i]!;
      const hit = listing.entries.find((e) => e.dir && e.name === want) ?? listing.entries.find((e) => e.dir && e.name.toLowerCase() === want.toLowerCase());
      if (!hit) {
        missing = p.dir.slice(i);
        break;
      }
      dir.push(hit.name);
      listing = await smb.list(p.host, share.name, dir, cred);
    }
    const found: SmbPath = { host: p.host, share: share.name, dir };
    return {
      ...base,
      path: smbPathText({ ...found, dir: [...dir, ...missing] }),
      share: share.name,
      dir,
      exists: missing.length === 0,
      missing,
      corrected: share.name !== p.share || dir.some((d, i) => d !== p.dir[i]),
      folders: listing.entries.filter((e) => e.dir).map((e) => e.name).sort((a, b) => a.localeCompare(b, 'it')),
      files: listing.entries.filter((e) => !e.dir).length,
      freeBytes: listing.freeBytes,
    };
  }

  /** The saved configuration as a path, or the values typed in the form. */
  const pathOf = (c: Stored) => smbPathText({ host: c.host, share: c.share, dir: c.dir });

  async function backupsOn(c: Stored) {
    const l = await smb.list(c.host, c.share, c.dir, credOf(c));
    return { files: l.entries.filter((e) => !e.dir && BACKUP_FILE.test(e.name)).sort((a, b) => a.name.localeCompare(b.name)), freeBytes: l.freeBytes };
  }

  /** Opens a copy on the NAS with the backup password and checks its database (nothing restored). */
  async function verifyFile(c: Stored, name: string) {
    const file = await smb.get(c.host, c.share, c.dir, name, credOf(c));
    const b = openBackup(file, sealer.open(c.backupPasswordSealed));
    const r = inspectDatabase(b.database);
    return { at: nowIso(), ok: r.ok, integrity: r.integrity, counts: r.counts as Record<string, number | null>, file: name, includesKey: !!b.masterKey };
  }

  /** The backup: snapshot, sealed, copied, read back and opened, then the oldest copies deleted. */
  async function run(byUserId: number | null) {
    const c = read()?.stored;
    if (!c?.host || !c.share || !c.backupPasswordSealed) throw new HttpError(400, 'nas_incomplete');
    if (running) throw new HttpError(409, 'nas_busy');
    running = true;
    const started = Date.now();
    const at = nowIso();
    try {
      const database = snapshot(db);
      const file = sealBackup(database, sealer.open(c.backupPasswordSealed), { format: 'cdanet-backup', version: opts.version, createdAt: at, dbBytes: database.length, source: 'nas' }, c.includeKey ? opts.masterKey : null);
      const name = `cdanet-backup-${romeParts(new Date()).stamp}.cdanet`;
      const cred = credOf(c);
      await smb.put(c.host, c.share, c.dir, name, file, cred);
      const after = await backupsOn(c);
      const there = after.files.find((f) => f.name === name);
      if (!there || there.size !== file.length) throw new HttpError(502, 'nas_copy_mismatch', { expected: file.length, found: there?.size ?? null });
      const verify = await verifyFile(c, name);
      if (!verify.ok) throw new HttpError(502, 'nas_verify_failed', { integrity: verify.integrity });
      // only our own files, the newest [keep] stay
      const old = after.files.slice(0, Math.max(0, after.files.length - c.keep));
      for (const f of old) await smb.remove(c.host, c.share, c.dir, f.name, cred).catch((e) => opts.log?.(`nas: ${f.name} non cancellato: ${(e as Error).message}`));
      setState({ lastRunAt: at, lastOkAt: at, lastError: null, lastFile: name, lastBytes: file.length, durationMs: Date.now() - started, verify: { at: verify.at, ok: verify.ok, integrity: verify.integrity, counts: verify.counts }, freeBytes: after.freeBytes });
      recordEvent(db, byUserId, 'nas.backup', pathOf(c), `${name} · ${Math.round(file.length / 1024)} KB · verificato${old.length ? ` · ${old.length} copie vecchie cancellate` : ''}`);
      return { ok: true as const, file: name, bytes: file.length, durationMs: Date.now() - started, deleted: old.map((f) => f.name), verify };
    } catch (e) {
      const err = e as HttpError;
      const code = err.code ?? (e as Error).message;
      setState({ lastRunAt: at, lastError: code, durationMs: Date.now() - started });
      recordEvent(db, byUserId, 'nas.backup', pathOf(c), `non riuscito: ${code}${err.extra?.detail ? ` (${String(err.extra.detail)})` : ''}`);
      throw e;
    } finally {
      running = false;
    }
  }

  function tick(now = new Date()) {
    const c = read()?.stored;
    if (!c?.enabled || running || !nasDue(c.hour, state().lastRunAt, now)) return;
    void run(null).catch((e) => opts.log?.(`nas backup: ${(e as HttpError).code ?? (e as Error).message}`));
  }

  return {
    probe,
    tick,
    run,
    state,
    configured: () => !!read()?.stored.host,

    /**
     * The credentials typed in the form, else the saved ones: the saved password only for the same
     * user on the same NAS (never sent to another host typed in the form, never sent back).
     */
    cred(input: { path: string; username?: string | undefined; password?: string | undefined; domain?: string | undefined }): SmbCred {
      const c = read()?.stored;
      const username = input.username ?? c?.username ?? '';
      const same = !!c && username === c.username && parseSmbPath(input.path).host === c.host;
      return { username, password: input.password || (same ? credOf(c).password : ''), domain: input.domain ?? c?.domain ?? '' };
    },

    /** A new folder in a folder of the NAS. */
    async mkdir(input: string, name: string, cred: SmbCred) {
      const why = badName(name);
      if (why) throw new HttpError(400, 'nas_name_invalid', { detail: why });
      const p = parseSmbPath(input);
      if (!p.share) throw new HttpError(400, 'nas_path_invalid', { detail: 'scegli prima una cartella condivisa' });
      await smb.mkdir(p.host, p.share, p.dir, name, cred);
      return probe(smbPathText({ ...p, dir: [...p.dir, name] }), cred);
    },

    /** The connection test: the path recognized and a small file written and deleted there. */
    async test(input: string, cred: SmbCred) {
      const r = await probe(input, cred);
      if (!r.share) throw new HttpError(400, 'nas_path_invalid', { detail: 'manca la cartella condivisa' });
      if (!r.exists) return { ...r, writable: false };
      const name = `.cdanet-prova-${Date.now().toString(36)}`;
      try {
        await smb.put(r.host, r.share, r.dir, name, Buffer.from('CDA Net: prova di scrittura del backup\n'), cred);
        await smb.remove(r.host, r.share, r.dir, name, cred);
        return { ...r, writable: true };
      } catch (e) {
        if ((e as HttpError).code === 'nas_access_denied') return { ...r, writable: false };
        throw e;
      }
    },

    async files() {
      const c = read()?.stored;
      if (!c?.host) throw new HttpError(400, 'nas_incomplete');
      const r = await backupsOn(c);
      return { path: pathOf(c), keep: c.keep, freeBytes: r.freeBytes, files: [...r.files].reverse() };
    },

    /** The restore test of a copy on the NAS (the newest when none is named). */
    async verify(name?: string) {
      const c = read()?.stored;
      if (!c?.host || !c.backupPasswordSealed) throw new HttpError(400, 'nas_incomplete');
      const pick = name ?? (await backupsOn(c)).files.at(-1)?.name;
      if (!pick || !BACKUP_FILE.test(pick)) throw new HttpError(404, 'nas_no_backup');
      const v = await verifyFile(c, pick);
      if (pick === state().lastFile) setState({ verify: { at: v.at, ok: v.ok, integrity: v.integrity, counts: v.counts } });
      return v;
    },

    /** Public view: never a password. */
    view() {
      const c = read();
      const s = c?.stored;
      return {
        configured: !!s?.host,
        enabled: s?.enabled ?? false,
        path: s?.host ? pathOf(s) : '',
        username: s?.username ?? '',
        domain: s?.domain ?? '',
        passwordSet: !!s?.passwordSealed,
        backupPasswordSet: !!s?.backupPasswordSealed,
        includeKey: s?.includeKey ?? false,
        hour: s?.hour ?? 3,
        keep: s?.keep ?? 14,
        updatedAt: c?.updatedAt ?? null,
        updatedBy: c?.updatedBy ?? null,
        state: state(),
      };
    },

    /** Empty passwords keep the saved ones (the NAS password only for the same user). */
    save(input: NasSaveInput, userId: number) {
      const prev = read()?.stored;
      const p = parseSmbPath(input.path);
      if (!p.share) throw new HttpError(400, 'nas_path_invalid', { detail: 'manca la cartella condivisa' });
      const passwordSealed = input.password ? sealer.seal(input.password) : prev && prev.username === input.username ? prev.passwordSealed : '';
      const backupPasswordSealed = input.backupPassword ? sealer.seal(input.backupPassword) : (prev?.backupPasswordSealed ?? '');
      if (input.enabled && !backupPasswordSealed) throw new HttpError(400, 'nas_backup_password_required');
      if (input.enabled && input.username && !passwordSealed) throw new HttpError(400, 'nas_password_required');
      const stored: Stored = {
        enabled: input.enabled,
        host: p.host,
        share: p.share,
        dir: p.dir,
        username: input.username,
        passwordSealed,
        domain: input.domain,
        backupPasswordSealed,
        includeKey: input.includeKey,
        hour: input.hour,
        keep: input.keep,
      };
      db.prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(KEY, JSON.stringify(stored), nowIso(), userId);
    },

    reset() {
      db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(KEY, STATE);
    },

    /** For Salute piattaforma: the last good copy, or the error of the last try. */
    health(): { at: string | null; error: string | null; detail?: string } | null {
      const c = read()?.stored;
      if (!c?.enabled) return null;
      const s = state();
      return { at: s.lastOkAt, error: s.lastError && s.lastRunAt && (!s.lastOkAt || s.lastRunAt > s.lastOkAt) ? s.lastError : null, ...(s.lastFile ? { detail: s.lastFile } : {}) };
    },

    start(everyMs = 5 * 60_000) {
      if (timer) return;
      timer = setInterval(() => tick(), everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
export type Nas = ReturnType<typeof createNas>;
