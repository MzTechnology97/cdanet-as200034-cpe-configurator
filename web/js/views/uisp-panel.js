import { api, download } from '../api.js';
import { isOn } from '../modules.js';
import { badge, busy, fmtDate, h, mount, stat, table, toast } from '../dom.js';
import { nms } from '../terms.js';

const ERRORS = {
  uisp_not_configured: 'UISP non configurato: impostalo in Connettori.',
  uisp_tls_error: 'Certificato TLS di UISP non valido: valuta "Ignora verifica TLS" in Connettori.',
  uisp_unreachable: 'UISP non raggiungibile dal server.',
  uisp_auth_failed: 'Token UISP rifiutato: verifica UISP_API_TOKEN e i suoi permessi.',
  uisp_device_not_found: 'La CPE non è ancora comparsa in UISP: attendi che si colleghi dopo il riavvio e riprova.',
  uisp_already_authorized: 'La CPE è già stata accettata in UISP.',
  uisp_site_unknown: 'Non riesco a determinare il site dell’AP: sceglilo manualmente.',
};
const err = (e) => ERRORS[e.body?.error] ?? e.message;

/** UISP section of a provisioning job: live status, acceptance and backups. */
export function uispPanel(job, isAdmin) {
  const box = h('div', {}, h('p', { class: 'muted small' }, nms('Lettura stato da UISP…', 'Lettura stato…')));

  async function load() {
    let s;
    try {
      s = await api(`/api/provisioning/jobs/${job.id}/uisp`);
    } catch (e) {
      mount(box, h('div', { class: 'notice bad' }, err(e)));
      return;
    }
    if (!s.configured) {
      mount(box, h('p', { class: 'small muted' }, nms('Integrazione UISP non configurata.', 'Stato di rete non disponibile.')));
      return;
    }
    const d = s.device;
    if (!d) {
      const retry = h('button', {}, 'Ricontrolla');
      retry.onclick = () => busy(retry, load);
      mount(box, h('div', { class: 'notice warn' }, nms('CPE non ancora presente in UISP (ricerca per MAC). Dopo il riavvio può servire qualche minuto.', 'CPE non ancora vista in rete. Dopo il riavvio può servire qualche minuto.')), retry);
      return;
    }
    const pending = !d.authorized;
    const actions = h('div', { class: 'btns' });
    const refresh = h('button', {}, 'Aggiorna');
    refresh.onclick = () => busy(refresh, load);
    actions.append(refresh);

    if (isAdmin && pending) {
      const accept = h('button', { class: 'primary' }, 'Accetta in UISP');
      accept.onclick = () =>
        busy(accept, async () => {
          let siteId;
          if (s.proposedSite) {
            if (!confirm(`Accettare ${d.name || d.mac} in UISP nel site "${s.proposedSite.name}" (site dell’AP agganciato)?`)) return;
          } else {
            const sites = await api('/api/admin/uisp/sites');
            const choice = prompt(
              `Site dell’AP non determinabile. Scrivi il numero del site:\n\n${sites.map((x, i) => `${i + 1}. ${x.name}`).join('\n')}`,
            );
            const idx = Number(choice) - 1;
            if (!sites[idx]) return;
            siteId = sites[idx].id;
          }
          try {
            const r = await api(`/api/admin/provisioning/jobs/${job.id}/uisp/authorize`, { method: 'POST', body: siteId ? { siteId } : {} });
            toast(`CPE accettata nel site ${r.site}${r.backup === 'created' ? ' · backup avviato' : r.backup === 'failed' ? ' · backup non riuscito' : ''}`);
          } catch (e) {
            throw new Error(err(e));
          }
          await load();
        });
      actions.append(accept);
    }

    const backups = h('div', {});
    if (isAdmin && !pending) {
      const mk = h('button', {}, 'Backup ora');
      mk.onclick = () =>
        busy(mk, async () => {
          try {
            await api(`/api/admin/provisioning/jobs/${job.id}/uisp/backups`, { method: 'POST', body: {} });
          } catch (e) {
            throw new Error(err(e));
          }
          toast('Backup richiesto a UISP');
          setTimeout(loadBackups, 3000);
        });
      actions.append(mk);
      const cmp = h('button', {}, 'Confronta con il template');
      cmp.onclick = () => busy(cmp, showDrift);
      if (isOn('config_drift')) actions.append(cmp);
      loadBackups();
    }

    const drift = h('div', {});
    async function showDrift() {
      let r;
      try {
        r = await api(`/api/admin/provisioning/jobs/${job.id}/uisp/drift`);
      } catch (e) {
        mount(drift, h('div', { class: 'notice bad' }, err(e)));
        return;
      }
      const kind = { changed: 'modificata', missing: 'assente sulla CPE', secret_changed: 'segreto diverso (valore non mostrato)' };
      mount(
        drift,
        h('h3', {}, 'Configurazione rispetto al template'),
        h('p', { class: 'small muted' }, `Backup UISP del ${fmtDate(r.backup.timestamp)} · template "${r.template}" · ${r.compared} chiavi confrontate, ${r.skipped} non confrontabili (password), ${r.extra} chiavi in più sulla CPE.`),
        r.items.length
          ? table(
              [
                { label: 'Chiave', render: (i) => h('span', { class: 'mono small' }, i.key) },
                { label: 'Differenza', render: (i) => kind[i.kind] ?? i.kind },
                { label: 'Atteso', render: (i) => h('span', { class: 'mono small' }, i.expected ?? '—') },
                { label: 'Sulla CPE', render: (i) => h('span', { class: 'mono small' }, i.actual ?? '—') },
              ],
              r.items,
            )
          : h('div', { class: 'notice good' }, 'Nessuna differenza: la CPE ha la configurazione CDA Net.'),
        h('p', { class: 'small muted' }, 'Per un confronto aggiornato premi prima "Backup ora" e attendi qualche secondo.'),
      );
    }

    async function loadBackups() {
      try {
        const list = await api(`/api/admin/provisioning/jobs/${job.id}/uisp/backups`);
        mount(
          backups,
          h('h3', {}, 'Backup in UISP'),
          list.length
            ? table(
                [
                  { label: 'Data', render: (b) => fmtDate(b.timestamp) },
                  {
                    label: '',
                    render: (b) => {
                      const dl = h('button', {}, 'Scarica');
                      dl.onclick = () => busy(dl, () => download(`/api/admin/provisioning/jobs/${job.id}/uisp/backups/${encodeURIComponent(b.id)}`, `backup-${b.id}.${b.extension || 'cfg'}`));
                      return dl;
                    },
                  },
                ],
                list,
              )
            : h('p', { class: 'small muted' }, 'Nessun backup.'),
        );
      } catch (e) {
        mount(backups, h('p', { class: 'small muted' }, `Backup non disponibili: ${err(e)}`));
      }
    }

    mount(
      box,
      h(
        'div',
        { class: 'grid' },
        stat(nms('UISP', 'Rete'), pending ? 'In attesa di accettazione' : 'Accettata'),
        stat('Stato', d.status === 'active' ? 'online' : d.status),
        stat('Segnale', d.signal != null ? `${d.signal} dBm` : '—'),
        stat('AP', d.apName ?? '—'),
        stat('Site', s.site ?? (pending && s.proposedSite ? `${s.proposedSite.name} (proposto)` : '—')),
        stat('Firmware', d.firmware || '—'),
      ),
      pending ? null : s.authorizedAt ? h('p', { class: 'small muted' }, `Accettata il ${fmtDate(s.authorizedAt)}`) : null,
      actions,
      pending || !isOn('signal_history') ? null : signalHistory(job),
      drift,
      backups,
    );
  }

  load();
  return box;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

/** Line chart of the signal (and the AP-side signal) with the -65 / -75 dBm thresholds. */
function signalChart(st) {
  const W = 640, H = 180, P = 28;
  const pts = st.signal.points;
  const all = [...pts, ...st.remoteSignal.points].map((p) => p[1]);
  if (!pts.length) return h('p', { class: 'small muted' }, nms('Nessun dato di segnale in UISP per il periodo.', 'Nessun dato di segnale per il periodo.'));
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  const lo = Math.min(-80, ...all) - 2, hi = Math.max(-45, ...all) + 2;
  const x = (t) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - P - 8);
  const y = (v) => 8 + ((hi - v) / (hi - lo)) * (H - 8 - 22);
  const line = (list) => list.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const guide = (v, color, label) => [
    svg('line', { x1: P, x2: W - 8, y1: y(v), y2: y(v), stroke: color, 'stroke-dasharray': '5 5', 'stroke-width': 1 }),
    svg('text', { x: 2, y: y(v) + 4, 'font-size': 10, fill: color }, label),
  ];
  const day = (t) => new Date(t).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
  return svg(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Andamento del segnale' },
    ...guide(-65, 'var(--good)', '-65'),
    ...guide(-75, 'var(--bad)', '-75'),
    st.remoteSignal.points.length ? svg('path', { d: line(st.remoteSignal.points), fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-dasharray': '3 3' }) : '',
    svg('path', { d: line(pts), fill: 'none', stroke: 'var(--brand)', 'stroke-width': 2 }),
    svg('text', { x: P, y: H - 4, 'font-size': 10, fill: 'var(--muted)' }, day(t0)),
    svg('text', { x: W - 8, y: H - 4, 'font-size': 10, fill: 'var(--muted)', 'text-anchor': 'end' }, day(t1)),
  );
}

/** "Storico segnale": sudden failure vs slow degradation, from UISP statistics and outages. */
function signalHistory(job) {
  const out = h('div', {});
  const ranges = { day: 'Giorno', week: 'Settimana', month: 'Mese' };
  const btns = h('div', { class: 'btns' });
  async function show(range) {
    [...btns.children].forEach((b) => b.classList.toggle('primary', b.dataset.range === range));
    mount(out, h('p', { class: 'small muted' }, nms('Lettura statistiche da UISP…', 'Lettura statistiche…')));
    try {
      const st = await api(`/api/provisioning/jobs/${job.id}/uisp/statistics?range=${range}`);
      const s = st.signal;
      const trend =
        s.trend == null ? null
        : s.trend <= -4 ? h('div', { class: 'notice warn' }, `Segnale calato di ${Math.abs(s.trend)} dB nel periodo: degrado lento (vegetazione, antenna spostata, staffa allentata).`)
        : s.trend >= 4 ? h('div', { class: 'notice good' }, `Segnale migliorato di ${s.trend} dB nel periodo.`)
        : null;
      const dl = st.downlinkCapacity.avg != null ? `${Math.round(st.downlinkCapacity.avg / 1000)} / ${Math.round((st.uplinkCapacity.avg ?? 0) / 1000)} Mbit/s` : '—';
      mount(
        out,
        signalChart(st),
        h('p', { class: 'small muted' }, 'Linea piena: segnale ricevuto dalla CPE · tratteggio: segnale lato AP.'),
        h('div', { class: 'grid' }, stat('Segnale min / medio / max', s.avg != null ? `${s.min} / ${s.avg} / ${s.max} dBm` : '—'), stat('Lato AP medio', st.remoteSignal.avg != null ? `${st.remoteSignal.avg} dBm` : '—'), stat('Capacità media', dl), stat('Interruzioni', st.outages == null ? '—' : String(st.outages.length))),
        trend,
        st.outages?.length ? h('ul', { class: 'plain small' }, st.outages.slice(0, 10).map((o) => h('li', {}, `${fmtDate(o.start)} → ${o.inProgress ? 'in corso' : fmtDate(o.end)} · ${o.type === 'unreachable' ? 'non raggiungibile' : 'offline'}`))) : null,
      );
    } catch (e) {
      mount(out, h('p', { class: 'small muted' }, `Storico non disponibile: ${err(e)}`));
    }
  }
  for (const [k, label] of Object.entries(ranges)) {
    const b = h('button', { type: 'button', 'data-range': k }, label);
    b.onclick = () => show(k);
    btns.append(b);
  }
  show('week');
  return h('div', {}, h('h3', {}, nms('Storico segnale (UISP)', 'Storico segnale')), btns, out);
}

/** Dashboard card: UISP connection test. */
export async function uispStatusCard() {
  const s = await api('/api/admin/uisp/status').catch((e) => ({ configured: true, ok: false, error: e.message }));
  if (!s.configured) return h('p', { class: 'small muted' }, 'Non configurata: impostala in ', h('a', { href: '#/connectors' }, 'Connettori'), ' per AP vicini, accettazione CPE e backup.');
  if (s.ok === false) return h('div', { class: 'notice bad' }, `Connessione UISP non riuscita: ${ERRORS[s.error] ?? s.error}${s.status ? ` (HTTP ${s.status})` : ''} · `, h('a', { href: '#/connectors' }, 'apri Connettori'));
  return h(
    'div',
    { class: 'grid' },
    stat('Dispositivi', s.devices),
    stat('AP', `${s.aps} (${s.apsWithLocation} con posizione)`),
    stat('In attesa', s.pending),
    stat('Site', s.sites),
    stat('Versione UISP', s.version ?? '—'),
    h('div', { class: 'stat' }, h('small', {}, 'Connessione'), badge('OK', 'good')),
  );
}
