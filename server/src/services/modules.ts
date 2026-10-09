import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../auth.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * Optional features ("Funzionalità"): an admin turns them on/off. A disabled module is hidden
 * in the web console and in the app, and its API answers 404 module_disabled. The core
 * (provisioning, history, airOS profiles, Wi-Fi keys, accounts, connectors, activity log) is
 * always on.
 */
export const MODULES = [
  { key: 'coverage', label: 'Copertura AP', area: 'web + app', description: 'AP più vicini da indirizzo o GPS, con direzione di puntamento (richiede UISP).', default: true },
  { key: 'field_alignment', label: 'Puntamento antenna', area: 'app', description: 'Segnale in tempo reale con bip, picco e segnale atteso.', default: true },
  { key: 'field_diagnosis', label: 'Diagnosi CPE', area: 'app', description: 'Controlli su segnale, cavo LAN, PPPoE e firmware con rapporto per il NOC.', default: true },
  { key: 'compass', label: 'Bussola verso l’AP', area: 'app', description: 'Direzione dell’AP con verifica di calibrazione e disturbi magnetici.', default: true },
  { key: 'acceptance', label: 'Collaudo e verbale', area: 'web + app', description: 'Misure, foto e verbale di installazione salvati nel job.', default: true },
  { key: 'replacement', label: 'Sostituzione CPE', area: 'app', description: 'Nuova CPE con i dati del job sostituito (password PPPoE dal backup UISP).', default: true },
  { key: 'signal_history', label: 'Storico segnale', area: 'web + app', description: 'Andamento del segnale e interruzioni da UISP.', default: true },
  { key: 'config_drift', label: 'Confronto con il template', area: 'web', description: 'Modifiche fatte a mano sulla CPE rispetto alla configurazione CDA Net.', default: true },
  { key: 'cpe_health', label: 'Salute CPE installate', area: 'web + app', description: 'Stato attuale e nel tempo delle CPE installate con l’app (ogni installatore vede le proprie).', default: false },
  { key: 'stats', label: 'Statistiche', area: 'web', description: 'Installazioni, collaudi e qualità per mese, installatore e modello.', default: true },
  { key: 'csv_export', label: 'Export CSV', area: 'web', description: 'Esportazione dello storico provisioning per Excel.', default: true },
  { key: 'network_tools', label: 'Strumenti di rete', area: 'web + app', description: 'Ping, traceroute, DNS, discovery, SNMP, TVCC, speed test, Wi-Fi analyzer.', default: true },
  { key: 'routeros', label: 'MikroTik · RouterOS', area: 'web + app', description: 'Consultazione in sola lettura di apparati RouterOS.', default: true },
  { key: 'telegram', label: 'Notifiche Telegram', area: 'server', description: 'Messaggi al gruppo del NOC (configurazione in Connettori).', default: true },
] as const;

export type ModuleKey = (typeof MODULES)[number]['key'];
const KEYS = new Set<string>(MODULES.map((m) => m.key));
export const isModuleKey = (k: string): k is ModuleKey => KEYS.has(k);

export function createModules(db: Db) {
  const read = (): Partial<Record<ModuleKey, boolean>> => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'modules'").get() as { value: string } | undefined;
    try {
      return r ? (JSON.parse(r.value) as Partial<Record<ModuleKey, boolean>>) : {};
    } catch {
      return {};
    }
  };

  function state(): Record<ModuleKey, boolean> {
    const o = read();
    return Object.fromEntries(MODULES.map((m) => [m.key, o[m.key] ?? m.default])) as Record<ModuleKey, boolean>;
  }

  const enabled = (k: ModuleKey) => state()[k];

  return {
    state,
    enabled,
    anyEnabled: (...keys: ModuleKey[]) => keys.some((k) => enabled(k)),

    list() {
      const s = state();
      return MODULES.map((m) => ({ ...m, enabled: s[m.key] }));
    },

    update(changes: Partial<Record<ModuleKey, boolean>>, userId: number) {
      const next = { ...read(), ...changes };
      db.prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES('modules', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(JSON.stringify(next), nowIso(), userId);
      return state();
    },

    /** preHandler: 404 when none of the given modules is enabled. */
    require(...keys: ModuleKey[]) {
      return async (_req: FastifyRequest, _reply: FastifyReply) => {
        if (!keys.some((k) => enabled(k))) throw new HttpError(404, 'module_disabled', { module: keys[0] });
      };
    },
  };
}
export type Modules = ReturnType<typeof createModules>;
