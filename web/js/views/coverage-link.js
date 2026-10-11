/**
 * The link from a point to an AP, shared by the Copertura pages (admins and installers): profile
 * of the terrain as in UISP Design, the figures of the link and the expected modulation (DOM).
 */
import { h } from '../dom.js';

export const km = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`);
export const dec = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
/** Tallest mast worth suggesting for a CPE (same limit as the app). */
export const MAX_MAST_M = 12;

/** "37.56, 14.27", "37,56 14,27", "37.56;14.27" → [lat, lon]; null if it is not a pair of coordinates. */
export function parseCoords(text) {
  if (!/^[\s\d.,;+-]+$/.test(text)) return null;
  const nums = text.match(/-?\d+(?:[.,]\d+)?/g);
  if (!nums || nums.length !== 2) return null;
  const [la, lo] = nums.map((n) => Number(n.replace(',', '.')));
  return Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [la, lo] : null;
}

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

export const ALT_FROM = { sito: 'altezza del sito in UISP', gps: 'altitudine GPS di UISP (il sito non ha l’altezza)', uisp: 'altezza dal suolo scritta in UISP', terreno: 'altezza predefinita (Impostazioni server), UISP non la indica' };

/** First Fresnel zone radius at [d] of a [D] m link, m. */
const fresnelR = (d, D, freqMhz) => Math.sqrt(((299.79 / (freqMhz || 5600)) * d * Math.max(0, D - d)) / D);

/**
 * Elevation profile of the link, as in UISP Design: ground (with the earth bulge) and the obstacles
 * on it, the two antennas on their masts, the line of sight, the whole first Fresnel zone (ellipse)
 * and its 60% limit, distances along the bottom and the critical point.
 */
export function profileChart(p) {
  const W = 980;
  const H = 300;
  const pad = { l: 52, r: 16, t: 18, b: 34 };
  const pts = p.chart.map((q) => ({ ...q, r: fresnelR(q.d, p.distanceM, p.frequencyMhz) }));
  const D = pts[pts.length - 1].d || 1;
  const ys = pts.flatMap((q) => [q.ground, q.top ?? q.ground, q.los + q.r, q.los - q.r]);
  const lo = Math.floor(Math.min(...ys) - 8);
  const hi = Math.ceil(Math.max(...ys) + 8);
  const x = (d) => pad.l + ((W - pad.l - pad.r) * d) / D;
  const y = (v) => pad.t + ((H - pad.t - pad.b) * (hi - v)) / (hi - lo || 1);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'los-chart link-chart', role: 'img', 'aria-label': 'Profilo del collegamento' });
  // grid and axes
  const stepM = [100, 250, 500, 1000, 2000, 5000].find((st) => D / st <= 10) ?? 5000;
  for (let d = 0; d <= D; d += stepM) {
    svg.append(s('line', { x1: x(d), x2: x(d), y1: pad.t, y2: H - pad.b, class: 'link-grid' }));
    const t = s('text', { x: x(d), y: H - 12, class: 'los-axis', 'text-anchor': d === 0 ? 'start' : 'middle' });
    t.textContent = km(Math.round(d));
    svg.append(t);
  }
  for (const v of [lo, Math.round((lo + hi) / 2), hi]) {
    svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'link-grid' }));
    const t = s('text', { x: pad.l - 6, y: y(v) + 4, class: 'los-axis', 'text-anchor': 'end' });
    t.textContent = `${v} m`;
    svg.append(t);
  }
  // Fresnel ellipse (whole first zone), then terrain and obstacles over it
  const upper = pts.map((q) => `${x(q.d)},${y(q.los + q.r)}`);
  const lower = pts.map((q) => `${x(q.d)},${y(q.los - q.r)}`).reverse();
  svg.append(s('path', { d: `M${upper.join(' L')} L${lower.join(' L')} Z`, class: 'link-fresnel' }));
  svg.append(s('path', { d: 'M' + pts.map((q) => `${x(q.d)},${y(q.los - 0.6 * q.r)}`).join(' L'), class: 'los-fresnel' }));
  const step = pts.length > 1 ? Math.max(1.5, (x(pts[1].d) - x(pts[0].d)) * 0.95) : 2;
  for (const q of pts) if (q.obstacle && q.top > q.ground) svg.append(s('rect', { x: x(q.d) - step / 2, y: y(q.top), width: step, height: Math.max(1, y(q.ground) - y(q.top)), class: q.obstacle === 'edificio' ? 'los-building' : 'los-tree' }));
  svg.append(s('path', { d: `M${x(0)},${y(lo)} ` + pts.map((q) => `L${x(q.d)},${y(q.ground)}`).join(' ') + ` L${x(D)},${y(lo)} Z`, class: 'los-ground' }));
  // line of sight, coloured where it is obstructed
  svg.append(s('path', { d: 'M' + pts.map((q) => `${x(q.d)},${y(q.los)}`).join(' L'), class: 'los-line' }));
  // the antennas on their masts
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (const [q, label, anchor, dx] of [[first, `CPE ${dec(first.los - first.ground)} m`, 'start', 6], [last, `AP ${dec(last.los - last.ground)} m`, 'end', -6]]) {
    svg.append(s('line', { x1: x(q.d), x2: x(q.d), y1: y(q.ground), y2: y(q.los), class: 'link-mast' }));
    svg.append(s('circle', { cx: x(q.d), cy: y(q.los), r: 5, class: 'link-antenna' }));
    const t = s('text', { x: x(q.d) + dx, y: y(q.los) - 9, class: 'link-label', 'text-anchor': anchor });
    t.textContent = label;
    svg.append(t);
  }
  if (p.worst) {
    const q = pts.reduce((a, b) => (Math.abs(b.d - p.worst.d) < Math.abs(a.d - p.worst.d) ? b : a));
    svg.append(s('line', { x1: x(q.d), x2: x(q.d), y1: y(Math.max(q.ground, q.top ?? q.ground)), y2: y(q.los), class: 'link-critical' }));
    svg.append(s('circle', { cx: x(q.d), cy: y(Math.max(q.ground, q.top ?? q.ground)), r: 5, class: 'los-worst' }));
  }
  return h('div', { class: 'link-chart-wrap' }, svg);
}

/** Bearing from [a] to [b], degrees from north. */
export const bearing = (a, b) => {
  const f1 = (a[0] * Math.PI) / 180;
  const f2 = (b[0] * Math.PI) / 180;
  const dl = ((b[1] - a[1]) * Math.PI) / 180;
  return ((Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * 180) / Math.PI + 360) % 360;
};
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const dir = (deg) => `${Math.round(deg)}° ${DIRS[Math.round(deg / 45) % 8]}`;


/** The figures of the link, as in the side panel of UISP Design. */
export function linkFacts(p, from, estimate) {
  const first = p.chart[0];
  const last = p.chart[p.chart.length - 1];
  const tilt = (Math.atan2(last.los - first.los, p.distanceM) * 180) / Math.PI;
  const az = p.ap.lat != null ? bearing(from, [p.ap.lat, p.ap.lon]) : null;
  const clearPct = p.worst ? Math.round((100 * p.worst.clearanceM) / (p.worst.fresnel60M / 0.6 || 1)) : null;
  const fact = (label, value, sub) => h('div', { class: 'link-fact' }, h('small', {}, label), h('strong', {}, value), sub ? h('span', { class: 'small muted' }, sub) : null);
  return h(
    'div',
    { class: 'link-facts' },
    fact('Distanza', km(p.distanceM)),
    fact('Frequenza', `${p.frequencyMhz} MHz`),
    az !== null ? fact('Puntamento CPE → AP', dir(az), `inclinazione ${tilt >= 0 ? '+' : ''}${dec(tilt)}°`) : null,
    az !== null ? fact('Puntamento AP → CPE', dir((az + 180) % 360), `inclinazione ${-tilt >= 0 ? '+' : ''}${dec(-tilt)}°`) : null,
    fact('Antenna CPE', `${dec(first.los - first.ground)} m dal suolo`, `${Math.round(first.los)} m s.l.m.`),
    fact('Antenna AP', `${dec(last.los - last.ground)} m dal suolo`, `${Math.round(last.los)} m s.l.m.`),
    estimate?.signalDbm != null ? fact('Segnale stimato', `${estimate.signalDbm} dBm`, estimate.low != null ? `${estimate.low}…${estimate.high} dBm` : null) : null,
    clearPct !== null ? fact('Fresnel libera', `${Math.max(0, clearPct)}%`, `nel punto critico, a ${km(p.worst.d)}`) : fact('Fresnel libera', '100%', 'su tutto il collegamento'),
  );
}

/**
 * airMAX ac modulations (rate multiplier of airOS and UISP Design) and the SNR each needs, dB:
 * the modulation follows the signal-to-noise ratio, not the signal alone (same table as the server).
 */
const MCS_SCALE = [
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
/** Magnetic declination in central Sicily (2026, east), to point with a compass. */
export const DECLINATION_DEG = 4;

/**
 * Expected modulation of the link, as in UISP Design: the scale 1x…13x lit up to the modulation
 * the expected SNR allows (signal against the noise of the AP, computed by the server), the bar
 * filled with the SNR; the signal in dBm aside. [e]: the estimate (signalDbm, snrDb, mcs).
 */
export function signalBar(e) {
  const dbm = e?.signalDbm ?? null;
  const snr = e?.snrDb ?? (dbm == null ? null : dbm + 92);
  const reached = e?.mcs ?? (snr == null ? -1 : MCS_SCALE.filter(([need]) => snr >= need).length - 1);
  const pct = snr == null ? 0 : Math.max(0, Math.min(100, (snr / 35) * 100));
  const bar = h('div', { class: 'mcs-bar' }, h('span', { class: 'mcs-fill' }));
  bar.firstChild.style.width = `${pct}%`;
  return h(
    'div',
    { class: 'mcs' },
    h(
      'div',
      { class: 'mcs-head' },
      h('span', {}, 'Modulazione attesa'),
      h('b', {}, reached >= 0 ? `${MCS_SCALE[reached][1]} · SNR ${snr} dB` : snr == null ? '—' : `nessuna · SNR ${snr} dB`),
    ),
    bar,
    h('div', { class: 'mcs-steps' }, MCS_SCALE.map(([, label], k) => h('span', { class: k <= reached ? 'on' : '' }, label))),
    h('div', { class: 'small muted' }, dbm == null ? '' : `Segnale atteso ${dbm} dBm${e?.snrDb == null ? ' · rumore dell’AP non noto, considerato −92 dBm' : ''}`),
  );
}
