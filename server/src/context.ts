import type { Auth } from './auth.ts';
import type { Config } from './config.ts';
import type { Sealer } from './crypto.ts';
import type { Db } from './db.ts';
import type { Provisioning } from './services/provisioning.ts';
import type { Templates } from './services/templates.ts';

export interface AppContext {
  cfg: Config;
  db: Db;
  sealer: Sealer;
  auth: Auth;
  provisioning: Provisioning;
  templates: Templates;
  version: string;
}
