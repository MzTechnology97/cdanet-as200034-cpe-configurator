import type { Auth } from './auth.ts';
import type { Config } from './config.ts';
import type { Sealer } from './crypto.ts';
import type { Db } from './db.ts';
import type { Provisioning } from './services/provisioning.ts';
import type { Templates } from './services/templates.ts';
import type { Geocoder } from './services/geocode.ts';
import type { Uisp } from './services/uisp.ts';
import type { Connectors } from './services/connectors.ts';
import type { Modules } from './services/modules.ts';
import type { Oui } from './services/oui.ts';
import type { Outages } from './services/outages.ts';
import type { Notifier } from './services/notify.ts';
import type { Telegram } from './services/telegram.ts';
import type { Dem } from './services/dem.ts';
import type { ServerSettings } from './services/server-settings.ts';

export interface AppContext {
  cfg: Config;
  db: Db;
  sealer: Sealer;
  auth: Auth;
  provisioning: Provisioning;
  templates: Templates;
  /** null when UISP is not configured (Connettori or .env). Replaced at runtime when an admin saves the connector. */
  uisp: Uisp | null;
  uispSettings: { autoBackup: boolean; coverageMaxKm: number };
  connectors: Connectors;
  geocoder: Geocoder;
  telegram: Telegram;
  modules: Modules;
  oui: Oui;
  outages: Outages;
  dem: Dem;
  serverSettings: ServerSettings;
  notify: Notifier;
  version: string;
}
