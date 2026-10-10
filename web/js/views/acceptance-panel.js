import { api } from '../api.js';
import { badge, fmtDate, h, mount, stat } from '../dom.js';

const VERDICT = { ok: ['superato', 'good'], warn: ['con riserva', 'warn'], bad: ['non superato', 'bad'] };
const MARK = { ok: '✔', warn: '⚠', bad: '✖', info: '•' };

export const acceptanceBadge = (v) => (v ? badge(VERDICT[v]?.[0] ?? v, VERDICT[v]?.[1] ?? '') : null);

const n = (v, unit, digits = 0) => (v == null ? '—' : `${Number(v).toFixed(digits)} ${unit}`);

async function photoUrl(jobId, id) {
  const r = await api(`/api/provisioning/jobs/${jobId}/photos/${id}`, { raw: true });
  if (!r.ok) throw new Error(`foto ${id}: HTTP ${r.status}`);
  const blob = await r.blob();
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

function measures(a) {
  const r = a.radio ?? {};
  return [
    ['Segnale', r.signal != null ? `${r.signal} dBm${r.signalMin != null ? ` (min ${r.signalMin} / max ${r.signalMax})` : ''}` : '—'],
    ['Segnale atteso', n(r.expectedSignal, 'dBm')],
    ['Segnale lato AP', n(r.remoteSignal, 'dBm')],
    ['Catene', r.chains?.length ? `${r.chains.join(' / ')} dBm` : '—'],
    ['Rumore', n(r.noise, 'dBm')],
    ['CINR', n(r.cinrRx, 'dB')],
    ['Capacità', r.dlCapacityMbps != null ? `${Math.round(r.dlCapacityMbps)} / ${Math.round(r.ulCapacityMbps ?? 0)} Mbit/s` : '—'],
    ['AP', [a.cpe?.apName, a.cpe?.essid].filter(Boolean).join(' · ') || '—'],
    ['Distanza', a.cpe?.distanceM != null ? (a.cpe.distanceM >= 1000 ? `${(a.cpe.distanceM / 1000).toFixed(1)} km` : `${a.cpe.distanceM} m`) : '—'],
    ['Porta LAN', a.lan ? (a.lan.plugged ? `${a.lan.speedMbps} Mbit/s ${a.lan.fullDuplex ? 'full' : 'half'}` : 'scollegata') : '—'],
    ['PPPoE', a.pppoe?.enabled ? a.pppoe.ip || 'non attivo' : '—'],
    ['Internet (dal cliente)', a.internet?.tested ? `${n(a.internet.downloadMbps, '↓ Mbit/s', 1)} · ${n(a.internet.uploadMbps, '↑ Mbit/s', 1)} · ping ${n(a.internet.pingMs, 'ms')}` : a.internet?.note || 'non misurato'],
    ['Firmware', a.cpe?.firmware || '—'],
    ['Altezza CPE dal suolo', a.cpeHeightM != null ? `${String(a.cpeHeightM).replace('.', ',')} m` : '—'],
  ];
}

/** Printable "verbale di installazione" in a new window (browser print → PDF). */
async function printReport(j, a, photos) {
  const w = window.open('', '_blank');
  if (!w) return alert('Consenti le finestre pop-up per stampare il verbale.');
  w.document.write('<p style="font-family:sans-serif">Preparazione del verbale…</p>');
  const imgs = await Promise.all(photos.map(async (p) => ({ ...p, src: await photoUrl(j.id, p.id).catch(() => '') })));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const rows = (list) => list.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Verbale installazione ${esc(j.deviceName || j.mac)}</title>
<style>
body{font:13px/1.45 system-ui,sans-serif;color:#111;margin:24px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px;border-bottom:1px solid #ccc}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #eee;vertical-align:top}th{width:34%;color:#444;font-weight:600}
.v{display:inline-block;padding:2px 8px;border-radius:10px;font-weight:600}.ok{background:#dcfce7}.warn{background:#fef3c7}.bad{background:#fee2e2}
.ph{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.ph figure{margin:0;break-inside:avoid}.ph img{width:100%;border:1px solid #ddd}.ph figcaption{font-size:12px;color:#444}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}.sign div{border-top:1px solid #333;padding-top:4px}
@media print{body{margin:10mm}button{display:none}}
</style></head><body>
<button onclick="print()">Stampa / salva PDF</button>
<h1>Verbale di installazione CPE</h1>
<div>CDA Net · AS200034 · collaudo del ${esc(fmtDate(a.measuredAt))} · esito <span class="v ${esc(a.verdict)}">${esc(VERDICT[a.verdict]?.[0] ?? a.verdict)}</span></div>
<h2>Installazione</h2><table>${rows([
    ['Cliente', j.deviceName || '—'],
    ['Utente PPPoE', j.pppoeUser],
    ['CPE', `${j.model} · MAC ${j.mac} · S/N ${j.serial || '—'}`],
    ['SSID', j.ssid],
    ['Posizione', j.latitude != null ? `${j.latitude.toFixed(6)}, ${j.longitude.toFixed(6)}` : '—'],
    ['Installatore', a.by || j.installer || '—'],
  ])}</table>
<h2>Misure</h2><table>${rows(measures(a))}</table>
<h2>Controlli</h2><table>${(a.checks ?? []).map((c) => `<tr><th>${MARK[c.verdict] ?? ''} ${esc(c.title)}</th><td>${esc(c.detail)}</td></tr>`).join('')}</table>
${a.notes ? `<h2>Note</h2><p>${esc(a.notes)}</p>` : ''}
${imgs.length ? `<h2>Foto</h2><div class="ph">${imgs.map((p) => `<figure>${p.src ? `<img src="${p.src}">` : ''}<figcaption>${esc(p.caption || `Foto ${p.id}`)} · ${esc(fmtDate(p.createdAt))}</figcaption></figure>`).join('')}</div>` : ''}
<div class="sign"><div>L'installatore</div><div>Il cliente</div></div>
</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** "Collaudo" section of a job in the history: measures, checks, notes, photos, printable report. */
export function acceptancePanel(j) {
  const box = h('div', {}, h('p', { class: 'small muted' }, 'Caricamento collaudo…'));
  api(`/api/provisioning/jobs/${j.id}/acceptance`)
    .then(async ({ acceptance: a, photos }) => {
      const gallery = h('div', { class: 'photos' });
      if (!a && !photos.length) {
        return mount(box, h('p', { class: 'small muted' }, 'Collaudo non ancora eseguito: si fa dall’app (Storico → job → Collaudo).'));
      }
      mount(
        box,
        a
          ? h(
              'div',
              {},
              h('p', {}, acceptanceBadge(a.verdict), ` ${fmtDate(a.createdAt)} · ${a.by}${a.samples > 1 ? ` · media di ${a.samples} letture` : ''}`),
              h('div', { class: 'grid' }, measures(a).map(([k, v]) => stat(k, v))),
              a.checks?.length ? h('ul', { class: 'plain' }, a.checks.map((c) => h('li', {}, `${MARK[c.verdict] ?? ''} ${c.title}: ${c.detail}`))) : null,
              a.notes ? h('p', {}, h('b', {}, 'Note: '), a.notes) : null,
            )
          : h('p', { class: 'small muted' }, 'Misure non ancora inviate.'),
        photos.length ? gallery : null,
        a ? h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => printReport(j, a, photos) }, 'Verbale di installazione (stampa / PDF)')) : null,
      );
      for (const p of photos) {
        const img = h('img', { alt: p.caption || `Foto ${p.id}`, loading: 'lazy' });
        gallery.append(h('figure', {}, img, h('figcaption', { class: 'small muted' }, p.caption || `Foto ${p.id}`)));
        photoUrl(j.id, p.id).then((src) => (img.src = src)).catch(() => img.replaceWith(h('span', { class: 'small muted' }, 'foto non disponibile')));
      }
    })
    .catch((e) => mount(box, h('p', { class: 'small muted' }, `Collaudo non disponibile: ${e.message}`)));
  return box;
}
