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
  { key: 'compass', label: 'Trova l’AP (bussola e fotocamera)', area: 'app', description: 'AP vicini con distanza, azimut, altitudine e tilt; mappa, bussola con verifica di calibrazione e mirino in fotocamera.', default: true },
  { key: 'acceptance', label: 'Collaudo e verbale', area: 'web + app', description: 'Misure, foto e verbale di installazione salvati nel job.', default: true },
  { key: 'replacement', label: 'Sostituzione CPE', area: 'app', description: 'Nuova CPE con i dati del job sostituito (password PPPoE dal backup UISP).', default: true },
  { key: 'signal_history', label: 'Storico segnale', area: 'web + app', description: 'Andamento del segnale e interruzioni da UISP.', default: true },
  { key: 'config_drift', label: 'Confronto con il template', area: 'web', description: 'Modifiche fatte a mano sulla CPE rispetto alla configurazione CDA Net.', default: true },
  { key: 'cpe_health', label: 'Salute CPE', area: 'web + app', description: 'Stato delle CPE dei clienti: gli admin vedono tutte quelle in UISP e le assegnano agli installatori; ogni installatore vede le proprie e quelle assegnate.', default: false },
  { key: 'stats', label: 'Statistiche', area: 'web', description: 'Installazioni, collaudi e qualità per mese, installatore e modello.', default: true },
  { key: 'csv_export', label: 'Export CSV', area: 'web', description: 'Esportazione dello storico provisioning per Excel.', default: true },
  { key: 'network_tools', label: 'Strumenti di rete', area: 'web + app', description: 'Ping, traceroute, DNS, discovery, SNMP, TVCC, speed test, Wi-Fi analyzer.', default: true },
  { key: 'routeros', label: 'MikroTik · RouterOS', area: 'web + app', description: 'Consultazione in sola lettura di apparati RouterOS.', default: true },
  { key: 'power_outages', label: 'Guasti Enel', area: 'web + app', description: 'Guasti e lavori e-distribuzione nelle zone di interesse e attorno agli AP, con notifiche Telegram e sull’app.', default: false },
  { key: 'network_status', label: 'Stato rete', area: 'web + app', description: 'Stato di POP e AP (raggiungibili, CPE offline, guasti Enel vicini): installatori solo quelli assegnati, senza notifiche.', default: false },
  { key: 'work_orders', label: 'Agenda interventi', area: 'web + app', description: 'Interventi assegnati dall’ufficio con cliente, indirizzo e PPPoE già compilati: l’installatore li trova in Oggi e li avvia con un tocco.', default: true },
  { key: 'firmware_upgrade', label: 'Aggiornamento firmware', area: 'web + app', description: 'L’admin carica i firmware airOS di riferimento; l’installatore li scarica sul telefono e porta la CPE alla versione richiesta prima del provisioning.', default: false },
  { key: 'telegram', label: 'Notifiche Telegram', area: 'server', description: 'Gruppo del NOC e notifiche personali di ogni utente (bot in Connettori → Telegram).', default: true, global: true },
] as const;

export type ModuleKey = (typeof MODULES)[number]['key'];
const KEYS = new Set<string>(MODULES.map((m) => m.key));
/** Server-side features: not per user. */
const GLOBAL_ONLY = new Set<string>(MODULES.filter((m) => 'global' in m && m.global).map((m) => m.key));
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

  const overridesOf = (userId: number): Partial<Record<ModuleKey, boolean>> =>
    Object.fromEntries(
      (db.prepare('SELECT module, enabled FROM user_modules WHERE user_id = ?').all(userId) as Array<{ module: string; enabled: number }>)
        .filter((r) => isModuleKey(r.module) && !GLOBAL_ONLY.has(r.module))
        .map((r) => [r.module, !!r.enabled]),
    );

  /** Effective modules of a user: the user's override, else the global setting. */
  function stateFor(userId: number | undefined): Record<ModuleKey, boolean> {
    const s = state();
    return userId ? { ...s, ...overridesOf(userId) } : s;
  }

  return {
    state,
    stateFor,
    enabled,
    anyEnabled: (...keys: ModuleKey[]) => keys.some((k) => enabled(k)),

    list() {
      const s = state();
      const counts = new Map(
        (db.prepare('SELECT module, SUM(enabled = 1) on_count, SUM(enabled = 0) off_count FROM user_modules GROUP BY module').all() as Array<{ module: string; on_count: number; off_count: number }>).map((r) => [r.module, r]),
      );
      return MODULES.map((m) => ({ ...m, enabled: s[m.key], usersOn: counts.get(m.key)?.on_count ?? 0, usersOff: counts.get(m.key)?.off_count ?? 0 }));
    },

    /** Modules of one user for the admin page: global value, override (null = default), effective. */
    listFor(userId: number) {
      const s = state();
      const o = overridesOf(userId);
      return MODULES.filter((m) => !GLOBAL_ONLY.has(m.key)).map((m) => ({ key: m.key, label: m.label, area: m.area, global: s[m.key], override: o[m.key] ?? null, effective: o[m.key] ?? s[m.key] }));
    },

    setFor(userId: number, changes: Partial<Record<ModuleKey, boolean | null>>) {
      const del = db.prepare('DELETE FROM user_modules WHERE user_id = ? AND module = ?');
      const put = db.prepare(
        `INSERT INTO user_modules(user_id, module, enabled, updated_at) VALUES(?,?,?,?)
         ON CONFLICT(user_id, module) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
      );
      for (const [k, v] of Object.entries(changes)) {
        if (!isModuleKey(k) || GLOBAL_ONLY.has(k)) continue;
        if (v === null || v === undefined) del.run(userId, k);
        else put.run(userId, k, v ? 1 : 0, nowIso());
      }
    },

    update(changes: Partial<Record<ModuleKey, boolean>>, userId: number) {
      const next = { ...read(), ...changes };
      db.prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES('modules', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(JSON.stringify(next), nowIso(), userId);
      return state();
    },

    /** preHandler (after authentication): 404 when none of the given modules is enabled for the user. */
    require(...keys: ModuleKey[]) {
      return async (req: FastifyRequest, _reply: FastifyReply) => {
        const s = stateFor(req.user?.id);
        if (!keys.some((k) => s[k])) throw new HttpError(404, 'module_disabled', { module: keys[0] });
      };
    },
  };
}
export type Modules = ReturnType<typeof createModules>;
