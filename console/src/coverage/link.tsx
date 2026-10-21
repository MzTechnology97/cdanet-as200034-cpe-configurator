import { type PointerEvent, type ReactNode, useId, useState } from 'react';
import type { Estimate } from './parts';

/**
 * The link from a point to an AP, shared by the Copertura pages (admins and installers): profile
 * of the terrain as in UISP Design, the figures of the link and the expected modulation.
 */

/** Tallest mast worth suggesting for a CPE (same limit as the app). */
export const MAX_MAST_M = 12;
/** Magnetic declination in central Sicily (2026, east), to point with a compass. */
export const DECLINATION_DEG = 4;

export const ALT_FROM: Record<string, string> = {
  sito: 'altezza del sito in UISP',
  gps: 'altitudine GPS di UISP (il sito non ha l’altezza)',
  uisp: 'altezza dal suolo scritta in UISP',
  terreno: 'altezza predefinita (Impostazioni server), UISP non la indica',
};

const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`);
const dec = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');

/** "37.56, 14.27", "37,56 14,27", "37.56;14.27" → [lat, lon]; null if it is not a pair of coordinates. */
export function parseCoords(text: string): [number, number] | null {
  if (!/^[\s\d.,;+-]+$/.test(text)) return null;
  const nums = text.match(/-?\d+(?:[.,]\d+)?/g);
  if (!nums || nums.length !== 2) return null;
  const [la, lo] = nums.map((n) => Number(n.replace(',', '.'))) as [number, number];
  return Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [la, lo] : null;
}

/** Bearing from [a] to [b], degrees from north. */
export const bearing = (a: [number, number], b: [number, number]) => {
  const f1 = (a[0] * Math.PI) / 180;
  const f2 = (b[0] * Math.PI) / 180;
  const dl = ((b[1] - a[1]) * Math.PI) / 180;
  return ((Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * 180) / Math.PI + 360) % 360;
};
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const dir = (deg: number) => `${Math.round(deg)}° ${DIRS[Math.round(deg / 45) % 8]}`;

export interface LinkProfile {
  distanceM: number;
  frequencyMhz?: number;
  chart: Array<{ d: number; los: number; ground: number; top?: number; obstacle?: string | null }>;
  worst?: { d: number; clearanceM: number; fresnel60M: number } | null;
  ap: { lat?: number | null; lon?: number | null };
}

/** First Fresnel zone radius at [d] of a [D] m link, m. */
const fresnelR = (d: number, D: number, freqMhz?: number) => Math.sqrt(((299.79 / (freqMhz || 5600)) * d * Math.max(0, D - d)) / D);

/** Below this height of the Fresnel zone (viewBox units, out of 248) the whole profile hides it. */
const THIN_FRESNEL = 14;

/**
 * Elevation profile of the link, as in UISP Design: ground (with the earth bulge) and the obstacles
 * on it, the two antennas on their masts, the line of sight, the whole first Fresnel zone (ellipse)
 * and its 60% limit, distances along the bottom and the critical point.
 * [view] 'full': the whole profile. 'fresnel': everything measured from the line of sight
 * (straight at 0), on a scale made for the zone, so that it fills the drawing and what enters it
 * shows at once (a hill of 500 m and a zone of ±1 m do not fit the same scale); ground far above
 * or below the line is cut at the edges. 'auto': the zone view when the zone would be a thin line
 * in the whole profile. [height]: of the drawing, out of a width of 980 (a lower one for a strip).
 */
export function ProfileChart({ p, view = 'full', height = 300, ends = ['CPE', 'AP'] }: { p: LinkProfile; view?: 'full' | 'fresnel' | 'auto'; height?: number; ends?: [string, string] }) {
  const clip = `link-clip-${useId().replace(/:/g, '')}`;
  // the point of the link under the mouse (or the finger): its heights in a tooltip
  const [hover, setHover] = useState<number | null>(null);
  const W = 980;
  const H = height;
  const pad = { l: 52, r: 16, t: 18, b: 34 };
  const pts = p.chart.map((q) => ({ ...q, r: fresnelR(q.d, p.distanceM, p.frequencyMhz) }));
  if (!pts.length) return null;
  const D = pts[pts.length - 1]!.d || 1;
  const maxR = Math.max(...pts.map((q) => q.r));
  const ys = pts.flatMap((q) => [q.ground, q.top ?? q.ground, q.los + q.r, q.los - q.r]);
  const full = [Math.floor(Math.min(...ys) - 8), Math.ceil(Math.max(...ys) + 8)] as const;
  // the zone and room around it for what touches it, in metres from the line of sight
  const span = Math.max(Math.ceil(maxR * 2.4 * 2) / 2, 2);
  const thin = (2 * maxR * (H - pad.t - pad.b)) / (full[1] - full[0] || 1) < THIN_FRESNEL;
  const zoom = view === 'fresnel' || (view === 'auto' && thin);
  // how far the ground and the obstacles go above the line (zoom: cut beyond the window)
  const above = Math.max(...pts.map((q) => (q.top ?? q.ground) - q.los));
  const [lo, hi] = zoom ? [-span, span] : full;
  const x = (d: number) => pad.l + ((W - pad.l - pad.r) * d) / D;
  const yv = (v: number) => pad.t + ((H - pad.t - pad.b) * (hi - v)) / (hi - lo || 1);
  // a height at a point of the link: as it is, or from the line of sight (zoom)
  type Pt = (typeof pts)[number];
  const y = (q: Pt, v: number) => yv(zoom ? v - q.los : v);
  const stepM = [100, 250, 500, 1000, 2000, 5000].find((st) => D / st <= 10) ?? 5000;
  const ticks: number[] = [];
  for (let d = 0; d <= D; d += stepM) ticks.push(d);
  const upper = pts.map((q) => `${x(q.d)},${y(q, q.los + q.r)}`);
  const lower = pts.map((q) => `${x(q.d)},${y(q, q.los - q.r)}`).reverse();
  const step = pts.length > 1 ? Math.max(1.5, (x(pts[1]!.d) - x(pts[0]!.d)) * 0.95) : 2;
  const floor = H - pad.b + 2;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const critical = p.worst ? pts.reduce((a, b) => (Math.abs(b.d - p.worst!.d) < Math.abs(a.d - p.worst!.d) ? b : a)) : null;
  const yCritical = critical ? Math.max(pad.t, Math.min(H - pad.b, y(critical, Math.max(critical.ground, critical.top ?? critical.ground)))) : 0;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const d = (((e.clientX - r.left) * W) / r.width - pad.l) / ((W - pad.l - pad.r) / D);
    if (d < 0 || d > D) return setHover(null);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i]!.d - d) < Math.abs(pts[best]!.d - d)) best = i;
    setHover(best);
  };
  const h = hover !== null ? pts[hover] : undefined;
  const tip = (() => {
    if (!h) return null;
    const top = Math.max(h.ground, h.top ?? h.ground);
    const clear = h.los - top;
    const free = h.r > 0 ? Math.max(0, Math.min(100, Math.round((clear / h.r) * 100))) : 100;
    const lines = [
      `${km(h.d)} da ${ends[0]} · ${km(Math.max(0, D - h.d))} da ${ends[1]}`,
      `Linea di vista a ${dec(h.los - h.ground)} m dal suolo`,
      h.obstacle && h.top != null && h.top > h.ground
        ? `${h.obstacle === 'edificio' ? 'Edificio' : 'Alberi'} di ${dec(h.top - h.ground)} m: linea ${clear >= 0 ? `${dec(clear)} m sopra` : `${dec(-clear)} m dentro`}`
        : clear >= 0
          ? null
          : `Terreno ${dec(-clear)} m sopra la linea`,
      `Fresnel: raggio ${dec(h.r)} m · libera ${free}%${clear < 0.6 * h.r ? (clear < 0 ? ' · ostruita' : ' · invasa') : ''}`,
      `Suolo ${Math.round(h.ground)} m s.l.m.`,
    ].filter((l): l is string => !!l);
    const tone = clear < 0 ? 'bad' : clear < 0.6 * h.r ? 'warn' : 'good';
    const hx = x(h.d);
    return { lines, tone, hx, top, right: hx > W * 0.55 };
  })();
  return (
    <div className="link-chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="los-chart link-chart"
        role="img"
        aria-label={zoom ? 'Profilo del collegamento: zona di Fresnel, altezze dalla linea di vista' : 'Profilo del collegamento'}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* what falls outside the window (zoom) is cut at the edges of the drawing */}
        <defs>
          <clipPath id={clip}>
            <rect x={pad.l} y={pad.t} width={W - pad.l - pad.r} height={H - pad.t - pad.b} />
          </clipPath>
        </defs>
        {ticks.map((d) => (
          <g key={`d${d}`}>
            <line x1={x(d)} x2={x(d)} y1={pad.t} y2={H - pad.b} className="link-grid" />
            <text x={x(d)} y={H - 12} className="los-axis" textAnchor={d === 0 ? 'start' : 'middle'}>
              {km(Math.round(d))}
            </text>
          </g>
        ))}
        {[lo, Math.round((lo + hi) / 2), hi].map((v, i) => (
          <g key={`v${i}`}>
            <line x1={pad.l} x2={W - pad.r} y1={yv(v)} y2={yv(v)} className="link-grid" />
            <text x={pad.l - 6} y={yv(v) + 4} className="los-axis" textAnchor="end">
              {zoom ? `${v > 0 ? '+' : ''}${dec(v)} m` : `${v} m`}
            </text>
          </g>
        ))}
        <g clipPath={`url(#${clip})`}>
          {/* Fresnel ellipse (whole first zone), then terrain and obstacles over it */}
          <path d={`M${upper.join(' L')} L${lower.join(' L')} Z`} className="link-fresnel" />
          <path d={'M' + pts.map((q) => `${x(q.d)},${y(q, q.los - 0.6 * q.r)}`).join(' L')} className="los-fresnel" />
          {pts.map((q, i) =>
            q.obstacle && q.top != null && q.top > q.ground ? <rect key={i} x={x(q.d) - step / 2} y={y(q, q.top)} width={step} height={Math.max(1, y(q, q.ground) - y(q, q.top))} className={q.obstacle === 'edificio' ? 'los-building' : 'los-tree'} /> : null,
          )}
          {/* the ground down to the bottom edge of the drawing */}
          <path d={`M${x(0)},${floor} ` + pts.map((q) => `L${x(q.d)},${Math.min(floor, y(q, q.ground))}`).join(' ') + ` L${x(D)},${floor} Z`} className="los-ground" />
          <path d={'M' + pts.map((q) => `${x(q.d)},${y(q, q.los)}`).join(' L')} className="los-line" />
        </g>
        {/* the antennas on their masts */}
        {(
          [
            [first, `${ends[0]} ${dec(first.los - first.ground)} m`, 'start', 6],
            [last, `${ends[1]} ${dec(last.los - last.ground)} m`, 'end', -6],
          ] as const
        ).map(([q, label, anchor, dx]) => (
          <g key={anchor}>
            <line x1={x(q.d)} x2={x(q.d)} y1={Math.min(H - pad.b, y(q, q.ground))} y2={y(q, q.los)} className="link-mast" />
            <circle cx={x(q.d)} cy={y(q, q.los)} r={5} className="link-antenna" />
            <text x={x(q.d) + dx} y={y(q, q.los) - 9} className="link-label" textAnchor={anchor}>
              {label}
            </text>
          </g>
        ))}
        {critical && (
          <>
            <line x1={x(critical.d)} x2={x(critical.d)} y1={yCritical} y2={y(critical, critical.los)} className="link-critical" />
            <circle cx={x(critical.d)} cy={yCritical} r={5} className="los-worst" />
          </>
        )}
        {/* the point under the mouse: from the line of sight down to the ground or the obstacle */}
        {h && tip && (
          <g className="link-hover" pointerEvents="none">
            <line x1={tip.hx} x2={tip.hx} y1={pad.t} y2={H - pad.b} className="link-hover-line" />
            <line x1={tip.hx} x2={tip.hx} y1={Math.max(pad.t, Math.min(H - pad.b, y(h, tip.top)))} y2={Math.max(pad.t, Math.min(H - pad.b, y(h, h.los)))} className={`link-hover-gap ${tip.tone}`} />
            <circle cx={tip.hx} cy={Math.max(pad.t, Math.min(H - pad.b, y(h, h.los)))} r={4} className="link-hover-dot" />
            <circle cx={tip.hx} cy={Math.max(pad.t, Math.min(H - pad.b, y(h, tip.top)))} r={4} className={`link-hover-dot ${tip.tone}`} />
          </g>
        )}
        {/* zoom: the ground cut at the top is said, with how far above the line it goes */}
        {zoom && above > hi && (
          <text x={W - pad.r - 4} y={pad.t + 14} className="link-label" textAnchor="end">
            ostacolo fino a {Math.round(above)} m sopra la linea (tagliato)
          </text>
        )}
      </svg>
      {/* the figures of the point in HTML: the same size in a small chart (the dock) as in a big one */}
      {tip && (
        <div className={`link-tip-box${tip.right ? ' right' : ''}`} style={tip.right ? { right: `${(1 - tip.hx / W) * 100}%` } : { left: `${(tip.hx / W) * 100}%` }}>
          {tip.lines.map((l, i) => (
            <div key={i} className={`${i === 0 ? 'strong' : ''}${/^Fresnel|^Edificio|^Alberi|^Terreno/.test(l) ? ` ${tip.tone}` : ''}`}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The figures of the link, as in the side panel of UISP Design. */
export function LinkFacts({ p, from, estimate }: { p: LinkProfile; from: [number, number]; estimate?: Estimate | null }) {
  const first = p.chart[0]!;
  const last = p.chart[p.chart.length - 1]!;
  const tilt = (Math.atan2(last.los - first.los, p.distanceM) * 180) / Math.PI;
  const az = p.ap.lat != null && p.ap.lon != null ? bearing(from, [p.ap.lat, p.ap.lon]) : null;
  const clearPct = p.worst ? Math.round((100 * p.worst.clearanceM) / (p.worst.fresnel60M / 0.6 || 1)) : null;
  const fact = (label: string, value: ReactNode, sub?: ReactNode) => (
    <div className="link-fact" key={label}>
      <small>{label}</small>
      <strong>{value}</strong>
      {sub ? <span className="ui-small ui-muted">{sub}</span> : null}
    </div>
  );
  return (
    <div className="link-facts">
      {fact('Distanza', km(p.distanceM))}
      {fact('Frequenza', `${p.frequencyMhz} MHz`)}
      {az !== null && fact('Puntamento CPE → AP', dir(az), `inclinazione ${tilt >= 0 ? '+' : ''}${dec(tilt)}°`)}
      {az !== null && fact('Puntamento AP → CPE', dir((az + 180) % 360), `inclinazione ${-tilt >= 0 ? '+' : ''}${dec(-tilt)}°`)}
      {fact('Antenna CPE', `${dec(first.los - first.ground)} m dal suolo`, `${Math.round(first.los)} m s.l.m.`)}
      {fact('Antenna AP', `${dec(last.los - last.ground)} m dal suolo`, `${Math.round(last.los)} m s.l.m.`)}
      {estimate?.signalDbm != null && fact('Segnale stimato', `${estimate.signalDbm} dBm`, estimate.low != null ? `${estimate.low}…${estimate.high} dBm` : null)}
      {clearPct !== null ? fact('Fresnel libera', `${Math.max(0, clearPct)}%`, `nel punto critico, a ${km(p.worst!.d)}`) : fact('Fresnel libera', '100%', 'su tutto il collegamento')}
    </div>
  );
}

/**
 * airMAX ac modulations (rate multiplier of airOS and UISP Design) and the SNR each needs, dB:
 * the modulation follows the signal-to-noise ratio, not the signal alone (same table as the server).
 */
const MCS_SCALE: Array<[number, string]> = [
  [4, '1x'],
  [7, '2x'],
  [10, '3x'],
  [13, '4x'],
  [17, '6x'],
  [21, '8x'],
  [23, '9x'],
  [25, '10x'],
  [29, '12x'],
  [31, '13x'],
];

/**
 * Expected modulation of the link, as in UISP Design: the scale 1x…13x lit up to the modulation
 * the expected SNR allows (signal against the noise of the AP, computed by the server), the bar
 * filled with the SNR; the signal in dBm aside.
 */
export function SignalBar({ e }: { e?: { signalDbm?: number | null; snrDb?: number | null; mcs?: number | null } | null }) {
  const dbm = e?.signalDbm ?? null;
  const snr = e?.snrDb ?? (dbm == null ? null : dbm + 92);
  const reached = e?.mcs ?? (snr == null ? -1 : MCS_SCALE.filter(([need]) => snr >= need).length - 1);
  const pct = snr == null ? 0 : Math.max(0, Math.min(100, (snr / 35) * 100));
  return (
    <div className="mcs">
      <div className="mcs-head">
        <span>Modulazione attesa</span>
        <b>{reached >= 0 ? `${MCS_SCALE[reached]![1]} · SNR ${snr} dB` : snr == null ? '—' : `nessuna · SNR ${snr} dB`}</b>
      </div>
      <div className="mcs-bar">
        <span className="mcs-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="mcs-steps">
        {MCS_SCALE.map(([, label], k) => (
          <span key={label} className={k <= reached ? 'on' : ''}>
            {label}
          </span>
        ))}
      </div>
      <div className="ui-small ui-muted">{dbm == null ? '' : `Segnale atteso ${dbm} dBm${e?.snrDb == null ? ' · rumore dell’AP non noto, considerato −92 dBm' : ''}`}</div>
    </div>
  );
}
