import { isAdminUser } from './terms';

/**
 * The API client of the console: the session token, the errors in Italian (neutral ones for the
 * installers), the session expiry and the admins who must set up two-step verification.
 */
const KEY = 'cdaSession';
const DEVICE_KEY = 'cdaDevice';
let device: string | null = null;

/**
 * A random id of this browser (UUID, kept in localStorage), sent as X-CDA-Device: after too many
 * failed logins the server blocks this device too, not only its address. Chosen by the browser,
 * so it only stops a console that keeps failing, never someone who changes it on purpose.
 */
export function deviceId(): string {
  if (device) return device;
  let id: string | null = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch {
    /* storage blocked: a new id for this page */
  }
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* kept for this page only */
    }
  }
  device = id;
  return id;
}

/** Human-readable messages for API error codes. */
const MESSAGES: Record<string, string> = {
  infra_agent_missing: 'Agente di aggiornamento non attivo: serve una volta l’installer per abilitarlo',
  infra_request_pending: 'C’è già una richiesta in corso: attendi l’esito',
  invalid_value: 'Valore non valido',
  nothing_to_apply: 'Nessuna modifica',
  invalid_credentials: 'Username o password non corretti',
  too_many_attempts: 'Troppi tentativi: riprova tra qualche minuto',
  unauthorized: 'Sessione scaduta: accedi di nuovo',
  forbidden: 'Operazione riservata agli amministratori',
  invalid_request: 'Dati non validi',
  username_exists: 'Username già esistente',
  last_admin: 'Deve restare almeno un amministratore attivo',
  cannot_demote_current_admin: 'Non puoi disabilitare o declassare il tuo account',
  profile_contains_vlan: 'Il profilo contiene una VLAN legacy: non consentito',
  profile_not_system_cfg: 'Il file non sembra un backup di configurazione airOS',
  unknown_placeholders: 'Il profilo contiene placeholder non riconosciuti',
  users_password_requires_hash_placeholder: 'users.N.password deve usare ${CPE_PASSWORD_HASH}',
  board_match_invalid_regex: 'Board match: espressione regolare non valida',
  target_non_privato: 'Target consentito solo su reti private/CGNAT',
  cidr_troppo_ampio: 'Scansione limitata a /24 o reti più piccole',
  rete_non_privata: 'Rete privata/CGNAT richiesta',
  template_not_allowed: 'Template non disponibile per il tuo account',
  template_audience_empty: 'Seleziona almeno un installatore',
  default_must_be_public: 'Il predefinito generale deve essere visibile a tutti gli installatori',
  template_user_not_found: 'Account selezionato inesistente',
  wrong_current_password: 'Password attuale non corretta',
  password_unchanged: 'La nuova password è uguale a quella attuale',
  password_contains_username: 'La password non può contenere il nome utente',
  telegram_bad_token: 'Token del bot Telegram rifiutato',
  telegram_unreachable: 'Telegram non raggiungibile dal server',
  telegram_error: 'Telegram ha rifiutato la richiesta (chat ID corretto? il bot è nel gruppo?)',
  drift_no_backup: 'Nessun backup UISP della CPE: premi prima "Backup ora"',
  drift_backup_unreadable: 'Il backup UISP non è una configurazione airOS leggibile',
  drift_template_missing: 'Il template usato per questa CPE non esiste più',
  pppoe_password_required: 'Password PPPoE necessaria (non recuperabile dal backup UISP)',
  replace_same_mac: 'La CPE nuova ha lo stesso MAC di quella sostituita',
  job_not_completed: 'Il provisioning non risulta completato',
  too_many_photos: 'Troppe foto per questo job',
  photo_not_jpeg: 'La foto deve essere in formato JPEG',
  privacy_changed: 'L’informativa è cambiata: ricarica e rileggila',
  privacy_not_configured: 'Informativa privacy non ancora completata dall’amministratore',
  firmware_invalid: 'Il file non è un firmware airOS (.bin ufficiale Ubiquiti)',
  firmware_exists: 'Questo firmware è già stato caricato',
  firmware_not_found: 'Firmware non trovato',
  firmware_content_type: 'Caricamento non valido: riprova scegliendo il file .bin',
  mfa_expired: 'Tempo scaduto: ripeti l’accesso',
  invalid_code: 'Codice non valido',
  mfa_setup_required: 'Attiva la verifica in due passaggi in "Il mio account"',
  totp_required_by_policy: 'Obbligatoria per gli amministratori: non si può disattivare',
  totp_setup_missing: 'Ricomincia l’attivazione',
  totp_not_enabled: 'Verifica in due passaggi non attiva',
  enable_totp_first: 'Attiva prima la verifica in due passaggi sul tuo account',
  module_disabled: 'Funzionalità disattivata dall’amministratore',
  connector_incomplete: 'Servono indirizzo UISP e token',
  uisp_not_configured: 'UISP non configurato (Connettori)',
  basemap_missing: 'Mappa base non installata sul server (sudo cdanet-cpe map update)',
  uisp_tls_error: 'Certificato TLS di UISP non valido',
  optimizer_disabled: 'Ottimizzazione automatica spenta: Impostazioni server → Assistente rete',
  finding_not_optimizable: 'Questo avviso non si risolve cambiando il canale dell’AP',
  finding_without_channel: 'L’avviso non ha un canale consigliato: usa “Cerca il canale migliore”',
  already_scheduled: 'C’è già un’ottimizzazione programmata o in corso per questo AP',
  advisor_data_missing: 'Dati dell’analisi non ancora pronti: premi Aggiorna ora e riprova tra due minuti',
  no_candidates: 'Nessun canale candidato dentro la banda consentita',
  not_cancellable: 'Questa ottimizzazione non si può più annullare',
  acceptance_already_passed: 'Il collaudo risulta già superato',
  acceptance_not_found: 'Collaudo non ancora inviato dall’app',
  warehouse_not_found: 'Magazzino non trovato nell’ultima lettura: aggiornalo in Magazzino e riprova',
  cpe_not_in_stock: 'La CPE non risulta nel magazzino del tecnico',
  saved_check_not_found: 'Verifica salvata non trovata: forse è stata eliminata',
  customer_not_found: 'Cliente non trovato tra quelli di ISP Billing: aggiorna i clienti e riprova',
  invalid_position: 'Posizione non valida',
  saved_check_unreadable: 'La verifica salvata non si può leggere: rifalla e salvala di nuovo',
  // Specialist
  template_not_found: 'Template non trovato: forse è stato eliminato',
  template_name_exists: 'Esiste già un template con questo nome per il modello',
  template_model_mismatch: 'Il template è di un altro modello di CPE',
  template_size: 'Dimensione non valida (minimo 64 caratteri)',
  invalid_placeholders: 'Segnaposto non validi: usa ${NOME} con lettere maiuscole, cifre e _',
  too_many_placeholders: 'Troppi segnaposto (al massimo 40)',
  template_secret_invalid_snmpCommunity: 'Community SNMP non valida',
  template_secrets_author_only: 'Community SNMP e chiave Wi-Fi le imposta solo chi ha creato il template: nelle tue installazioni le scrivi nell’app',
  template_secret_invalid_wpa2Psk: 'Chiave Wi-Fi non valida: da 8 a 63 caratteri, oppure 64 cifre esadecimali',
  template_author_only: 'Questo template lo modifica solo chi l’ha creato',
  form_invalid_ssid: 'SSID non valido: al massimo 32 caratteri',
  connector_not_found: 'Connettore non trovato: forse è stato eliminato',
  connector_name_exists: 'Esiste già un connettore con questo nome',
  connector_target_not_public: 'Indirizzo non ammesso: l’UISP dell’azienda deve essere su Internet, non su una rete privata',
  connector_url_invalid: 'Indirizzo non valido: https://nome[:porta], senza ? né #',
  connector_disabled: 'Connettore disattivato: riattivalo per usarlo',
  uisp_key_invalid: 'La chiave UISP deve iniziare con wss:// (UISP → Impostazioni → Dispositivi)',
  uisp_auth_failed: 'Token UISP rifiutato',
  uisp_unreachable: 'UISP non raggiungibile dal server',
  uisp_error: 'UISP ha risposto con un errore',
  uisp_device_not_found: 'La CPE non è ancora in UISP (ricerca per MAC): dopo il riavvio può servire qualche minuto',
  uisp_already_authorized: 'La CPE è già autorizzata in UISP',
  uisp_site_unknown: 'Site dell’AP non determinabile: scegli il site',
  job_not_found: 'Installazione non trovata',
  job_without_connector: 'Installazione senza connettore UISP',
  job_already_completed: 'Installazione già completata',
  target_not_private: 'L’indirizzo della CPE deve essere privato',
};

