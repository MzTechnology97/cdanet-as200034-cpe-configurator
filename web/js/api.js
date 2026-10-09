import { isAdminUser } from './terms.js';
const KEY = 'cdaSession';

/** Human-readable messages for API error codes. */
const MESSAGES = {
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
  uisp_tls_error: 'Certificato TLS di UISP non valido',
};

export const session = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || 'null');
    } catch {
      return null;
    }
  },
  set(s) {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  },
  clear() {
    sessionStorage.removeItem(KEY);
  },
};

/** Installers get neutral messages (no data sources, no module names). */
const INSTALLER_MESSAGES = {
  drift_no_backup: 'Nessun backup della CPE disponibile',
  drift_backup_unreadable: 'Il backup della CPE non è leggibile',
  pppoe_password_required: 'Password PPPoE necessaria (non recuperabile dalla CPE sostituita)',
  module_disabled: 'Funzione non disponibile per il tuo account',
  uisp_not_configured: 'Servizio non disponibile: contatta l’amministratore',
  uisp_tls_error: 'Servizio di rete non disponibile: contatta l’amministratore',
  uisp_unreachable: 'Servizio di rete non raggiungibile, riprova più tardi',
  uisp_auth_failed: 'Servizio di rete non disponibile: contatta l’amministratore',
  runtime_secret_missing: 'Configurazione del server incompleta: contatta l’amministratore',
};

export class ApiError extends Error {
  constructor(status, body) {
    const code = body?.error ?? `HTTP ${status}`;
    const detail = body?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
    const installer = !isAdminUser() && INSTALLER_MESSAGES[code];
    super(installer || (MESSAGES[code] ?? code) + (detail ? ` (${detail})` : ''));
    this.status = status;
    this.body = body;
  }
}

/** Authenticated file download (name from Content-Disposition). */
export async function download(url, fallbackName) {
  const r = await api(url, { raw: true });
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

export async function api(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
  const s = session.get();
  const h = { ...headers };
  if (s?.token) h.Authorization = `Bearer ${s.token}`;
  if (body !== undefined && !(body instanceof Uint8Array)) h['Content-Type'] = 'application/json';
  const r = await fetch(path, {
    method,
    headers: h,
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    cache: 'no-store',
  });
  if (raw) return r;
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/auth/login') {
    session.clear();
    window.dispatchEvent(new Event('cda:logout'));
  }
  if (!r.ok) throw new ApiError(r.status, data);
  return data;
}
