import type { Auth } from './auth.ts';
import type { Config } from './config.ts';
import type { Sealer } from './crypto.ts';
import type { Db } from './db.ts';
import type { Provisioning } from './services/provisioning.ts';
import type { Templates } from './services/templates.ts';
import type { Geocoder } from './services/geocode.ts';
import type { Uisp } from './services/uisp.ts';
import type { Connectors } from './services/connectors.ts';
import type { CrmSettings } from './services/crm.ts';
import type { CrmSync } from './services/crm-sync.ts';
import type { Modules } from './services/modules.ts';
import type { Oui } from './services/oui.ts';
import type { Outages } from './services/outages.ts';
import type { Notifier } from './services/notify.ts';
import type { Telegram } from './services/telegram.ts';
import type { Dem } from './services/dem.ts';
import type { TerrainStore } from './services/terrain-store.ts';
import type { ApLoadService } from './services/ap-load.ts';
import type { Advisor } from './services/ap-advisor.ts';
import type { Optimizer } from './services/ap-optimizer.ts';
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
  /** CRM connector (ISP Billing): settings and client, configured from Connettori. */
  crm: CrmSettings;
  /** RADIUS state copied from the CRM for the NOC (admins only). */
  crmSync: CrmSync;
  /** Load of the APs and capacity curve, refreshed hourly from UISP. */
  apLoad: ApLoadService;
  /** Assistente rete: findings on APs and CPEs, after every load refresh. */
  advisor: Advisor;
  optimizer: Optimizer;
  geocoder: Geocoder;
  telegram: Telegram;
  modules: Modules;
  oui: Oui;
  outages: Outages;
  dem: Dem;
  /** TINITALY terrain and WorldCover land cover imported by the admin (SRTM where missing). */
  terrain: TerrainStore;
  serverSettings: ServerSettings;
  notify: Notifier;
  version: string;
}
