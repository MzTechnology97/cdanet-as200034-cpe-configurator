import type { Imagery } from './imagery.ts';
import { PHOTO_MIN_ZOOM, tilesAround } from './imagery.ts';

/** Around each AP: the area of its customers, and a little more. */
const AROUND_KM = 3;
/** Zooms downloaded ahead: from where the photos start to the detail of a roof. */
const MAX_ZOOM = 16;
/** Tiles asked at once by the download: the maps keep the rest of the public service. */
const PARALLEL = 2;
/** First run a few minutes after the start (the server is busy starting), then every night. */
const FIRST_RUN_MS = 5 * 60_000;
const NIGHT_HOUR = 3;

/**
 * The orthophotos of the area of the network downloaded ahead into the disk cache, so that a map
 * opened there shows them at once instead of asking the public service tile by tile (1-3 s each
 * the first time). Only the tiles not on disk yet are asked: after the first run a night costs
 * little. [aps]: where the APs are (none: nothing to do).
 */
export function createImageryPrefetch(o: { imagery: Imagery; aps: () => Promise<Array<{ lat: number; lon: number }>>; log?: (msg: string) => void }) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ctrl: AbortController | null = null;
  let running = false;

  async function run() {
    if (running || !o.imagery.wmsReady()) return null;
    running = true;
    ctrl = new AbortController();
    try {
      const points = (await o.aps().catch(() => [])).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (!points.length) return null;
      const tiles = tilesAround(points, AROUND_KM, PHOTO_MIN_ZOOM, MAX_ZOOM);
      const started = Date.now();
      const r = await o.imagery.prefetch(tiles, { parallel: PARALLEL, signal: ctrl.signal });
      if (r.asked) o.log?.(`imagery prefetch: ${tiles.length} tiles around ${points.length} APs, ${r.asked} asked (${r.photos} with a photo) in ${Math.round((Date.now() - started) / 60_000)} min`);
      return { tiles: tiles.length, ...r };
    } finally {
      running = false;
      ctrl = null;
    }
  }

  /** Milliseconds to the next night run. */
  const untilNight = (now = new Date()) => {
    const next = new Date(now);
    next.setHours(NIGHT_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  };
  const schedule = (ms: number) => {
    timer = setTimeout(() => {
      void run()
        .catch((e) => o.log?.(`imagery prefetch: ${(e as Error).message}`))
        .finally(() => schedule(untilNight()));
    }, ms);
    timer.unref();
  };

  return {
    run,
    start() {
      schedule(FIRST_RUN_MS);
    },
    stop() {
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    },
  };
}
