import { session } from '../../lib/api';
import type { Facts } from '../../templates/form';

/**
 * The Specialist's section (owner, 17/10/2026): his templates, the connectors of the companies he
 * works for and his installations, apart from CDA Net's. The installations are made by the app
 * (the console never writes a CPE); here they are looked at, tested and authorized in UISP.
 */

export interface SpecTemplate {
  id: number;
  model: string;
  name: string;
  boardMatch: string;
  notes: string;
  sha256: string;
  facts: Facts & { sshPort?: number; httpPort?: number; httpsPort?: number };
  placeholders: string[];
  /** Placeholders of his own (not CDA Net's): typed for each CPE. */
  own: string[];
  secretsSet: { snmpCommunity: boolean };
  jobs: number;
  /** Who made it: himself or another specialist of his work groups (issue #275). */
  authorId: number;
  author: string;
  /** His own: he deletes it and sets its secrets (the others of the group type them). */
  mine?: boolean;
  createdAt: string;
  updatedAt: string;
  template?: string;
}

/** The current specialist (the work of the others of his groups is shared, issue #275). */
export const myId = (): number | null => session.get()?.user.id ?? null;

export interface SpecConnector {
  id: number;
  kind: string;
  name: string;
  url: string;
  enabled: boolean;
  ignoreTls: boolean;
  tokenSet: boolean;
  tokenHint: string;
  uispKeySet: boolean;
  lastTest: { at: string; ok: boolean; detail: string } | null;
  jobs: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpecAcceptance {
  verdict?: 'ok' | 'warn' | 'bad';
  radio?: { signal?: number; noise?: number; ccq?: number; txRate?: number; rxRate?: number; capacityDown?: number; capacityUp?: number; distanceM?: number; frequency?: number; channelWidth?: number; ssid?: string; apName?: string; apMac?: string };
  speedtest?: { downMbps: number; upMbps: number; pingMs?: number; jitterMs?: number; server?: string };
  heightM?: number;
  notes?: string;
  at?: string | null;
}

export interface SpecJob {
  id: string;
  /** Who installed it: himself or another specialist of his work groups (read only then). */
  authorId: number | null;
  author: string;
  createdAt: string;
  completedAt: string | null;
  status: 'prepared' | 'success' | 'failed';
  attempts: number;
  model: string;
  template: string;
  templateId: number | null;
  mac: string;
  serial: string;
  /** Prepared before connecting to the CPE: MAC and serial are read at the write (empty until then). */
  cpeAtWrite?: boolean;
  firmware: string;
  deviceName: string;
  ssid: string;
  pppoeUser: string;
  customer: string;
  notes: string;
  company: string;
  connector: { id: number; name: string } | null;
  location: { lat: number; lon: number; source: string } | null;
  stages: string[];
  detected: { firmware?: string; board?: string; mac?: string };
  error: string;
  acceptance: SpecAcceptance | null;
  uisp: { deviceId: string | null; siteId: string | null; site: string; authorizedAt: string | null; error: string };
}

export interface SpecSummary {
  templates: number;
  connectors: number;
  jobs30d: number;
  success30d: number;
  toAuthorize: number;
  failed30d: number;
}

/** How the specialist fills each placeholder CDA Net knows (from the server). */
export interface SpecPlaceholder {
  name: string;
  label: string;
  secret?: boolean;
  from: 'typed' | 'mac' | 'serial' | 'cpe' | 'template' | 'connector' | 'name';
}

export const FROM_TEXT: Record<SpecPlaceholder['from'], string> = {
  typed: 'scritto nell’app per ogni CPE',
  mac: 'dalla CPE trovata (discovery)',
  serial: 'dalla CPE trovata (discovery)',
  cpe: 'dalle credenziali scritte nell’app',
  template: 'dalla community del template, o scritta nell’app',
  connector: 'dal connettore UISP dell’azienda, o scritta nell’app',
  name: 'dal nome della CPE',
};

export const STATUS: Record<SpecJob['status'], [string, 'good' | 'bad' | 'neutral']> = {
  success: ['Scritta', 'good'],
  failed: ['Non riuscita', 'bad'],
  prepared: ['Preparata', 'neutral'],
};

export const VERDICT: Record<'ok' | 'warn' | 'bad', [string, 'good' | 'warn' | 'bad']> = {
  ok: ['Buono', 'good'],
  warn: ['Con riserva', 'warn'],
  bad: ['Non buono', 'bad'],
};

export const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
