/**
 * The tools an admin's own Claude can use (MCP connector): read-only views of the platform, each
 * one a GET route of the console run with that admin's rights. Nothing writes, nothing reaches a
 * CPE. What goes out is cleaned: never secrets, never contact details the monitoring does not need
 * (GDPR: data minimisation), long lists cut so the connector is no bulk export.
 */

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The console route with its query, from the validated arguments. */
  path(args: Record<string, unknown>): string;
  /** A write (GET otherwise): only for a connection given «lettura e scrittura» at the consent. */
  method?: 'POST' | 'PUT' | 'DELETE';
  body?(args: Record<string, unknown>): Record<string, unknown> | undefined;
  /** On the network (CPEs, UISP): the NOC hears of every call. */
  network?: boolean;
}

const str = (v: unknown, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const none = { type: 'object', properties: {}, additionalProperties: false };
const need = (v: unknown, what: string) => {
  if (v === undefined || v === null || v === '') throw new Error(`Manca ${what}.`);
  return v;
};
const id = (v: unknown, what: string) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} non valido.`);
  return n;
};
const enc = (v: unknown, what: string) => encodeURIComponent(String(need(v, what)).slice(0, 100));
/** Only the arguments the route takes, those given. */
const pick = (a: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const WO_FIELDS = {
  day: { type: 'string', description: 'Giorno AAAA-MM-GG' },
  slot: { type: 'string', description: 'Fascia oraria, es. 09:00-10:30' },
  kind: { type: 'string', enum: ['new', 'repoint', 'repair', 'survey'] },
  customer: { type: 'string', description: 'Cliente (COGNOME NOME o ragione sociale)' },
  address: { type: 'string' },
  contact: { type: 'string', description: 'Telefono o contatto' },
  pppoeUser: { type: 'string' },
  model: { type: 'string', description: 'Modello della CPE' },
  notes: { type: 'string', description: "Note per l'installatore" },
  assignedTo: { type: 'integer', description: "Id dell'installatore (strumento utenti)" },
};

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'stato_rete',
    title: 'Stato della rete',
    description: 'Stato attuale della rete: nodi, AP, link, apparati offline e CPE scollegate, come nella pagina Stato rete della console.',
    inputSchema: none,
    path: () => '/api/network/status',
  },
  {
    name: 'salute_piattaforma',
    title: 'Salute della piattaforma',
    description: "Ultimo esito di ogni collegamento della piattaforma (gestione rete, CRM, magazzino, notifiche, backup) con l'ora dell'ultimo controllo riuscito.",
    inputSchema: none,
    path: () => '/api/admin/platform/health',
  },
  {
    name: 'guasti_enel',
    title: 'Interruzioni di corrente',
    description: 'Interruzioni di corrente in corso e delle ultime 48 ore con i nodi e i clienti interessati; i POP con batteria o fuori rete sono segnalati.',
    inputSchema: none,
    path: () => '/api/outages?recent=true',
  },
  {
    name: 'batterie_pop',
    title: 'Batterie dei POP',
    description: 'Batterie e fotovoltaico dei POP: carica, stato, autonomia, POP fuori rete.',
    inputSchema: none,
    path: () => '/api/admin/victron',
  },
  {
    name: 'stato_uisp',
    title: 'Gestione rete',
    description: 'Stato della gestione della rete: raggiungibile, numero di apparati e di site.',
    inputSchema: none,
    path: () => '/api/admin/uisp/status',
  },
  {
    name: 'salute_cpe',
    title: 'Salute delle CPE',
    description: 'CPE installate con problemi: segnale basso o in calo, modulazione, airtime, disconnessioni.',
    inputSchema: none,
    path: () => '/api/cpe-health',
  },
  {
    name: 'diagnosi',
    title: 'Diagnosi remota',
    description: 'Diagnosi di un cliente o di un intervento: segnale e andamento della CPE, sessione PPPoE, AP e sue altre CPE, corrente, speedtest, con la causa probabile. Indicare uno tra workOrderId, mac, pppoeUser.',
    inputSchema: {
      type: 'object',
      properties: {
        workOrderId: { type: 'integer', minimum: 1, description: "Numero dell'intervento" },
        mac: { type: 'string', description: 'MAC della CPE' },
        pppoeUser: { type: 'string', description: 'Utente PPPoE del cliente' },
      },
      additionalProperties: false,
    },
    path: (a) => {
      const w = int(a.workOrderId, 1, 1e9);
      const m = str(a.mac, 40);
      const p = str(a.pppoeUser, 128);
      if (w === undefined && !m && !p) throw new Error('Indica workOrderId, mac oppure pppoeUser.');
      return `/api/admin/diagnosis${qs({ workOrderId: w, mac: m, pppoeUser: p })}`;
    },
  },
  {
    name: 'interventi',
    title: 'Interventi',
    description: 'Interventi pianificati e fatti in un periodo (giorni AAAA-MM-GG), con stato, tipo e installatore; senza date: quelli di oggi e in arretrato.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Dal giorno (AAAA-MM-GG)' },
        to: { type: 'string', description: 'Al giorno (AAAA-MM-GG)' },
        status: { type: 'string', description: 'Stati separati da virgola: open, started, done, postponed, cancelled' },
        kind: { type: 'string', enum: ['new', 'repoint', 'repair', 'survey'] },
        q: { type: 'string', description: 'Cerca per cliente o indirizzo' },
      },
      additionalProperties: false,
    },
    path: (a) => {
      const status = typeof a.status === 'string' && /^[a-z,]{1,80}$/.test(a.status) ? a.status : undefined;
      const kind = typeof a.kind === 'string' && ['new', 'repoint', 'repair', 'survey'].includes(a.kind) ? a.kind : undefined;
      return `/api/admin/work-orders${qs({ from: day(a.from), to: day(a.to), status, kind, q: str(a.q) })}`;
    },
  },
  {
    name: 'magazzino',
    title: 'Magazzino',
    description: 'Giacenze di CPE per magazzino e modello, chi è sotto la scorta minima, CPE installate ancora a magazzino.',
    inputSchema: none,
    path: () => '/api/admin/warehouse/overview',
  },
  {
    name: 'avvisi',
    title: 'Avvisi del NOC',
    description: "Gli ultimi avvisi ricevuti dall'admin: KO, collaudi da approvare, interruzioni, avvisi proattivi, salute della piattaforma.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Quanti (predefinito 30)' } },
      additionalProperties: false,
    },
    path: (a) => `/api/notifications${qs({ limit: int(a.limit, 1, 100) ?? 30 })}`,
  },
  {
    name: 'statistiche',
    title: 'Statistiche',
    description: 'Installazioni, collaudi ed esiti per mese e per installatore.',
    inputSchema: {
      type: 'object',
      properties: { months: { type: 'integer', minimum: 1, maximum: 36, description: 'Quanti mesi (predefinito 6)' } },
      additionalProperties: false,
    },
    path: (a) => `/api/admin/stats${qs({ months: int(a.months, 1, 36) })}`,
  },
  {
    name: 'report_mensile',
    title: 'Report mensile',
    description: 'Il report di un mese (AAAA-MM): installazioni, interventi, guasti, disponibilità della rete.',
    inputSchema: {
      type: 'object',
      properties: { month: { type: 'string', description: 'Mese AAAA-MM (predefinito: il mese scorso)' } },
      additionalProperties: false,
    },
    path: (a) => `/api/admin/reports/monthly${qs({ month: typeof a.month === 'string' && /^\d{4}-\d{2}$/.test(a.month) ? a.month : undefined })}`,
  },
  // ---- read: what the writes need (ids) ------------------------------------------------------
  {
    name: 'utenti',
    title: 'Utenti',
    description: 'Gli account della piattaforma (id, utente, ruolo, attivo): servono per assegnare un intervento.',
    inputSchema: none,
    path: () => '/api/admin/users',
  },
  {
    name: 'cpe',
    title: 'Dettaglio di una CPE',
    description: "Una CPE della rete per id di UISP (deviceId, dagli strumenti salute_cpe o diagnosi): stato, segnale, AP, firmware.",
    inputSchema: obj({ deviceId: { type: 'string' } }, ['deviceId']),
    path: (a) => `/api/admin/cpe/${enc(a.deviceId, 'deviceId')}`,
  },
  {
    name: 'rma',
    title: 'CPE smontate (RMA)',
    description: 'Le CPE tolte nelle sostituzioni: da riportare, rientrate, in riparazione, rottamate, riusate.',
    inputSchema: none,
    path: () => '/api/admin/rma?state=all',
  },
  {
    name: 'accessi_bloccati',
    title: 'Accessi bloccati',
    description: 'IP e dispositivi bloccati dopo tentativi di accesso falliti, con gli utenti tentati.',
    inputSchema: none,
    path: () => '/api/admin/bans',
  },
  {
    name: 'registro_accessi',
    title: 'Registro degli accessi',
    description: 'Gli ultimi tentativi di accesso (web, app, Claude): IP, utente, esito. Mai le password.',
    inputSchema: obj({ failed: { type: 'boolean', description: 'Solo i falliti' } }),
    path: (a) => `/api/admin/login-attempts${qs({ failed: a.failed === true ? 1 : undefined, limit: 100 })}`,
  },
  // ---- write: work orders -----------------------------------------------------------------------
  {
    name: 'crea_intervento',
    title: 'Crea un intervento',
    description: "Nuovo intervento in calendario. La password PPPoE non si passa da qui: si scrive dalla console o dall'app.",
    inputSchema: obj(WO_FIELDS, ['day', 'customer']),
    method: 'POST',
    path: () => '/api/admin/work-orders',
    body: (a) => pick(a, Object.keys(WO_FIELDS)),
  },
  {
    name: 'modifica_intervento',
    title: 'Modifica o sposta un intervento',
    description: "Cambia giorno, ora, installatore o dati di un intervento; status open/postponed/cancelled per riaprirlo, rimandarlo o annullarlo.",
    inputSchema: obj({ id: { type: 'integer' }, ...WO_FIELDS, status: { type: 'string', enum: ['open', 'postponed', 'cancelled'] } }, ['id']),
    method: 'PUT',
    path: (a) => `/api/admin/work-orders/${id(a.id, 'id intervento')}`,
    body: (a) => pick(a, [...Object.keys(WO_FIELDS), 'status']),
  },
  {
    name: 'elimina_intervento',
    title: 'Elimina un intervento',
    description: "Toglie un intervento dal calendario (resta nello storico se ha già portato a un'installazione).",
    inputSchema: obj({ id: { type: 'integer' } }, ['id']),
    method: 'DELETE',
    path: (a) => `/api/admin/work-orders/${id(a.id, 'id intervento')}`,
  },
  // ---- write: NOC -------------------------------------------------------------------------------
  {
    name: 'decidi_collaudo',
    title: 'Approva o rifiuta un collaudo',
    description: 'Decisione del NOC su un collaudo in attesa (segnale scarso): approved o rejected, con una nota.',
    inputSchema: obj({ jobId: { type: 'string' }, decision: { type: 'string', enum: ['approved', 'rejected'] }, note: { type: 'string' } }, ['jobId', 'decision']),
    method: 'POST',
    path: (a) => `/api/admin/provisioning/jobs/${enc(a.jobId, 'jobId')}/review`,
    body: (a) => pick(a, ['decision', 'note']),
  },
  {
    name: 'forza_collaudo',
    title: 'Dichiara superato un collaudo',
    description: 'Il NOC dichiara superato un collaudo non superato, con il motivo (obbligatorio).',
    inputSchema: obj({ jobId: { type: 'string' }, note: { type: 'string', description: 'Il motivo' } }, ['jobId', 'note']),
    method: 'POST',
    path: (a) => `/api/admin/provisioning/jobs/${enc(a.jobId, 'jobId')}/acceptance/pass`,
    body: (a) => pick(a, ['note']),
  },
  {
    name: 'sblocca_accesso',
    title: 'Sblocca un accesso bloccato',
    description: 'Toglie subito il blocco di un IP o di un dispositivo (id dallo strumento accessi_bloccati).',
    inputSchema: obj({ id: { type: 'integer' } }, ['id']),
    method: 'DELETE',
    path: (a) => `/api/admin/bans/${id(a.id, 'id blocco')}`,
  },
  {
    name: 'revoca_connessione_claude',
    title: 'Revoca una connessione di Claude',
    description: 'Chiude una connessione di Claude alla piattaforma (anche questa).',
    inputSchema: obj({ id: { type: 'integer' } }, ['id']),
    method: 'DELETE',
    path: (a) => `/api/admin/mcp/connections/${id(a.id, 'id connessione')}`,
  },
  // ---- write: warehouse -------------------------------------------------------------------------
  {
    name: 'aggiorna_rma',
    title: 'Aggiorna una CPE smontata',
    description: 'Stato (to_return, returned, repair, scrapped, reused), condizione (working, broken, unknown) o nota di una CPE smontata.',
    inputSchema: obj(
      {
        id: { type: 'integer' },
        state: { type: 'string', enum: ['to_return', 'returned', 'repair', 'scrapped', 'reused'] },
        condition: { type: 'string', enum: ['working', 'broken', 'unknown'] },
        note: { type: 'string' },
      },
      ['id'],
    ),
    method: 'PUT',
    path: (a) => `/api/admin/rma/${id(a.id, 'id RMA')}`,
    body: (a) => pick(a, ['state', 'condition', 'note']),
  },
  // ---- write: the network (the NOC hears of every one) -------------------------------------------
  {
    name: 'riavvia_cpe',
    title: 'Riavvia una CPE',
    description: 'Riavvia la CPE: il cliente resta senza linea per 1-2 minuti.',
    inputSchema: obj({ deviceId: { type: 'string' } }, ['deviceId']),
    method: 'POST',
    path: (a) => `/api/admin/cpe/${enc(a.deviceId, 'deviceId')}/restart`,
    network: true,
  },
  {
    name: 'rileggi_cpe',
    title: 'Rileggi una CPE',
    description: 'Chiede alla CPE i dati aggiornati (nessun effetto sul cliente).',
    inputSchema: obj({ deviceId: { type: 'string' } }, ['deviceId']),
    method: 'POST',
    path: (a) => `/api/admin/cpe/${enc(a.deviceId, 'deviceId')}/refresh`,
    network: true,
  },
  {
    name: 'aggiorna_firmware_cpe',
    title: 'Aggiorna il firmware di una CPE',
    description: "Porta la CPE all'ultimo firmware: si riavvia, il cliente resta senza linea per qualche minuto.",
    inputSchema: obj({ deviceId: { type: 'string' } }, ['deviceId']),
    method: 'POST',
    path: (a) => `/api/admin/cpe/${enc(a.deviceId, 'deviceId')}/upgrade`,
    network: true,
  },
  {
    name: 'backup_cpe',
    title: 'Backup di una CPE',
    description: 'Fa un nuovo backup della configurazione della CPE.',
    inputSchema: obj({ deviceId: { type: 'string' } }, ['deviceId']),
    method: 'POST',
    path: (a) => `/api/admin/cpe/${enc(a.deviceId, 'deviceId')}/backups`,
    network: true,
  },
  {
    name: 'ripristina_backup_cpe',
    title: 'Ripristina un backup della CPE',
    description: 'Rimette sulla CPE una configurazione salvata: si riavvia.',
    inputSchema: obj({ deviceId: { type: 'string' }, backupId: { type: 'string' } }, ['deviceId', 'backupId']),
    method: 'POST',
    path: (a) => `/api/admin/cpe/${enc(a.deviceId, 'deviceId')}/backups/${enc(a.backupId, 'backupId')}/apply`,
    network: true,
  },
  {
    name: 'wifi_cpe',
    title: 'Cambia la radio di una CPE',
    description: 'SSID, potenza, ATPC, guadagno antenna, perdita cavo, ACK, larghezza di canale. Le chiavi Wi-Fi non si toccano da qui.',
    inputSchema: obj(
      {
        deviceId: { type: 'string' },
        ssid: { type: 'string' },
        txPower: { type: 'integer' },
        atpc: { type: 'boolean' },
        antennaGain: { type: 'number' },
        cableLoss: { type: 'number' },
        ackAuto: { type: 'boolean' },
        ackDistanceM: { type: 'number' },
        autoChannelWidth: { type: 'boolean' },
        channelWidth: { type: 'integer' },
      },
      ['deviceId'],
    ),
    method: 'PUT',
    path: (a) => `/api/admin/cpe/${enc(a.deviceId, 'deviceId')}/wireless`,
    body: (a) => pick(a, ['ssid', 'txPower', 'atpc', 'antennaGain', 'cableLoss', 'ackAuto', 'ackDistanceM', 'autoChannelWidth', 'channelWidth']),
    network: true,
  },
  {
    name: 'note_cpe',
    title: 'Nome, note e manutenzione di una CPE',
    description: 'Alias, nota e modalità manutenzione della CPE in UISP.',
    inputSchema: obj({ deviceId: { type: 'string' }, alias: { type: 'string' }, note: { type: 'string' }, maintenance: { type: 'boolean' } }, ['deviceId']),
    method: 'PUT',
    path: (a) => `/api/admin/cpe/${enc(a.deviceId, 'deviceId')}/meta`,
    body: (a) => pick(a, ['alias', 'note', 'maintenance']),
    network: true,
  },
  {
    name: 'autorizza_uisp',
    title: 'Autorizza in UISP la CPE di un\'installazione',
    description: "Accetta in UISP la CPE di un'installazione collaudata, nel site indicato o in quello del suo AP.",
    inputSchema: obj({ jobId: { type: 'string' }, siteId: { type: 'string' } }, ['jobId']),
    method: 'POST',
    path: (a) => `/api/admin/provisioning/jobs/${enc(a.jobId, 'jobId')}/uisp/authorize`,
    body: (a) => pick(a, ['siteId']),
    network: true,
  },
];

/** The tools of a connection: the reads always, the writes only with «lettura e scrittura». */
export const toolsFor = (canWrite: boolean) => MCP_TOOLS.filter((t) => canWrite || !t.method);

/** Secrets: never out, whatever the route returns. */
const SECRET = /(password|passwd|psk|secret|token|api_?key|app_?key|private_?key|ciphertext|sealed|credential|recovery)|^(wpa|totp|otp)|hash$/i;
/** Contact and identity details the monitoring does not need (GDPR, data minimisation). */
const PERSONAL = /^(phone|phones|telefono|mobile|cell|email|e_?mail|mail|contact|contacts|fiscal|fiscal_?code|codice_?fiscale|tax_?id|vat|piva|iban|birth|birth_?date|document)/i;

export const MAX_ITEMS = 200;
export const MAX_TEXT = 120_000;

/** The answer of a route made fit to leave the platform: no secrets, no contact details, short lists. */
export function sanitize(v: unknown, depth = 0): unknown {
  if (depth > 12) return '…';
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ITEMS).map((x) => sanitize(x, depth + 1));
    if (v.length > MAX_ITEMS) out.push(`… altri ${v.length - MAX_ITEMS} elementi non mostrati: restringi la ricerca`);
    return out;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET.test(k) || PERSONAL.test(k)) continue;
      out[k] = sanitize(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** The tool's text: compact JSON, cut when too long. */
export function toolText(v: unknown): string {
  const s = JSON.stringify(sanitize(v));
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… [risposta tagliata: restringi la ricerca]` : s;
}
