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
  /** The console route (GET) with its query, from the validated arguments. */
  path(args: Record<string, unknown>): string;
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
];

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
