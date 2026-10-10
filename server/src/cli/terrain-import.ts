// Imports terrain (TINITALY) and land cover (ESA WorldCover) for an area, the same as the console
// button "Scarica terreno e ostacoli": npm run terrain:import -- minLat,minLon,maxLat,maxLon
// Needs only the data directory and Internet (no secrets): run it as the app user.
import { dirname, join } from 'node:path';
import { createDem } from '../services/dem.ts';
import { createTerrainStore } from '../services/terrain-store.ts';

const [minLat, minLon, maxLat, maxLon] = (process.argv[2] ?? '').split(',').map(Number);
if ([minLat, minLon, maxLat, maxLon].some((v) => v === undefined || Number.isNaN(v))) {
  console.error('Uso: npm run terrain:import -- minLat,minLon,maxLat,maxLon');
  process.exit(2);
}
const dbPath = process.env.DB_PATH ?? '/data/cdanet.sqlite';
const store = createTerrainStore({
  dir: join(dirname(dbPath), 'terrain'),
  dem: createDem({ dir: join(dirname(dbPath), 'dem'), baseUrl: process.env.DEM_URL || 'https://elevation-tiles-prod.s3.amazonaws.com/skadi' }),
  log: (m) => console.error(m),
});
const timer = setInterval(() => {
  const s = store.state();
  console.log(`${s.phase} · ${s.done}/${s.total}`);
}, 15_000);
await store.importArea({ minLat: minLat!, minLon: minLon!, maxLat: maxLat!, maxLon: maxLon! });
clearInterval(timer);
const s = store.status();
console.log(`${s.import.phase}${s.import.error ? ` · errore: ${s.import.error}` : ''} · TINITALY ${s.tinitaly} file, WorldCover ${s.worldcover} file · tile terreno ${s.dtmTiles}, suolo ${s.coverTiles}`);
