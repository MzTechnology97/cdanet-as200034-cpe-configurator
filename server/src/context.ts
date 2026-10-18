import type { Auth } from './auth.ts';
import type { Config } from './config.ts';
import type { Sealer } from './crypto.ts';
import type { Db } from './db.ts';
import type { Provisioning } from './services/provisioning.ts';
import type { Templates } from './services/templates.ts';
import type { Geocoder } from './services/geocode.ts';
import type { LoginGuard } from './services/login-guard.ts';
import type { Uisp } from './services/uisp.ts';
import type { Connectors } from './services/connectors.ts';
import type { CrmSettings } from './services/crm.ts';
import type { VrmSettings } from './services/victron.ts';
import type { MyWicSettings } from './services/mywic.ts';
import type { Nas } from './services/nas.ts';
import type { WorkGroups } from './services/work-groups.ts';
import type { PlatformHealth } from './services/platform-health.ts';
import type { ProactiveAlerts } from './services/proactive-alerts.ts';
import type { CoverageOps } from './services/coverage-operators.ts';
import type { VictronSync } from './services/victron-sync.ts';
import type { Imagery } from './services/imagery.ts';
import type { CrmSync } from './services/crm-sync.ts';
import type { Warehouse } from './services/warehouse.ts';
import type { Modules } from './services/modules.ts';
import type { Oui } from './services/oui.ts';
import type { Outages } from './services/outages.ts';
import type { Notifier } from './services/notify.ts';
import type { Telegram } from './services/telegram.ts';
import type { Dem } from './services/dem.ts';
import type { TerrainStore } from './services/terrain-store.ts';
import type { Antennas } from './services/antennas.ts';
import type { Anncsu } from './services/anncsu.ts';
import type { ApLoadService } from './services/ap-load.ts';
import type { Advisor } from './services/ap-advisor.ts';
import type { Optimizer } from './services/ap-optimizer.ts';
import type { Live } from './services/live.ts';
import type { Push } from './services/push.ts';
import type { ServerSettings } from './services/server-settings.ts';
import type { Specialist } from './services/specialist.ts';

export interface AppContext {
  cfg: Config;
  /** Live updates of the consoles (/api/events). */
  live: Live;
  /** Push notifications to the phones (Connettori → Firebase). */
  push: Push;
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
  /** Victron VRM connector: the solar and battery systems of the POPs (admins only, read only). */
  victron: VrmSettings;
  /** Multi-operator coverage (MyWic: FTTH, FTTC, FWA of the other operators), admins only, read only. */
  mywic: MyWicSettings;
  nas: Nas;
  workGroups: WorkGroups;
  /** «Salute piattaforma»: the state of every source, alerts to the NOC and the encrypted backup. */
  platformHealth: PlatformHealth;
  /** Alerts to the NOC before the customers call: signal drops, busy APs, POPs on battery. */
  proactive: ProactiveAlerts;
  /** The other operators' coverage at a point, grouped by AGCOM sticker, with its cache. */
  coverageOps: CoverageOps;
  /** The POPs' Victron systems read every 5 minutes and the POP each one powers. */
  victronSync: VictronSync;
  /** Aerial imagery for the admins' maps (Connettori → Immagini satellitari). */
  imagery: Imagery;
  /** RADIUS state copied from the CRM for the NOC (admins only). */
  crmSync: CrmSync;
  warehouse: Warehouse;
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
  /** Radiation patterns of the makers and the antenna, azimuth and tilt of every AP (admins). */
  antennas: Antennas;
  /** House numbers of ANNCSU with their coordinates (one region, area of the network). */
  anncsu: Anncsu;
  serverSettings: ServerSettings;
  notify: Notifier;
  /** Login attempts and bans (fail2ban-like). */
  loginGuard: LoginGuard;
  /** The specialist's own section: his templates, the connectors of his companies, his installations. */
  specialist: Specialist;
  version: string;
}
