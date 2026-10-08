import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';

/** Acceptance-test photos live on disk: <photosDir>/<jobId>/<photoId>.jpg */
export function photoDir(root: string, jobId: string) {
  return join(root, jobId.replace(/[^\w-]/g, ''));
}

/** Removes photo folders whose job no longer exists (retention, deletions). */
export function sweepPhotos(db: Db, root: string) {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return 0;
  }
  const exists = db.prepare('SELECT 1 FROM provisioning_jobs WHERE id = ?');
  let removed = 0;
  for (const d of dirs) {
    if (!exists.get(d)) {
      rmSync(join(root, d), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
