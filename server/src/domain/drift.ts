import { normalizeTemplate, type PlaceholderName } from './systemcfg.ts';

/**
 * Configuration drift: what changed on a CPE (from its UISP backup) compared with what CDA Net
 * configured (template + job values + enforced policy). Secrets are compared but never returned.
 */

export interface DriftItem {
  key: string;
  kind: 'changed' | 'missing' | 'secret_changed';
  expected?: string;
  actual?: string | null;
}

export interface DriftReport {
  compared: number;
  /** Template keys not comparable (salted hashes, passwords not kept by CDA Net). */
  skipped: number;
  /** Keys present on the CPE but not in the template. */
  extra: number;
  items: DriftItem[];
}

const TOKEN_RX = /\$\{([A-Z0-9_]+)\}/g;
/** Never shown: compared for equality only. */
const SECRET: ReadonlySet<string> = new Set(['WPA2_PSK', 'CPE_PASSWORD', 'UISP_ENROLLMENT', 'SNMP_COMMUNITY']);
/** Not comparable: salted hash, or a secret CDA Net does not keep. */
const UNCOMPARABLE: ReadonlySet<string> = new Set(['CPE_PASSWORD_HASH', 'PPPOE_PASSWORD']);
const SECRET_KEY_RX = /pass|psk|secret|community|enrollment|key/i;

export function parseCfg(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) m.set(line.slice(0, i).trim(), line.slice(i + 1));
  }
  return m;
}

export function configDrift(
  template: string,
  values: Partial<Record<PlaceholderName, string>>,
  enforced: Array<[string, string]>,
  actualCfg: string,
): DriftReport {
  const actual = parseCfg(actualCfg);
  const expected = new Map<string, { value: string; secret: boolean }>();
  const skipped = new Set<string>();
  for (const [key, raw] of parseCfg(normalizeTemplate(template))) {
    const names = [...raw.matchAll(TOKEN_RX)].map((m) => m[1] as string);
    if (names.some((n) => UNCOMPARABLE.has(n) || values[n as PlaceholderName] === undefined)) {
      skipped.add(key);
      continue;
    }
    const value = raw.replace(TOKEN_RX, (_m, n: string) => values[n as PlaceholderName] as string);
    expected.set(key, { value, secret: names.some((n) => SECRET.has(n)) || (names.length === 0 && SECRET_KEY_RX.test(key)) });
  }
  for (const [key, value] of enforced) expected.set(key, { value, secret: key === 'snmp.community' });

  const items: DriftItem[] = [];
  for (const [key, e] of expected) {
    const a = actual.get(key);
    if (a === undefined) items.push({ key, kind: 'missing', ...(e.secret ? {} : { expected: e.value }), actual: null });
    else if (a !== e.value) items.push(e.secret ? { key, kind: 'secret_changed' } : { key, kind: 'changed', expected: e.value, actual: a });
  }
  const extra = [...actual.keys()].filter((k) => !expected.has(k) && !skipped.has(k)).length;
  items.sort((x, y) => x.key.localeCompare(y.key));
  return { compared: expected.size, skipped: skipped.size, extra, items };
}