export interface StoredSession {
  token: string;
  user: { id: number; username: string; role: string; fullView?: boolean };
  expiresAt: string;
  /**
   * Opened with the password and the two-step code, «Resta connesso» on (titolare, 17/10/2026):
   * kept in this browser beyond its closing until it expires (30 days), else only in this tab.
   */
  remember?: boolean;
}

const read = (store: Storage): StoredSession | null => {
  try {
    return JSON.parse(store.getItem(KEY) || 'null') as StoredSession | null;
  } catch {
    return null;
  }
};
const expired = (s: StoredSession) => !!s.expiresAt && Date.parse(s.expiresAt) <= Date.now();
function clearStored(): void {
  sessionStorage.removeItem(KEY);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
}

export const session = {
  /** The tab's own session first, then the one kept in the browser (dropped once expired). */
  get(): StoredSession | null {
    const tab = read(sessionStorage);
    if (tab && !expired(tab)) return tab;
    const kept = (() => {
      try {
        return read(localStorage);
      } catch {
        return null;
      }
    })();
    if (kept && expired(kept)) {
      clearStored();
      return null;
    }
    return kept ?? tab;
  },
  set(s: StoredSession): void {
    try {
      if (s.remember) {
        localStorage.setItem(KEY, JSON.stringify(s));
        sessionStorage.removeItem(KEY);
        return;
      }
      localStorage.removeItem(KEY);
    } catch {
      /* no browser storage (private window): the tab keeps it */
    }
    sessionStorage.setItem(KEY, JSON.stringify(s));
  },
  /**
   * No [token] (Esci): from this tab and from the browser, the other tabs follow (see App).
   * [token] (a session the server refused): only where that one is kept, never another account's.
   */
  clear(token?: string): void {
    if (token === undefined) return clearStored();
    if (read(sessionStorage)?.token === token) sessionStorage.removeItem(KEY);
    try {
      if (read(localStorage)?.token === token) localStorage.removeItem(KEY);
    } catch {
      /* nothing kept */
    }
  },
  /** The key in the browser's storage (the tabs listen to its changes). */
  key: KEY,
};

