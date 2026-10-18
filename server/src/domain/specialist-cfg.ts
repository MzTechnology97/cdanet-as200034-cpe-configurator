import { assertSingleLine, normalizeTemplate, PLACEHOLDERS, setKey, type PlaceholderName } from './systemcfg.ts';

/**
 * The airOS templates of the specialist (owner, 17/10/2026): his own archive for the companies he
 * works for, apart from CDA Net's. The text is the whole truth: no value forced by the server, no
 * CDA Net rule (a VLAN is allowed, any SSID, any PPPoE user), and besides the placeholders CDA Net
 * knows the specialist may write his own (`${VLAN_ID}`, `${LAN_IP}`…): their value is typed for
 * each CPE, like the Wi-Fi key, and never stored.
 */

const TOKEN_RX = /\$\{([A-Z0-9_]+)\}/g;
/** A placeholder of his own: capital letters, digits and _, starting with a letter. */
export const OWN_PLACEHOLDER_RX = /^[A-Z][A-Z0-9_]{0,31}$/;
const MAX_TEMPLATE = 300_000;
/**
 * A key or a password written in clear in the text (Wi-Fi, PPPoE, SNMP, UISP, the admin's hash):
 * the members of his work groups read the text (issue #275), the template's sealed secrets they do not.
 */
const SECRET_IN_CLEAR = /^(?:wpasupplicant\.profile\.\d+\.network\.\d+\.psk|aaa\.\d+\.wpa\.psk|ppp\.\d+\.password|snmp\.community|unms\.uri|users\.\d+\.password)=(?!.*\$\{).+$/m;

export interface FreeTemplateReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Every placeholder of the text, sorted. */
  placeholders: string[];
  /** The ones CDA Net does not know: typed for each CPE. */
  own: string[];
  /** The ones this template does not need, never asked (PPPoE in bridge, see unusedPlaceholders). */
  unused: string[];
  lines: number;
}

export function inspectFreeTemplate(raw: string): FreeTemplateReport {
  const template = normalizeTemplate(raw);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (template.length < 64 || template.length > MAX_TEMPLATE) errors.push('template_size');
  const sections = new Set([...template.matchAll(/^(radio|wireless|netconf|users)\./gm)].map((m) => m[1]));
  if (sections.size < 2) errors.push('profile_not_system_cfg');
  if (template.includes('\0')) errors.push('profile_contains_nul');
  const found = new Set<string>();
  for (const m of template.matchAll(TOKEN_RX)) found.add(m[1] as string);
  const placeholders = [...found].sort();
  if (placeholders.some((p) => !OWN_PLACEHOLDER_RX.test(p))) errors.push('invalid_placeholders');
  if (placeholders.length > 40) errors.push('too_many_placeholders');
  // the clear password in users.N.password: airOS wants its MD5-crypt hash there
  if (/^users\.\d+\.password=\$\{CPE_PASSWORD\}$/m.test(template)) errors.push('users_password_requires_hash_placeholder');
  for (const line of template.split('\n')) {
    if (line && !line.startsWith('#') && !/^[A-Za-z0-9_.-]+=/.test(line)) {
      warnings.push('non_key_value_lines');
      break;
    }
  }
  if (SECRET_IN_CLEAR.test(template)) warnings.push('literal_secrets');
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    placeholders,
    own: placeholders.filter((p) => !(p in PLACEHOLDERS)),
    unused: [...unusedPlaceholders(template)].sort(),
    lines: template.split('\n').length,
  };
}

/**
 * How the specialist fills each placeholder CDA Net knows. [from]: typed for each CPE (`typed`), or
 * filled by the server: the CPE found by the discovery (`mac`, `serial`), the CPE's credentials
 * typed in the flow (`cpe`), the template's secrets (`template`: its SNMP community and the Wi-Fi
 * key of the AP, sealed, its author's) and the connector's UISP key (when set; else typed), the
 * device name for the SNMP location.
 */
export const SPECIALIST_PLACEHOLDERS: Record<PlaceholderName, { label: string; secret?: boolean; from: 'typed' | 'mac' | 'serial' | 'cpe' | 'template' | 'connector' | 'name' }> = {
  SSID: { label: 'SSID dell’AP', from: 'typed' },
  WPA2_PSK: { label: 'Chiave Wi-Fi (WPA2) dell’AP', secret: true, from: 'template' },
  PPPOE_USER: { label: 'Utente PPPoE', from: 'typed' },
  PPPOE_PASSWORD: { label: 'Password PPPoE', secret: true, from: 'typed' },
  UISP_ENROLLMENT: { label: 'Chiave UISP dell’azienda', secret: true, from: 'connector' },
  SNMP_COMMUNITY: { label: 'Community SNMP', secret: true, from: 'template' },
  SNMP_LOCATION: { label: 'Location SNMP', from: 'name' },
  DEVICE_NAME: { label: 'Nome della CPE', from: 'typed' },
  CPE_USERNAME: { label: 'Utente admin della CPE', from: 'cpe' },
  CPE_PASSWORD: { label: 'Password admin della CPE', secret: true, from: 'cpe' },
  CPE_PASSWORD_HASH: { label: 'Password admin della CPE (MD5-crypt)', secret: true, from: 'cpe' },
  EXPECTED_MAC: { label: 'MAC della CPE', from: 'mac' },
  EXPECTED_SERIAL: { label: 'Seriale della CPE', from: 'serial' },
};

