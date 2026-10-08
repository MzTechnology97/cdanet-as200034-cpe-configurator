import { normalizeTemplate, type PlaceholderName } from './systemcfg.ts';

/**
 * Turns a raw airOS backup (System → Back Up Configuration) into a profile
 * template: values that change per customer/deployment are replaced with
 * `${PLACEHOLDER}` tokens, everything else (radio, firewall, services…) is kept
 * exactly as configured on the lab CPE.
 */

interface Rule {
  key: RegExp;
  placeholder: PlaceholderName;
  secret?: boolean;
}

// airOS 8 key names. Order matters only for documentation; each line matches at most one rule.
const RULES: Rule[] = [
  { key: /^wireless\.\d+\.ssid$/, placeholder: 'SSID' },
  { key: /^wpasupplicant\.profile\.\d+\.network\.\d+\.ssid$/, placeholder: 'SSID' },
  { key: /^wpasupplicant\.profile\.\d+\.network\.\d+\.psk$/, placeholder: 'WPA2_PSK', secret: true },
  { key: /^ppp\.\d+\.name$/, placeholder: 'PPPOE_USER' },
  { key: /^ppp\.\d+\.password$/, placeholder: 'PPPOE_PASSWORD', secret: true },
  { key: /^ppp\.\d+\.mtu$/, placeholder: 'PPPOE_MTU' },
  { key: /^ppp\.\d+\.mru$/, placeholder: 'PPPOE_MRU' },
  { key: /^users\.1\.name$/, placeholder: 'CPE_USERNAME' },
  { key: /^users\.1\.password$/, placeholder: 'CPE_PASSWORD_HASH', secret: true },
  { key: /^snmp\.community$/, placeholder: 'SNMP_COMMUNITY', secret: true },
  { key: /^snmp\.contact$/, placeholder: 'SNMP_CONTACT' },
  { key: /^snmp\.location$/, placeholder: 'SNMP_LOCATION' },
  { key: /^resolv\.host\.1\.name$/, placeholder: 'DEVICE_NAME' },
  { key: /^httpd\.port$/, placeholder: 'HTTP_PORT' },
  { key: /^httpd\.https\.port$/, placeholder: 'HTTPS_PORT' },
  { key: /^sshd\.port$/, placeholder: 'SSH_PORT' },
  { key: /^pwdog\.host$/, placeholder: 'WATCHDOG_HOST' },
  { key: /^ntpclient\.\d+\.server$/, placeholder: 'NTP_SERVER' },
  { key: /^dhcpd\.1\.start$/, placeholder: 'DHCP_START' },
  { key: /^dhcpd\.1\.end$/, placeholder: 'DHCP_END' },
  { key: /^dhcpd\.1\.lease_time$/, placeholder: 'DHCP_LEASE' },
  { key: /^dhcpd\.1\.netmask$/, placeholder: 'LAN_NETMASK' },
];

// Keys that look like credentials: reported if they survive templating.
const SECRET_KEY = /(psk|passw|secret|passphrase|community|key)$/i;

export interface Replacement {
  line: number;
  key: string;
  placeholder: PlaceholderName;
  /** Original value, or a mask for secrets (never returned in clear). */
  original: string;
}

export interface AutoTemplateResult {
  template: string;
  replacements: Replacement[];
  warnings: string[];
  lanInterface: string | null;
}

const mask = (v: string) => (v ? `•••• (${v.length} caratteri)` : '(vuoto)');

export function autoTemplate(raw: string): AutoTemplateResult {
  const lines = normalizeTemplate(raw).split('\n');
  const kv = (l: string) => {
    const i = l.indexOf('=');
    return i > 0 && !l.startsWith('#') ? ([l.slice(0, i), l.slice(i + 1)] as const) : null;
  };
  const values = new Map<string, string>();
  for (const l of lines) {
    const p = kv(l);
    if (p) values.set(p[0], p[1]);
  }

  // LAN = interface served by the DHCP server (router mode); its netconf entry carries the LAN address.
  const lanDev = values.get('dhcpd.1.devname') ?? null;
  let lanIndex: string | null = null;
  if (lanDev) {
    for (const [k, v] of values) {
      const m = /^netconf\.(\d+)\.devname$/.exec(k);
      if (m && v === lanDev) lanIndex = m[1] as string;
    }
  }
  const lanRules: Rule[] = lanIndex
    ? [
        { key: new RegExp(`^netconf\\.${lanIndex}\\.ip$`), placeholder: 'LAN_IP' },
        { key: new RegExp(`^netconf\\.${lanIndex}\\.netmask$`), placeholder: 'LAN_NETMASK' },
      ]
    : [];

  const replacements: Replacement[] = [];
  const warnings: string[] = [];
  const out = lines.map((l, i) => {
    const p = kv(l);
    if (!p) return l;
    const [key, value] = p;
    if (value.includes('${')) return l; // already a template line
    if (/^wss:\/\//i.test(value)) {
      replacements.push({ line: i + 1, key, placeholder: 'UISP_ENROLLMENT', original: mask(value) });
      return `${key}=\${UISP_ENROLLMENT}`;
    }
    const rule = [...RULES, ...lanRules].find((r) => r.key.test(key));
    if (!rule) return l;
    replacements.push({ line: i + 1, key, placeholder: rule.placeholder, original: rule.secret ? mask(value) : value });
    return `${key}=\${${rule.placeholder}}`;
  });

  const found = new Set(replacements.map((r) => r.placeholder));
  for (const [ph, what] of [
    ['SSID', 'SSID Station (wireless.1.ssid)'],
    ['WPA2_PSK', 'chiave WPA2 (wpasupplicant…psk)'],
    ['PPPOE_USER', 'utente PPPoE (ppp.1.name)'],
    ['PPPOE_PASSWORD', 'password PPPoE (ppp.1.password)'],
    ['CPE_PASSWORD_HASH', 'password admin (users.1.password)'],
  ] as const) {
    if (!found.has(ph)) warnings.push(`Non trovato: ${what}. Verifica che la CPE fosse configurata in Station + Router/PPPoE.`);
  }
  if (!lanIndex) warnings.push('Interfaccia LAN non individuata (dhcpd.1.devname): IP LAN lasciato invariato.');
  for (const l of out) {
    const p = kv(l);
    if (p && SECRET_KEY.test(p[0]) && p[1] && !p[1].includes('${') && !/^(enabled|disabled|\d+)$/.test(p[1])) {
      warnings.push(`Possibile segreto rimasto nel template: ${p[0]} (verifica che sia voluto).`);
    }
  }
  return { template: out.join('\n'), replacements, warnings, lanInterface: lanDev };
}
