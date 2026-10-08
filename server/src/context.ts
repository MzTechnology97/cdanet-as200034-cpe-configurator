import type { Auth } from './auth.ts';
import type { Config } from './config.ts';
import type { Sealer } from './crypto.ts';
import type { Db } from './db.ts';
import type { Provisioning } from './services/provisioning.ts';
import type { Templates } from './services/templates.ts';
import type { Geocoder } from './services/geocode.ts';
import type { Uisp } from './services/uisp.ts';

export interface AppContext {
  cfg: Config;
  db: Db;
  sealer: Sealer;
  auth: Auth;
  provisioning: Provisioning;
  templates: Templates;
  /** null when UISP_API_URL/UISP_API_TOKEN are not configured. */
  uisp: Uisp | null;
  geocoder: Geocoder;
  version: string;
}
