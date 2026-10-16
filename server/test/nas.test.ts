import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../src/auth.ts';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmbclient, nasDue, parseLs, parseShares, parseSmbPath, smbError, smbPathText, type SmbClient, type SmbCred } from '../src/services/nas.ts';
import { ADMIN, testConfig } from './helpers.ts';

const LS = `  .                                   D        0  Wed Oct 16 10:00:00 2026
  ..                                  D        0  Wed Oct 16 10:00:00 2026
  CDA Net                             D        0  Mon Oct  6 09:12:44 2026
  note.txt                            A     1234  Tue Oct 15 18:01:02 2026
  cdanet-backup-2026-10-15-030000.cdanet      A 52428800  Wed Oct 16 03:00:41 2026

\t\t479595152 blocks of size 1024. 123456 blocks available
`;

/** A NAS in memory: shares, folders and files, one account; the calls are counted. */
function fakeNas() {
  const tree = new Map<string, Map<string, Buffer | 'dir'>>([
    ['Backup', new Map<string, Buffer | 'dir'>([['CDA Net', 'dir'], ['Altro', 'dir']])],
    ['Foto', new Map()],
  ]);
  const ok = (c: SmbCred) => {
    if (c.username !== 'backup' || c.password !== 'Nas-Pass-1') throw new HttpError(502, 'nas_auth_failed');
  };
  const key = (dir: string[], name?: string) => [...dir, ...(name ? [name] : [])].join('\\');
  const folder = (share: string, dir: string[]) => {
    const t = tree.get(share);
    if (!t) throw new HttpError(404, 'nas_share_not_found');
    if (dir.length && t.get(key(dir)) !== 'dir') throw new HttpError(404, 'nas_path_not_found');
    return t;
  };
  const smb: SmbClient = {
    async shares(_h, c) {
      ok(c);
      return [...tree.keys()].map((name) => ({ name, comment: '' }));
    },
    async list(_h, share, dir, c) {
      ok(c);
      const t = folder(share, dir);
      const prefix = dir.length ? `${key(dir)}\\` : '';
      const entries = [...t.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('\\'))
        .map(([k, v]) => ({ name: k.slice(prefix.length), dir: v === 'dir', size: v === 'dir' ? 0 : v.length, modified: 'Wed Oct 16 03:00:00 2026' }));
      return { entries, freeBytes: 500 * 1024 ** 3 };
    },
    async mkdir(_h, share, dir, name, c) {
      ok(c);
      const t = folder(share, dir);
      if (t.has(key(dir, name))) throw new HttpError(409, 'nas_exists');
      t.set(key(dir, name), 'dir');
    },
    async put(_h, share, dir, name, data, c) {
      ok(c);
      if (share === 'Foto') throw new HttpError(502, 'nas_access_denied');
      folder(share, dir).set(key(dir, name), Buffer.from(data));
    },
    async get(_h, share, dir, name, c) {
      ok(c);
      const v = folder(share, dir).get(key(dir, name));
      if (!v || v === 'dir') throw new HttpError(404, 'nas_path_not_found');
      return v;
    },
    async remove(_h, share, dir, name, c) {
      ok(c);
      folder(share, dir).delete(key(dir, name));
    },
  };
  const reach = async (host: string) => {
    if (host === 'spento.lan') throw new HttpError(502, 'nas_unreachable');
    return { ip: '192.168.1.20', port: 445 };
  };
  return { smb, reach, tree };
}

