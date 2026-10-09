import { DISTRICT_RANGE, NODE_RANGE, SSID_RX, ssidFor } from './policy.ts';

/**
 * Bulk WPA2 keys from CSV. Accepted headers (case-insensitive, any order):
 *   nodo;distretto;wpa2        (SSID derived: CDA-NET-N{nodo}-D{distretto})
 *   ssid;wpa2
 *   nodo;distretto;ssid;wpa2   (ssid must match nodo/distretto)
 * Separator ';' (Excel, Italian locale) or ','. Quoted fields allowed ("a;b", "a""b").
 */

export interface WirelessRow {
  line: number;
  ssid: string;
  wpa2: string;
}
export interface CsvError {
  line: number;
  error: string;
}

export const WPA2_RX = /^[\x20-\x7e]{8,63}$/;

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseWirelessCsv(text: string): { rows: WirelessRow[]; errors: CsvError[] } {
  const table = parseCsv(text);
  const errors: CsvError[] = [];
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, ''));
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iNode = col('nodo', 'node', 'n');
  const iDistrict = col('distretto', 'district', 'd');
  const iSsid = col('ssid');
  const iWpa = col('wpa2', 'psk', 'chiave', 'password', 'wpa2password');
  if (iWpa < 0 || (iSsid < 0 && (iNode < 0 || iDistrict < 0))) {
    return { rows: [], errors: [{ line: 1, error: 'Intestazione non valida: servono le colonne nodo;distretto;wpa2 oppure ssid;wpa2' }] };
  }
  const rows: WirelessRow[] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    if (cells.every((c) => c.trim() === '')) return; // blank line
    const get = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '');
    let ssid = get(iSsid).toUpperCase();
    if (iNode >= 0 && iDistrict >= 0 && (get(iNode) || get(iDistrict))) {
      const n = Number(get(iNode));
      const d = Number(get(iDistrict));
      if (!Number.isInteger(n) || n < NODE_RANGE.min || n > NODE_RANGE.max) {
        errors.push({ line, error: `Nodo non valido "${get(iNode)}" (${NODE_RANGE.min}-${NODE_RANGE.max})` });
        return;
      }
      if (!Number.isInteger(d) || d < DISTRICT_RANGE.min || d > DISTRICT_RANGE.max) {
        errors.push({ line, error: `Distretto non valido "${get(iDistrict)}" (${DISTRICT_RANGE.min}-${DISTRICT_RANGE.max})` });
        return;
      }
      const derived = ssidFor(n, d);
      // an SSID column may name a relay AP of the same district (…-R1)
      if (ssid && ssid.replace(/-R\d+$/, '') !== derived) {
        errors.push({ line, error: `SSID ${ssid} diverso da nodo/distretto (${derived})` });
        return;
      }
      ssid = ssid || derived;
    }
    if (!SSID_RX.test(ssid)) {
      errors.push({ line, error: `SSID non valido "${ssid}" (atteso CDA-NET-N{nodo}-D{distretto}, con -R{n} per un rilancio)` });
      return;
    }
    // WPA2 is taken verbatim (no trim of inner spaces), only surrounding whitespace is ignored.
    const wpa2 = get(iWpa);
    if (!WPA2_RX.test(wpa2)) {
      errors.push({ line, error: `Chiave WPA2 di ${ssid} non valida: 8-63 caratteri ASCII stampabili` });
      return;
    }
    const prev = seen.get(ssid);
    if (prev) {
      errors.push({ line, error: `${ssid} già presente alla riga ${prev}` });
      return;
    }
    seen.set(ssid, line);
    rows.push({ line, ssid, wpa2 });
  });
  if (!rows.length && !errors.length) errors.push({ line: 1, error: 'Nessuna riga da importare' });
  return { rows, errors };
}
