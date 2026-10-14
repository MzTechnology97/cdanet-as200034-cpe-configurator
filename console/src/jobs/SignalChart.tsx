/**
 * The signal of a CPE over a period (and the signal on the AP side, dashed), with the good and
 * minimum thresholds of Impostazioni server. [st]: the statistics of /uisp/statistics.
 */
export interface SignalStats {
  signal: { points: Array<[number, number]>; min?: number | null; avg?: number | null; max?: number | null; trend?: number | null };
  remoteSignal: { points: Array<[number, number]>; avg?: number | null };
  thresholds?: { good?: number; min?: number } | null;
}

export function SignalChart({ st, admin = true }: { st: SignalStats; admin?: boolean }) {
  const W = 640;
  const H = 180;
  const P = 28;
  const pts = st.signal.points;
  if (!pts.length) return <p className="ui-muted ui-small">{admin ? 'Nessun dato di segnale in UISP per il periodo.' : 'Nessun dato di segnale per il periodo.'}</p>;
  const all = [...pts, ...st.remoteSignal.points].map((p) => p[1]);
  const t0 = pts[0]![0];
  const t1 = pts[pts.length - 1]![0] || t0 + 1;
  const good = st.thresholds?.good ?? -65;
  const min = st.thresholds?.min ?? -75;
  const lo = Math.min(min - 5, ...all) - 2;
  const hi = Math.max(-45, good + 5, ...all) + 2;
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - P - 8);
  const y = (v: number) => 8 + ((hi - v) / (hi - lo)) * (H - 8 - 22);
  const line = (list: Array<[number, number]>) => list.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const day = (t: number) => new Date(t).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
  const guide = (v: number, cls: string) => (
    <g className={cls}>
      <line x1={P} x2={W - 8} y1={y(v)} y2={y(v)} strokeDasharray="5 5" strokeWidth={1} />
      <text x={2} y={y(v) + 4} fontSize={10}>
        {v}
      </text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sg-chart" role="img" aria-label="Andamento del segnale">
      {guide(good, 'sg-good')}
      {guide(min, 'sg-min')}
      {st.remoteSignal.points.length > 0 && <path d={line(st.remoteSignal.points)} className="sg-remote" />}
      <path d={line(pts)} className="sg-line" />
      <text x={P} y={H - 4} fontSize={10} className="sg-axis">
        {day(t0)}
      </text>
      <text x={W - 8} y={H - 4} fontSize={10} textAnchor="end" className="sg-axis">
        {day(t1)}
      </text>
    </svg>
  );
}
