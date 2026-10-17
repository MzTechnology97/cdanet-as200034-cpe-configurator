/**
 * Saved coverage and feasibility checks: what a list shows of each one (pure, from the answer the
 * check gave when it was saved) and the name it gets. The answer itself is kept whole, so the
 * check can be read again as it was; the list shows only this summary.
 */

export type CheckKind = 'coverage' | 'feasibility';
export const CHECK_KINDS: CheckKind[] = ['coverage', 'feasibility'];

export interface CoverageSummary {
  kind: 'coverage';
  /** buono / possibile / improbabile, as Copertura says for the best AP; none: no AP at all. */
  verdict: 'buono' | 'possibile' | 'improbabile' | 'none';
  title: string;
  best: { name: string; rating: string; distanceM: number | null; signalDbm: number | null; eveningMbps: number | null } | null;
  aps: number;
  /** The best AGCOM sticker of the other operators at the point, as the check showed them. */
  others: string | null;
}

export interface FeasibilitySummary {
  kind: 'feasibility';
  verdict: 'yes' | 'maybe' | 'no';
  title: string;
  eveningMbps: number | null;
  sticker: string | null;
  /** The best AGCOM sticker of the other operators, when they were checked. */
  others: string | null;
}

export type CheckSummary = CoverageSummary | FeasibilitySummary;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown, max = 120): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const COVERAGE_TITLE: Record<CoverageSummary['verdict'], string> = {
  buono: 'Copertura probabile',
  possibile: 'Copertura da verificare',
  improbabile: 'Copertura improbabile',
  none: 'Nessun AP utile',
};

/**
 * The answer of /api/coverage in a line: the best AP decides (the server already ranks them). A
 * saved check keeps the other operators next to it ([operators], as Copertura shows them).
 */
export function coverageSummary(r: unknown): CoverageSummary {
  const aps = Array.isArray((r as { aps?: unknown })?.aps) ? ((r as { aps: Array<Record<string, unknown>> }).aps) : [];
  const first = aps[0];
  const rating = text(first?.rating, 30);
  const verdict: CoverageSummary['verdict'] = !first ? 'none' : rating === 'buono' ? 'buono' : rating === 'possibile' || rating === 'senza stima' ? 'possibile' : 'improbabile';
  const estimate = (first?.estimate ?? null) as Record<string, unknown> | null;
  return {
    kind: 'coverage',
    verdict,
    title: COVERAGE_TITLE[verdict],
    best: first
      ? {
          name: text(first.name) || text(first.id),
          rating,
          distanceM: num(first.distanceM),
          signalDbm: num(estimate?.signalDbm),
          eveningMbps: num(estimate?.eveningMbps),
        }
      : null,
    aps: aps.length,
    others: text(((r as { operators?: { best?: unknown } | null })?.operators ?? null)?.best, 8) || null,
  };
}

const VERDICTS = ['yes', 'maybe', 'no'] as const;

/** The answer of /api/admin/feasibility in a line: ours, and the best of the other operators. */
export function feasibilitySummary(r: unknown): FeasibilitySummary {
  const ours = ((r as { ours?: unknown })?.ours ?? {}) as Record<string, unknown>;
  const verdict = (VERDICTS as readonly string[]).includes(ours.verdict as string) ? (ours.verdict as FeasibilitySummary['verdict']) : 'no';
  const operators = ((r as { operators?: unknown })?.operators ?? null) as { best?: unknown } | null;
  return {
    kind: 'feasibility',
    verdict,
    title: text(ours.title) || (verdict === 'yes' ? 'Servizio CDA Net disponibile' : verdict === 'maybe' ? 'Da verificare con un sopralluogo' : 'Non coperto dalla rete CDA Net'),
    eveningMbps: num(ours.eveningMbps),
    sticker: text(ours.sticker, 8) || null,
    others: text(operators?.best, 8) || null,
  };
}

export const summaryOf = (kind: CheckKind, r: unknown): CheckSummary => (kind === 'coverage' ? coverageSummary(r) : feasibilitySummary(r));

export const NAME_MAX = 120;

/**
 * The name of a saved check: the one written, else the customer's of ISP Billing, else the
 * address, else the coordinates. Spaces collapsed, never empty, never longer than [NAME_MAX].
 */
export function checkName(p: { name?: string | null; customerName?: string | null; label?: string | null; lat: number; lon: number }): string {
  const clean = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
  const n = clean(p.name) || clean(p.customerName) || clean(p.label) || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  return n.slice(0, NAME_MAX);
}

/** The parameters of a coverage check worth keeping to run it again the same way. */
export interface CoverageParams {
  cpe?: string;
  height?: number;
  km?: number;
  limit?: number;
}

/** The query of /api/coverage for a saved check (the same CPE, height, radius and number of APs). */
export function coverageQuery(lat: number, lon: number, p: CoverageParams): string {
  const q = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  if (p.limit !== undefined) q.set('limit', String(p.limit));
  if (p.km !== undefined) q.set('km', String(p.km));
  if (p.height !== undefined) q.set('height', String(p.height));
  q.set('cpe', p.cpe ?? 'auto');
  return q.toString();
}
