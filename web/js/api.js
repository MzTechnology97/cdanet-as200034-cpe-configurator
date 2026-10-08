const KEY = 'cdaSession';

/** Human-readable messages for API error codes. */
const MESSAGES = {
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

export class ApiError extends Error {
  constructor(status, body) {
    const code = body?.error ?? `HTTP ${status}`;
    const detail = body?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
    super((MESSAGES[code] ?? code) + (detail ? ` (${detail})` : ''));
    this.status = status;
    this.body = body;
  }
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
