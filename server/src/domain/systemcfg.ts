import { containsLegacyVlan } from './policy.ts';

/**
 * airOS `system.cfg` handling. Profiles are real lab exports (airOS 8.7.4) in
 * which the variable values have been replaced by `${PLACEHOLDER}` tokens.
 * The server renders the final file; clients only transfer and persist it.
 */

export const PLACEHOLDERS = {
  SSID: 'SSID Station CDA Net',
  WPA2_PSK: 'Chiave WPA2 dell’SSID (cifrata nel DB)',
  PPPOE_USER: 'Username RADIUS/PPPoE',
  PPPOE_PASSWORD: 'Password PPPoE (transitoria)',
  HTTP_PORT: 'Porta HTTP management (20080)',
  HTTPS_PORT: 'Porta HTTPS management (20443)',
  UISP_ENROLLMENT: 'Chiave UISP (runtime secret)',
  SNMP_COMMUNITY: 'Community SNMP v2c',
  SNMP_CONTACT: 'Contatto SNMP',
  SNMP_LOCATION: 'Location SNMP (COGNOME NOME)',
  DEVICE_NAME: 'Device Name (COGNOME NOME)',
  CPE_USERNAME: 'Username admin CPE',
  CPE_PASSWORD: 'Password admin CPE in chiaro (NON usare in users.N.password)',
  CPE_PASSWORD_HASH: 'Password admin CPE in formato MD5-crypt per users.N.password',
  EXPECTED_MAC: 'MAC atteso della CPE',
  EXPECTED_SERIAL: 'Seriale atteso della CPE',
  LAN_IP: 'IP LAN',
  LAN_NETMASK: 'Netmask LAN',
  DHCP_START: 'Inizio pool DHCP',
  DHCP_END: 'Fine pool DHCP',
  DHCP_LEASE: 'Lease DHCP (s)',
  PPPOE_MTU: 'MTU PPPoE',
  PPPOE_MRU: 'MRU PPPoE',
  WATCHDOG_HOST: 'Host watchdog',
  NTP_SERVER: 'Server NTP',
  SSH_PORT: 'Porta SSH',
  DISCOVERY_PORT: 'Porta discovery',
} as const;
export type PlaceholderName = keyof typeof PLACEHOLDERS;

const TOKEN_RX = /\$\{([A-Z0-9_]+)\}/g;
const MAX_TEMPLATE = 300_000;

export interface TemplateReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  placeholders: string[];
  unknownPlaceholders: string[];
  lines: number;
}

export function normalizeTemplate(template: string): string {
  return template.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function inspectTemplate(raw: string): TemplateReport {
  const template = normalizeTemplate(raw);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (template.length < 64 || template.length > MAX_TEMPLATE) errors.push('template_size');
  if (!/^system\.cfg\.version=/m.test(template)) errors.push('profile_not_system_cfg');
  if (containsLegacyVlan(template)) errors.push('profile_contains_vlan');
  if (template.includes('\0')) errors.push('profile_contains_nul');

  const found = new Set<string>();
  for (const m of template.matchAll(TOKEN_RX)) found.add(m[1] as string);
  const placeholders = [...found].sort();
  const unknownPlaceholders = placeholders.filter((p) => !(p in PLACEHOLDERS));
  if (unknownPlaceholders.length) errors.push('unknown_placeholders');

  for (const required of ['SSID', 'WPA2_PSK', 'PPPOE_USER', 'PPPOE_PASSWORD'] as const) {
    if (!found.has(required)) warnings.push(`missing_placeholder_${required}`);
  }
  if (/^users\.\d+\.password=\$\{CPE_PASSWORD\}$/m.test(template)) {
    errors.push('users_password_requires_hash_placeholder');
  }
  for (const line of template.split('\n')) {
    if (line && !line.startsWith('#') && !/^[A-Za-z0-9_.-]+=/.test(line)) {
      warnings.push('non_key_value_lines');
      break;
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    placeholders,
    unknownPlaceholders,
    lines: template.split('\n').length,
  };
}

export function assertSingleLine(name: string, value: string): string {
  if (value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(`invalid_value_${name}`);
  return value;
}

/** Replace or append `key=value`, keeping the original position when present. */
export function setKey(cfg: string, key: string, value: string): string {
  assertSingleLine(key, value);
  const rows = cfg.split('\n');
  let found = false;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] as string).startsWith(`${key}=`)) {
      rows[i] = `${key}=${value}`;
      found = true;
    }
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  if (!found) rows.push(`${key}=${value}`);
  return `${rows.join('\n')}\n`;
}

export interface RenderOptions {
  values: Partial<Record<PlaceholderName, string>>;
  /** Policy keys forced regardless of the template content, applied in order. */
  enforced: Array<[string, string]>;
}

export function renderSystemCfg(raw: string, opts: RenderOptions): string {
  const report = inspectTemplate(raw);
  if (!report.ok) throw new Error(report.errors[0]);
  for (const name of report.placeholders) {
    const value = opts.values[name as PlaceholderName];
    if (value === undefined || value === '') throw new Error(`missing_value_${name}`);
    assertSingleLine(name, value);
  }
  // Single pass: a value that happens to contain `${...}` is never re-expanded.
  let cfg = normalizeTemplate(raw).replace(TOKEN_RX, (_m, name: string) => opts.values[name as PlaceholderName] as string);
  for (const [key, value] of opts.enforced) cfg = setKey(cfg, key, value);
  if (containsLegacyVlan(cfg)) throw new Error('profile_contains_vlan');
  return cfg;
}
