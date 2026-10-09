import { api } from '../api.js';
import { card, field, fmtDate, h, mount, pageHead, table } from '../dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });

/** Stacked bars: successful and failed installations per month. */
function monthChart(months) {
  const W = 640, H = 200, P = 24, bw = (W - P * 2) / months.length;
  const max = Math.max(1, ...months.map((m) => m.jobs));
  const y = (v) => H - 24 - (v / max) * (H - 44);
  const bars = months.flatMap((m, i) => {
    const x = P + i * bw + bw * 0.2;
    const w = bw * 0.6;
    return [
      s('rect', { x, y: y(m.success), width: w, height: H - 24 - y(m.success), fill: 'var(--good)', rx: 3 }, s('title', {}, `${m.success} riuscite`)),
      s('rect', { x, y: y(m.success + m.failed), width: w, height: y(m.success) - y(m.success + m.failed), fill: 'var(--bad)', rx: 3 }, s('title', {}, `${m.failed} fallite`)),
      s('text', { x: x + w / 2, y: y(m.jobs) - 4, 'font-size': 11, 'text-anchor': 'middle', fill: 'var(--ink)' }, m.jobs ? String(m.jobs) : ''),
      s('text', { x: x + w / 2, y: H - 6, 'font-size': 10, 'text-anchor': 'middle', fill: 'var(--muted)' }, monthName(m.month)),
    ];
  });
  return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Installazioni per mese' }, ...bars);
}

export async function statsView() {
  const out = h('div', {});
  const months = h('select', {}, ...[3, 6, 12, 24].map((n) => h('option', { value: n, selected: n === 6 }, `Ultimi ${n} mesi`)));

  async function load() {
    const d = await api(`/api/admin/stats?months=${months.value}`);
    const tot = d.months.reduce((a, m) => ({ jobs: a.jobs + m.jobs, success: a.success + m.success, failed: a.failed + m.failed, acc: a.acc + m.acceptances }), { jobs: 0, success: 0, failed: 0, acc: 0 });
    mount(
      out,
      card(
        h('h2', {}, 'Installazioni per mese'),
        h('div', { class: 'grid' },
          h('div', { class: 'stat' }, h('small', {}, 'Provisioning'), h('strong', {}, String(tot.jobs))),
          h('div', { class: 'stat' }, h('small', {}, 'Riuscite'), h('strong', {}, `${tot.success} (${pct(tot.success, tot.jobs)})`)),
          h('div', { class: 'stat' }, h('small', {}, 'Fallite'), h('strong', {}, `${tot.failed} (${pct(tot.failed, tot.jobs)})`)),
          h('div', { class: 'stat' }, h('small', {}, 'Collaudate'), h('strong', {}, `${tot.acc} (${pct(tot.acc, tot.success)})`))),
        monthChart(d.months),
        h('p', { class: 'small muted' }, 'Verde: riuscite · rosso: fallite (tentativi, non installazioni distinte).'),
        table(
          [
            { label: 'Mese', render: (m) => monthName(m.month) },
            { label: 'Riuscite', key: 'success' },
            { label: 'Fallite', key: 'failed' },
            { label: 'Collaudi (ok / riserva / ko)', render: (m) => (m.acceptances ? `${m.acceptOk} / ${m.acceptWarn} / ${m.acceptBad}` : '—') },
            { label: 'Segnale medio', render: (m) => (m.avgSignal != null ? `${m.avgSignal} dBm` : '—') },
            { label: 'Download medio', render: (m) => (m.avgDownload != null ? `${m.avgDownload} Mbit/s` : '—') },
            { label: 'Sostituzioni', key: 'replacements' },
            { label: 'Accettate UISP', key: 'uispAccepted' },
          ],
          [...d.months].reverse(),
        ),
      ),
      card(
        h('h2', {}, 'Per installatore'),
        d.installers.length
          ? table(
              [
                { label: 'Installatore', key: 'installer' },
                { label: 'Riuscite', key: 'success' },
                { label: 'Fallite', render: (r) => `${r.failed} (${pct(r.failed, r.jobs)})` },
                { label: 'Collaudate', render: (r) => `${r.acceptances} (${pct(r.acceptances, r.success)})` },
                { label: 'Collaudi con riserva / ko', render: (r) => `${r.acceptWarn} / ${r.acceptBad}` },
                { label: 'Segnale medio', render: (r) => (r.avgSignal != null ? `${r.avgSignal} dBm` : '—') },
                { label: 'Ultimo', render: (r) => fmtDate(r.lastJob) },
              ],
              d.installers,
            )
          : h('p', { class: 'small muted' }, 'Nessun provisioning nel periodo.'),
      ),
      card(
        h('h2', {}, 'Per modello'),
        table(
          [
            { label: 'Modello', key: 'model' },
            { label: 'Provisioning', key: 'jobs' },
            { label: 'Falliti', render: (r) => `${r.failed} (${pct(r.failed, r.jobs)})` },
          ],
          d.models,
        ),
      ),
    );
  }
  months.onchange = () => load().catch((e) => mount(out, h('div', { class: 'notice bad' }, e.message)));
  await load();
  return h('div', {}, pageHead('Statistiche', 'Installazioni, collaudi e qualità per mese, installatore e modello.'), card(h('div', { class: 'row' }, field('Periodo', months))), out);
}