/** Installers get neutral messages (no data sources, no module names). */
const INSTALLER_MESSAGES: Record<string, string> = {
  drift_no_backup: 'Nessun backup della CPE disponibile',
  drift_backup_unreadable: 'Il backup della CPE non è leggibile',
  pppoe_password_required: 'Password PPPoE necessaria (non recuperabile dalla CPE sostituita)',
  module_disabled: 'Funzione non disponibile per il tuo account',
  uisp_not_configured: 'Servizio non disponibile: contatta l’amministratore',
  uisp_tls_error: 'Servizio di rete non disponibile: contatta l’amministratore',
  uisp_unreachable: 'Servizio di rete non raggiungibile, riprova più tardi',
  uisp_auth_failed: 'Servizio di rete non disponibile: contatta l’amministratore',
  runtime_secret_missing: 'Configurazione del server incompleta: contatta l’amministratore',
  uisp_device_not_found: 'La CPE non è ancora visibile in rete: riprova tra qualche minuto',
  uisp_already_authorized: 'La CPE è già attiva in rete',
};

/** Error codes that name a data source (UISP, the CRM/ISPBilling, e-distribuzione, the warehouse reading). */
const SOURCE_CODE = /^(uisp|crm|ispbilling|edist|outages_source|warehouse_sync|imagery|firebase|vrm|victron|mywic|operators)_/;

