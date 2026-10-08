/**
 * CSV for Excel in Italian locale: ';' separator, CRLF, quoted when needed.
 * Cells that a spreadsheet would run as formulas (= + - @ tab CR) are prefixed with
 * an apostrophe (CSV/formula injection).
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
