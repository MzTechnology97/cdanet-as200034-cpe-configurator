import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, table, toast } from '../dom.js';

const KIND = { guasto_mt: ['Guasto MT', 'bad'], guasto_bt: ['Guasto BT', 'warn'], lavoro: ['Lavoro programmato', ''], altro: ['Interruzione', 'warn'] };
const local = (s) => (s ? s.replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '—');
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const osm = (o) => `https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lon}#map=15/${o.lat}/${o.lon}`;

/** Guasti Enel: outages and planned works of e-distribuzione in the CDA Net areas of interest. */
export async function outagesView({ user }) {
  const out = h('div', {});
  const adminBox = h('div', {});

  async function load() {
    const d = await api('/api/outages?recent=1');
    const faults = d.active.filter((o) => o.kind !== 'lavoro');
    mount(
      out,
      card(
        h(
          'div',
          { class: 'grid' },
          stat('Guasti in corso', faults.length),
          stat('Di cui media tensione', faults.filter((o) => o.kind === 'guasto_mt').length),
          stat('Lavori programmati', d.active.length - faults.length),
          stat('Clienti Enel disalimentati', d.active.reduce((a, o) => a + o.customers, 0)),
        ),
        h(
          'p',
          { class: 'small muted' },
          d.lastRun ? `Ultimo controllo ${fmtDate(d.lastRun.at)}${d.lastRun.ok ? '' : ` · errore: ${d.lastRun.error}`} · ` : 'Nessun controllo ancora eseguito · ',
          'fonte: mappa pubblica dei guasti di e-distribuzione, controllata ogni 10 minuti.',
        ),
      ),
      card(
        h('h2', {}, 'In corso nelle zone di interesse'),
        d.active.length
          ? table(
              [
                { label: 'Tipo', render: (o) => badge(KIND[o.kind]?.[0] ?? o.kind, KIND[o.kind]?.[1] ?? '') },
                { label: 'Località', render: (o) => h('div', {}, o.place || '—', h('div', { class: 'small muted' }, o.province)) },
                { label: 'Zona / AP', render: (o) => h('div', {}, o.zones[0]?.name ?? '—', h('div', { class: 'small muted' }, o.zones[0] ? `a ${dist(o.zones[0].distanceM)}${o.zones.length > 1 ? ` · +${o.zones.length - 1}` : ''}` : '')) },
                { label: 'Clienti', key: 'customers' },
                { label: 'Dal', render: (o) => local(o.start) },
                { label: 'Ripristino previsto', render: (o) => local(o.expectedRestore) },
                { label: '', render: (o) => h('a', { href: osm(o), target: '_blank', rel: 'noopener' }, 'mappa') },
              ],
              d.active,
            )
          : h('div', { class: 'notice good' }, 'Nessun guasto né lavoro in corso nelle zone di interesse.'),
      ),
      d.recent?.length
        ? card(
            h('h2', {}, 'Ripristinati nelle ultime 48 ore'),
            table(
              [
                { label: 'Tipo', render: (o) => badge(KIND[o.kind]?.[0] ?? o.kind, '') },
                { label: 'Località', render: (o) => `${o.place} (${o.province})` },
                { label: 'Zona / AP', render: (o) => o.zones[0]?.name ?? '—' },
                { label: 'Durata', render: (o) => `${fmtDate(o.firstSeen)} → ${fmtDate(o.endedAt)}` },
              ],
              d.recent,
            ),
          )
        : null,
    );
  }

  async function loadAdmin() {
    const c = await api('/api/admin/outages/config');
    const apZones = h('input', { type: 'checkbox' });
    apZones.checked = c.config.apZones;
    const radius = h('input', { type: 'number', min: 0.5, max: 30, step: 0.5, value: c.config.apRadiusKm });
    const planned = h('input', { type: 'checkbox' });
    planned.checked = c.config.includePlanned;
    const save = h('button', { type: 'button', class: 'primary' }, 'Salva impostazioni');
    save.onclick = () =>
      busy(save, async () => {
        await api('/api/admin/outages/config', { method: 'PUT', body: { apZones: apZones.checked, apRadiusKm: Number(radius.value) || 3, includePlanned: planned.checked } });
        toast('Impostazioni salvate');
        await loadAdmin();
      });

    const name = h('input', { placeholder: 'es. Nodo 7 Valle, Centro Enna' });
    const addr = h('input', { placeholder: 'Indirizzo oppure "37.58, 14.12"' });
    const zr = h('input', { type: 'number', min: 0.2, max: 50, step: 0.5, value: 2 });
    const add = h('button', { type: 'button' }, 'Aggiungi zona');
    add.onclick = () =>
      busy(add, async () => {
        let lat, lon;
        const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(addr.value);
        if (m) [lat, lon] = [Number(m[1]), Number(m[2])];
        else {
          const g = await api(`/api/geocode?q=${encodeURIComponent(addr.value.trim())}`);
          if (!g.length) throw new Error('Indirizzo non trovato');
          ({ lat, lon } = g[0]);
        }
        await api('/api/admin/outages/zones', { method: 'POST', body: { name: name.value.trim(), lat, lon, radiusKm: Number(zr.value) || 2 } });
        toast('Zona aggiunta');
        await loadAdmin();
      });
    const refresh = h('button', { type: 'button' }, 'Controlla ora');
    refresh.onclick = () =>
      busy(refresh, async () => {
        const r = await api('/api/admin/outages/refresh', { method: 'POST', body: {} });
        toast(r.ok ? `Controllo eseguito: ${r.active.length} eventi nelle zone` : `Errore: ${r.error}`, r.ok ? '' : 'bad');
        await load();
      });

    mount(
      adminBox,
      card(
        h('h2', {}, 'Zone di interesse'),
        h('label', { class: 'check' }, apZones, `Zona attorno a ogni AP di UISP (${c.apZonesCount} AP con posizione)`),
        h('div', { class: 'row' }, field('Raggio attorno agli AP (km)', radius)),
        h('label', { class: 'check' }, planned, 'Includi i lavori programmati'),
        h('div', { class: 'btns' }, save, refresh),
        h('h3', {}, 'Zone manuali'),
        c.zones.length
          ? table(
              [
                { label: 'Nome', key: 'name' },
                { label: 'Centro', render: (z) => h('a', { href: osm(z), target: '_blank', rel: 'noopener' }, `${z.lat.toFixed(4)}, ${z.lon.toFixed(4)}`) },
                { label: 'Raggio', render: (z) => `${z.radiusKm} km` },
                {
                  label: '',
                  render: (z) => {
                    const del = h('button', { type: 'button', class: 'danger' }, 'Elimina');
                    del.onclick = () => confirm(`Eliminare la zona ${z.name}?`) && busy(del, async () => { await api(`/api/admin/outages/zones/${z.id.slice(1)}`, { method: 'DELETE' }); await loadAdmin(); });
                    return del;
                  },
                },
              ],
              c.zones,
            )
          : h('p', { class: 'small muted' }, 'Nessuna zona manuale.'),
        h('div', { class: 'row' }, field('Nome', name), field('Indirizzo o coordinate', addr), field('Raggio (km)', zr), add),
        h('p', { class: 'small muted' }, 'Le notifiche Telegram si attivano in Connettori → Telegram → evento "Guasti Enel". Dall’app ogni utente può attivare le notifiche sul telefono.'),
      ),
    );
  }

  try {
    await load();
    if (user.role === 'admin') await loadAdmin();
  } catch (e) {
    mount(out, h('div', { class: 'notice bad' }, e.message));
  }
  return h('div', {}, pageHead('Guasti Enel', 'Guasti e lavori della rete elettrica (e-distribuzione) nelle zone di interesse e attorno agli AP.'), out, adminBox);
}