export interface ApiErrorBody {
  error?: string;
  issues?: Array<{ path: string; message: string }>;
  [k: string]: unknown;
}

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    const code = body?.error ?? `HTTP ${status}`;
    const detail = body?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
    // installers never see the data sources: a code of UISP, the CRM or the other sources without
    // its own neutral message becomes a generic one
    const installer = !isAdminUser() && (INSTALLER_MESSAGES[code] ?? (SOURCE_CODE.test(code) ? 'Servizio non disponibile: contatta l’amministratore' : undefined));
    // the CPE is in a warehouse, but not the installer's one
    const elsewhere = code === 'cpe_not_in_stock' && body?.result === 'other_warehouse' ? 'La CPE è in un altro magazzino, non in quello del tecnico' : '';
    const until = typeof body?.until === 'string' ? new Date(body.until) : null;
    const banned =
      code === 'banned'
        ? `Troppi accessi non riusciti: accesso bloccato${until && !Number.isNaN(until.getTime()) ? ` fino alle ${until.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}${until.toDateString() !== new Date().toDateString() ? ` del ${until.toLocaleDateString('it-IT')}` : ''}` : ''}. Se è un errore chiedi a un amministratore di sbloccarti.`
        : '';
    super(banned || elsewhere || installer || (MESSAGES[code] ?? code) + (detail ? ` (${detail})` : ''));
    this.status = status;
    this.body = body;
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  raw?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function call(path: string, { method = 'GET', body, raw = false, headers = {}, signal }: ApiOptions = {}): Promise<unknown> {
  const s = session.get();
  const h: Record<string, string> = { 'X-CDA-Device': deviceId(), ...headers };
  if (s?.token) h.Authorization = `Bearer ${s.token}`;
  if (body !== undefined && !(body instanceof Uint8Array)) h['Content-Type'] = 'application/json';
  const r = await fetch(path, {
    method,
    headers: h,
    body: body === undefined ? undefined : body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
    cache: 'no-store',
    signal,
  });
  if (raw) return r;
  const data = (await r.json().catch(() => ({}))) as ApiErrorBody;
  // the session was refused (expired, revoked): it ends here; a wrong code at the login is not one
  if (r.status === 401 && path !== '/api/auth/login' && s?.token) {
    session.clear(s.token);
    window.dispatchEvent(new Event('cda:logout'));
  }
  if (!r.ok) throw new ApiError(r.status, data);
  return data;
}

/**
 * A request to the server with the session. [raw] gives the Response itself (files, images).
 * An admin without two-step verification, when it is required, may only set it up: every other
 * request is refused with mfa_setup_required, and the console takes them to Il mio account.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, opts?: ApiOptions): Promise<T> {
  try {
    return (await call(path, opts)) as T;
  } catch (e) {
    if ((e as ApiError).body?.error === 'mfa_setup_required' && !location.hash.startsWith('#/account')) location.hash = '#/account';
    throw e;
  }
}

/**
 * «Esci»: the server closes this session (with the two-step code it would last 30 days), then
 * this tab and the browser forget it. Best effort: without Internet the session still goes from here.
 */
export function endSession(): void {
  const s = session.get();
  if (s?.token) {
    void fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json', 'X-CDA-Device': deviceId() },
      body: '{}',
      cache: 'no-store',
      keepalive: true,
    }).catch(() => {});
  }
  session.clear();
}

/** Authenticated file download (name from Content-Disposition). */
export async function download(url: string, fallbackName: string) {
  const r = await api<Response>(url, { raw: true });
  if (!r.ok) throw new Error(`Download non riuscito (HTTP ${r.status})`);
  const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