describe('Connettore NAS (SMB/CIFS)', () => {
  it('recognizes the network path in the forms people write it', () => {
    const want = { host: 'nas.lan', share: 'backup', dir: ['cdanet', 'notte'] };
    for (const s of ['\\\\nas.lan\\backup\\cdanet\\notte', '//nas.lan/backup/cdanet/notte/', 'smb://nas.lan/backup/cdanet/notte', 'smb://utente@NAS.lan/backup/cdanet/notte', 'nas.lan\\backup/cdanet\\notte'])
      assert.deepEqual(parseSmbPath(s), want, s);
    assert.deepEqual(parseSmbPath('smb://192.168.1.20/Dati%20Ufficio'), { host: '192.168.1.20', share: 'Dati Ufficio', dir: [] });
    assert.deepEqual(parseSmbPath('\\\\nas'), { host: 'nas', share: null, dir: [] });
    assert.equal(smbPathText({ host: 'nas.lan', share: 'Backup', dir: ['CDA Net'] }), '\\\\nas.lan\\Backup\\CDA Net');
    const code = (s: string) => {
      try {
        parseSmbPath(s);
        return 'ok';
      } catch (e) {
        return (e as HttpError).code;
      }
    };
    assert.equal(code('Z:\\backup'), 'nas_path_drive', 'a drive letter of the PC');
    assert.equal(code('\\\\nas\\C$'), 'nas_path_invalid', 'administrative shares');
    assert.equal(code('\\\\nas\\backup\\a;b'), 'nas_path_invalid', 'would break the smbclient commands');
    assert.equal(code('\\\\-nas\\backup'), 'nas_path_invalid');
    assert.equal(code('\\\\nas\\backup\\..'), 'nas_path_invalid');
  });

  it('reads smbclient: folders and files, free space, shares, errors', () => {
    const l = parseLs(LS);
    assert.deepEqual(
      l.entries.map((e) => [e.name, e.dir, e.size]),
      [
        ['CDA Net', true, 0],
        ['note.txt', false, 1234],
        ['cdanet-backup-2026-10-15-030000.cdanet', false, 52428800],
      ],
    );
    assert.equal(l.freeBytes, 123456 * 1024);
    assert.deepEqual(parseShares('Disk|Backup|Copie\nDisk|Foto|\nIPC|IPC$|IPC Service\nDisk|ADMIN$|Remote Admin\nPrinter|Stampante|'), [
      { name: 'Backup', comment: 'Copie' },
      { name: 'Foto', comment: '' },
    ]);
    assert.equal(smbError('session setup failed: NT_STATUS_LOGON_FAILURE').code, 'nas_auth_failed');
    assert.equal(smbError('tree connect failed: NT_STATUS_BAD_NETWORK_NAME').code, 'nas_share_not_found');
    assert.equal(smbError('cd \\x\\: NT_STATUS_OBJECT_NAME_NOT_FOUND').code, 'nas_path_not_found');
    assert.equal(smbError('do_connect: Connection to nas failed (Error NT_STATUS_IO_TIMEOUT)').code, 'nas_unreachable');
    assert.equal(smbError('protocol negotiation failed: NT_STATUS_CONNECTION_RESET').code, 'nas_protocol', 'a NAS with SMB1 only');
    assert.equal(smbError('NT_STATUS_ACCESS_DENIED opening remote file').code, 'nas_access_denied');
  });

  it('runs smbclient with the password in its environment, never in its arguments', { skip: process.platform === 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-smb-'));
    try {
      const log = join(dir, 'log');
      const bin = join(dir, 'smbclient');
      writeFileSync(
        bin,
        `#!/bin/sh
printf '%s\n' "$@" "PASSWD=$PASSWD" >> '${log}'
case "$*" in
  *'-U wrong'*) echo 'session setup failed: NT_STATUS_LOGON_FAILURE'; exit 1;;
  *-L*) printf 'Disk|Backup|Copie\nIPC|IPC$|IPC Service\n'; echo 'do_connect: Connection to nas failed (Error NT_STATUS_RESOURCE_NAME_NOT_FOUND)' >&2; echo 'Unable to connect with SMB1 -- no workgroup available' >&2; exit 0;;
  *ls*) cat <<'EOF'
${LS}EOF
  exit 0;;
esac
exit 0
`,
      );
      chmodSync(bin, 0o755);
      const smb = createSmbclient({ bin });
      const cred = { username: 'backup', password: 'Segreta-1', domain: '' };
      assert.deepEqual(await smb.shares('nas.lan', cred), [{ name: 'Backup', comment: 'Copie' }], 'the failed SMB1 workgroup listing is no error');
      const l = await smb.list('nas.lan', 'Backup', ['CDA Net'], cred);
      assert.equal(l.entries.length, 3);
      await assert.rejects(smb.list('nas.lan', 'Backup', [], { ...cred, username: 'wrong' }), (e: HttpError) => e.code === 'nas_auth_failed');
      const args = readFileSync(log, 'utf8');
      assert.ok(!args.split('\n').includes('Segreta-1') && !/backup%/.test(args), 'not in argv');
      assert.match(args, /PASSWD=Segreta-1/);
      assert.match(args, /^-D\n\CDA Net$/m, 'the folder as one argument');
      await assert.rejects(createSmbclient({ bin: join(dir, 'missing') }).shares('nas.lan', cred), (e: HttpError) => e.code === 'nas_client_missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('one backup a night, after its hour (Rome)', () => {
    const at = (iso: string) => new Date(iso);
    assert.equal(nasDue(3, null, at('2026-10-16T00:30:00Z')), false, '02:30 in Rome');
    assert.equal(nasDue(3, null, at('2026-10-16T01:05:00Z')), true, '03:05 in Rome');
    assert.equal(nasDue(3, '2026-10-16T01:05:00Z', at('2026-10-16T09:00:00Z')), false, 'already tried today');
    assert.equal(nasDue(3, '2026-10-15T01:05:00Z', at('2026-10-16T09:00:00Z')), true, 'the server was off at 3: done later');
  });

  it('browse and choose the folder, test, save, back up with the restore test, keep the newest copies', async () => {
    const nas = fakeNas();
    const db = openDatabase(':memory:');
    const { app, ctx } = await buildApp(testConfig(), 'test', { db, logger: false, smb: nas.smb, reachSmb: nas.reach });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, headers = A) => app.inject({ method, url, headers, payload });
    const acc = { username: 'backup', password: 'Nas-Pass-1' };

    // the NAS alone: its shares; then a path typed with the wrong case, corrected, with what is missing
    let r = (await call('POST', '/api/admin/connectors/nas/browse', { path: '\\\\nas.lan', ...acc })).json();
    assert.deepEqual([r.ip, r.port, r.folders], ['192.168.1.20', 445, ['Backup', 'Foto']]);
    r = (await call('POST', '/api/admin/connectors/nas/browse', { path: 'smb://nas.lan/backup/cda net/notte', ...acc })).json();
    assert.deepEqual([r.path, r.share, r.dir, r.exists, r.missing, r.corrected], ['\\\\nas.lan\\Backup\\CDA Net\\notte', 'Backup', ['CDA Net'], false, ['notte'], true]);
    r = (await call('POST', '/api/admin/connectors/nas/browse', { path: '\\\\nas.lan\\backup', ...acc })).json();
    assert.deepEqual(r.folders, ['Altro', 'CDA Net']);
    assert.equal((await call('POST', '/api/admin/connectors/nas/browse', { path: '\\\\nas.lan\\Archivio', ...acc })).json().error, 'nas_share_not_found');
    assert.deepEqual((await call('POST', '/api/admin/connectors/nas/browse', { path: '\\\\nas.lan\\Archivio', ...acc })).json().shares, ['Backup', 'Foto']);
    assert.equal((await call('POST', '/api/admin/connectors/nas/browse', { path: '\\\\nas.lan', username: 'backup', password: 'sbagliata' })).json().error, 'nas_auth_failed');
    assert.equal((await call('POST', '/api/admin/connectors/nas/browse', { path: '\\\\spento.lan\\backup', ...acc })).json().error, 'nas_unreachable');

    // a new folder from the console, then the test writes a file there and deletes it
    r = (await call('POST', '/api/admin/connectors/nas/mkdir', { path: '\\\\nas.lan\\Backup\\CDA Net', name: 'notte', ...acc })).json();
    assert.deepEqual([r.path, r.exists], ['\\\\nas.lan\\Backup\\CDA Net\\notte', true]);
    assert.equal((await call('POST', '/api/admin/connectors/nas/mkdir', { path: '\\\\nas.lan\\Backup', name: 'a?b', ...acc })).json().error, 'nas_name_invalid');
    r = (await call('POST', '/api/admin/connectors/nas/test', { path: r.path, ...acc })).json();
    assert.deepEqual([r.ok, r.writable], [true, true]);
    assert.equal([...nas.tree.get('Backup')!.keys()].filter((k) => k.includes('.cdanet-prova')).length, 0, 'the test file is deleted');
    assert.equal((await call('POST', '/api/admin/connectors/nas/test', { path: '\\\\nas.lan\\Foto', ...acc })).json().writable, false, 'read only');

    // saved: no password comes back
    const save = { enabled: true, path: '\\\\nas.lan\\Backup\\CDA Net\\notte', username: 'backup', password: 'Nas-Pass-1', domain: '', backupPassword: 'Backup-Pass-12345', includeKey: false, hour: 3, keep: 2 };
    assert.equal((await call('PUT', '/api/admin/connectors/nas', { ...save, backupPassword: 'corta' })).statusCode, 400);
    const v = (await call('PUT', '/api/admin/connectors/nas', save)).json();
    assert.deepEqual([v.configured, v.enabled, v.path, v.passwordSet, v.backupPasswordSet, v.keep], [true, true, save.path, true, true, 2]);
    assert.ok(!JSON.stringify((await call('GET', '/api/admin/connectors')).json()).match(/Nas-Pass-1|Backup-Pass-12345/), 'never the passwords');
    // the saved password: for the same user on the same NAS only
    assert.equal((await call('POST', '/api/admin/connectors/nas/browse', { path: save.path, username: 'backup' })).statusCode, 200);
    assert.equal((await call('POST', '/api/admin/connectors/nas/browse', { path: '\\\\altro-nas.lan\\Backup', username: 'backup' })).json().error, 'nas_auth_failed', 'not sent to another host');

    // three backups: each one read back and opened; the oldest goes, only 2 stay
    const run = async () => {
      const x = await call('POST', '/api/admin/connectors/nas/run');
      assert.equal(x.statusCode, 200, x.body);
      await new Promise((ok) => setTimeout(ok, 1100)); // a new name (seconds)
      return x.json();
    };
    const first = await run();
    assert.equal(first.verify.ok, true);
    assert.equal(first.verify.counts.users, 1);
    await run();
    const third = await run();
    assert.equal(third.deleted.length, 1);
    const files = (await call('GET', '/api/admin/connectors/nas/files')).json();
    assert.equal(files.files.length, 2);
    assert.equal(files.files[0].name, third.file, 'newest first');
    assert.ok(!files.files.some((f: { name: string }) => f.name === first.file), 'the oldest is gone');
    assert.ok(nas.tree.get('Backup')!.has('CDA Net\\notte\\' + third.file));
    // the restore test of the copy on the NAS
    const ver = (await call('POST', '/api/admin/connectors/nas/verify', {})).json();
    assert.deepEqual([ver.ok, ver.file, ver.integrity], [true, third.file, 'ok']);
    // Salute piattaforma: the NAS backup is a source
    const h = (await call('GET', '/api/admin/platform/health')).json();
    const nasSource = h.sources.find((s: { id: string }) => s.id === 'nas');
    assert.deepEqual([nasSource.state, nasSource.detail], ['ok', third.file]);

    // a failure: the folder deleted on the NAS → the source goes red, the event says why
    nas.tree.get('Backup')!.delete('CDA Net\\notte');
    assert.equal((await call('POST', '/api/admin/connectors/nas/run')).json().error, 'nas_path_not_found');
    const h2 = (await call('GET', '/api/admin/platform/health')).json();
    assert.deepEqual(
      ['state', 'error'].map((k) => h2.sources.find((s: { id: string }) => s.id === 'nas')[k]),
      ['bad', 'nas_path_not_found'],
    );
    const ev = db.prepare("SELECT action, detail FROM events WHERE action LIKE 'nas.%' OR action LIKE 'connector.nas.%' ORDER BY id").all() as Array<{ action: string; detail: string }>;
    assert.deepEqual(
      ev.map((e) => e.action),
      ['nas.mkdir', 'connector.nas.test', 'connector.nas.test', 'connector.nas.update', 'nas.backup', 'nas.backup', 'nas.backup', 'nas.verify', 'nas.backup'],
    );
    assert.match(ev.at(-1)!.detail, /non riuscito: nas_path_not_found/);
    assert.ok(!JSON.stringify(ev).match(/Nas-Pass-1|Backup-Pass-12345/));

    // installers: nothing of this
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    assert.equal((await call('POST', '/api/admin/connectors/nas/browse', { path: '\\\\nas.lan', ...acc }, T)).statusCode, 403);
    assert.equal((await call('GET', '/api/admin/connectors/nas/files', undefined, T)).statusCode, 403);
    // removed: the copies stay on the NAS
    assert.equal((await call('DELETE', '/api/admin/connectors/nas')).json().configured, false);
    assert.equal(ctx.nas.health(), null);
    await app.close();
  });
});
