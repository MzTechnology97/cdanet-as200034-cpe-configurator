import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

/**
 * Android release channel. `latest.json` + APK live in ANDROID_RELEASE_DIR.
 * Optionally the directory is kept in sync with the newest GitHub Release of
 * the repository (assets `latest.json` and the APK it references).
 */

export const releaseMetaSchema = z
  .object({
    versionCode: z.number().int().positive(),
    versionName: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/).max(40),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    fileName: z.string().regex(/^CDA-Net-CPE-[A-Za-z0-9._-]+\.apk$/).max(160),
    mandatory: z.boolean().optional().default(false),
    minServerVersion: z.string().optional(),
    publishedAt: z.string().optional(),
  })
  .strip();
export type ReleaseMeta = z.infer<typeof releaseMetaSchema>;

export function loadLatestRelease(dir: string): (ReleaseMeta & { apkPath: string }) | null {
  try {
    const meta = releaseMetaSchema.parse(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')));
    if (basename(meta.fileName) !== meta.fileName) return null;
    const apkPath = join(dir, meta.fileName);
    return existsSync(apkPath) ? { ...meta, apkPath } : null;
  } catch {
    return null;
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

interface GithubAsset {
  name: string;
  url: string;
  size: number;
}

export interface SyncOptions {
  dir: string;
  repo: string;
  token?: string | undefined;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  fetchImpl?: typeof fetch;
}

const MAX_APK = 150 * 1024 * 1024;

export async function syncFromGithub(opts: SyncOptions): Promise<'updated' | 'current' | 'no-release'> {
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cdanet-cpe-server',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const rel = await f(`https://api.github.com/repos/${opts.repo}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (rel.status === 404) return 'no-release';
  if (!rel.ok) throw new Error(`github_release_http_${rel.status}`);
  const release = (await rel.json()) as { tag_name?: string; assets?: GithubAsset[] };
  const assets = release.assets ?? [];

  const download = async (asset: GithubAsset) => {
    const r = await f(asset.url, {
      headers: { ...headers, Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(300_000),
    });
    if (!r.ok) throw new Error(`github_asset_http_${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };

  const metaAsset = assets.find((a) => a.name === 'latest.json');
  if (!metaAsset) return 'no-release';
  const meta = releaseMetaSchema.parse(JSON.parse((await download(metaAsset)).toString('utf8')));
  const current = loadLatestRelease(opts.dir);
  if (current && current.versionCode >= meta.versionCode && current.sha256.toLowerCase() === meta.sha256.toLowerCase()) {
    return 'current';
  }
  const apkAsset = assets.find((a) => a.name === meta.fileName);
  if (!apkAsset) throw new Error('github_release_apk_missing');
  if (apkAsset.size > MAX_APK) throw new Error('github_release_apk_too_large');

  const apk = await download(apkAsset);
  const sha = createHash('sha256').update(apk).digest('hex');
  if (sha !== meta.sha256.toLowerCase()) throw new Error('github_release_sha256_mismatch');

  mkdirSync(opts.dir, { recursive: true });
  const tmpApk = join(opts.dir, `.${meta.fileName}.tmp`);
  const tmpMeta = join(opts.dir, '.latest.json.tmp');
  writeFileSync(tmpApk, apk);
  renameSync(tmpApk, join(opts.dir, meta.fileName));
  writeFileSync(tmpMeta, `${JSON.stringify({ ...meta, publishedAt: new Date().toISOString() }, null, 2)}\n`);
  renameSync(tmpMeta, join(opts.dir, 'latest.json'));
  if (current && current.fileName !== meta.fileName) rmSync(current.apkPath, { force: true });
  opts.log.info({ version: meta.versionName, tag: release.tag_name }, 'android release synced from GitHub');
  return 'updated';
}

export function startReleaseSync(opts: SyncOptions & { minutes: number }): () => void {
  if (opts.minutes <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncFromGithub(opts);
    } catch (e) {
      opts.log.warn({ err: (e as Error).message }, 'android release sync failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, opts.minutes * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