/**
 * The placeholders of a template the specialist types for each CPE (and whether to hide them).
 * [unused]: the ones this template does not need (PPPoE in bridge). [optional]: may stay empty.
 */
export function askedFor(placeholders: string[], filled: { snmpCommunity: boolean; wpa2Psk?: boolean; uispKey: boolean }, unused: ReadonlySet<string> = new Set()) {
  return placeholders
    .filter((p) => {
      if (unused.has(p)) return false;
      const known = SPECIALIST_PLACEHOLDERS[p as PlaceholderName];
      if (!known) return true;
      if (known.from === 'typed') return true;
      // the secrets kept in the template (its author's): the community, the Wi-Fi key of the AP
      if (known.from === 'template') return p === 'WPA2_PSK' ? !filled.wpa2Psk : !filled.snmpCommunity;
      if (known.from === 'connector') return !filled.uispKey;
      // the SNMP location is the device name: typed when the template has no ${DEVICE_NAME}
      if (known.from === 'name') return !placeholders.includes('DEVICE_NAME');
      return false;
    })
    .map((p) => {
      const known = SPECIALIST_PLACEHOLDERS[p as PlaceholderName];
      return {
        name: p,
        label: known?.label ?? p,
        secret: !!known?.secret || /PASS|PSK|SECRET|KEY|COMMUNITY/.test(p),
        own: !known,
        ...(OPTIONAL_PLACEHOLDERS.has(p) ? { optional: true } : {}),
      };
    });
}

/**
 * Placeholders the specialist may leave empty (titolare, 18/10/2026): the company's UISP key.
 * Without it the CPE is written with UISP off (`unms.status=disabled`).
 */
export const OPTIONAL_PLACEHOLDERS: ReadonlySet<string> = new Set(['UISP_ENROLLMENT']);

const PPPOE_PLACEHOLDERS = ['PPPOE_USER', 'PPPOE_PASSWORD'] as const;

/**
 * The placeholders a template does not need (titolare, 18/10/2026): a CPE in bridge cannot use
 * PPPoE (the customer's router dials it), nor one with PPPoE off, so its user and password are
 * not asked and their `ppp.*` lines stay empty. Only when they are used in `ppp.*` lines alone.
 */
export function unusedPlaceholders(raw: string): Set<string> {
  const lines = normalizeTemplate(raw).split('\n');
  const get = (key: string) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
  const out = new Set<string>();
  const noPppoe = get('netmode') === 'bridge' || get('ppp.status') === 'disabled' || get('ppp.1.status') === 'disabled';
  if (!noPppoe) return out;
  for (const p of PPPOE_PLACEHOLDERS) {
    const uses = lines.filter((l) => !l.startsWith('#') && l.includes(`\${${p}}`));
    if (uses.length && uses.every((l) => l.startsWith('ppp.'))) out.add(p);
  }
  return out;
}

/** A UISP key airOS takes: the «wss://…» of UISP → Impostazioni → Dispositivi. */
export const isUispKey = (v: string) => /^wss:\/\/\S+$/i.test(v);

/** A Wi-Fi key airOS takes: 8-63 printable characters, or 64 hex digits. */
export const isWpa2Key = (v: string) => /^[\x20-\x7e]{8,63}$/.test(v) || /^[0-9A-Fa-f]{64}$/.test(v);
/** An SSID: 1-32 bytes on one line. */
export const isSsid = (v: string) => v.length > 0 && Buffer.byteLength(v, 'utf8') <= 32 && !/[\r\n\0]/.test(v);

/**
 * The file written into the CPE: every placeholder replaced in one pass (a value that contains
 * `${…}` is never expanded again), then the keys of [extra] (the position of the installation).
 * Throws `missing_value_<NAME>` for a placeholder without a value, but those of [empty], which
 * stay empty (PPPoE in bridge, the UISP key not written).
 */
export function renderFreeCfg(raw: string, values: Record<string, string | undefined>, extra: Array<[string, string]> = [], empty: ReadonlySet<string> = new Set()): string {
  const report = inspectFreeTemplate(raw);
  if (!report.ok) throw new Error(report.errors[0]);
  for (const name of report.placeholders) {
    const value = values[name];
    if (value === undefined || value === '') {
      if (empty.has(name)) continue;
      throw new Error(`missing_value_${name}`);
    }
    assertSingleLine(name, value);
  }
  let cfg = normalizeTemplate(raw).replace(TOKEN_RX, (_m, name: string) => values[name] ?? '');
  for (const [key, value] of extra) cfg = setKey(cfg, key, value);
  return cfg;
}

/**
 * A CDA Net template copied into the specialist's archive: the values CDA Net forces at every
 * provisioning (watchdog, SNMP, EIRP, power control) become keys of the text, as the CPE got them;
 * its secrets (SNMP community, UISP key of CDA Net) never go with it.
 */
export function freeCopyOfCdaTemplate(text: string, params: { watchdogHost: string; snmpContact: string }): string {
  let out = normalizeTemplate(text);
  for (const [k, v] of [
    ['pwdog.status', 'enabled'],
    ['pwdog.host', params.watchdogHost],
    ['snmp.status', 'enabled'],
    ['snmp.contact', params.snmpContact],
    ['system.eirp.status', 'disabled'],
    ['radio.1.obey', 'disabled'],
    ['radio.1.atpc.sta.status', 'enabled'],
  ] as const) {
    out = setKey(out, k, v);
  }
  return out;
}
