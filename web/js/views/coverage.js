import { api } from '../api.js';
import { badge, busy, card, field, h, mount, pageHead, table } from '../dom.js';
import { createMap, fit, legend, MAP_COLORS as C, popup, towards } from '../map.js';
import { nms } from '../terms.js';

/**
 * Coverage check: nearest APs to a position (address, coordinates or this device's GPS).
 * Only the few APs within range are returned by the server: no network-wide map.
 */
export const osmLink = (lat, lon) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
const km = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);

export function apTable(aps) {
  return table(
    [
      { label: 'AP', render: (a) => h('div', {}, h('b', {}, a.name || a.id), h('div', { class: 'small muted' }, a.siteName ?? '')) },
      { label: 'SSID', render: (a) => h('span', { class: 'mono' }, a.ssid ?? '—') },
      { label: 'Distanza', render: (a) => km(a.distanceM) },
      { label: 'Puntamento', render: (a) => h('span', { class: 'bearing' }, h('span', { class: 'arrow', style: null, 'data-deg': a.bearing }, '↑'), ` ${a.bearing}° ${a.direction}`) },
      { label: 'Stato', render: (a) => badge(a.status === 'active' ? 'online' : a.status, a.status === 'active' ? 'good' : 'bad') },
      { label: 'Client', render: (a) => (a.stations ?? '—') },
      { label: 'Frequenza', render: (a) => (a.frequency ? `${a.frequency} MHz` : '—') },
    ],
    aps,
  );
}

/** Rotates the bearing arrows (inline styles are blocked by the CSP, so set them via CSSOM). */
export function orientArrows(root) {
  for (const el of root.querySelectorAll('.arrow[data-deg]')) el.style.transform = `rotate(${Number(el.dataset.deg)}deg)`;
}

/** The checked point and the APs: real positions for admins, approximate areas plus direction for installers. */
function coverageMap(la, lo, aps) {
  const el = h('div', { class: 'map' });
  const restricted = aps.some((a) => a.approx);
  const note = h('p', { class: 'small muted' }, restricted ? 'Gli AP sono mostrati come area approssimativa; la linea indica la direzione di puntamento.' : '');
  (async () => {
    const map = await createMap(el, { center: [la, lo], zoom: 13 });
    if (!map) return;
    const L = window.L;
    const layers = [L.circleMarker([la, lo], { radius: 7, color: C.point, weight: 2, fillOpacity: 0.9 }).bindPopup(popup('Punto verificato', `${la.toFixed(5)}, ${lo.toFixed(5)}`)).addTo(map)];
    for (const a of aps) {
      const info = [a.ssid, `${km(a.distanceM)} · ${a.bearing}° ${a.direction}`, a.stations != null ? `${a.stations} client` : null];
      const color = a.status === 'active' ? C.ap : C.impacted;
      if (a.approx) {
        layers.push(L.circle([a.approx.lat, a.approx.lon], { radius: a.approx.radiusM, color, weight: 1, fillOpacity: 0.1 }).bindPopup(popup(a.name, ...info, 'posizione approssimativa')).addTo(map));
        L.polyline([[la, lo], towards(la, lo, a.bearing, Math.min(a.distanceM, 600))], { color, weight: 3 }).addTo(map);
      } else {
        layers.push(L.circleMarker([a.lat, a.lon], { radius: 6, color, weight: 2, fillOpacity: 0.85 }).bindPopup(popup(a.name, ...info)).addTo(map));
        L.polyline([[la, lo], [a.lat, a.lon]], { color, weight: 2, dashArray: '6 6' }).addTo(map);
      }
    }
    fit(map, layers);
  })().catch((e) => (note.textContent = e.message));
  return h('div', {}, el, legend([[C.point, 'Punto verificato'], [C.ap, 'AP online'], [C.impacted, 'AP non attivo']]), note);
}

export async function coverageView() {
  const out = h('div', {});
  const addr = h('input', { placeholder: 'Via Roma 12, 94100 Enna', autocomplete: 'off' });
  const lat = h('input', { inputmode: 'decimal', placeholder: '37.5671' });
  const lon = h('input', { inputmode: 'decimal', placeholder: '14.2790' });
  const results = h('div', {});

  async function check(la, lo, label) {
    mount(out, h('p', { class: 'muted' }, 'Ricerca degli AP vicini…'));
    try {
      const r = await api(`/api/coverage?lat=${la}&lon=${lo}&limit=5`);
      mount(
        out,
        card(
          h('h2', {}, 'AP più vicini'),
          h('p', { class: 'small muted' }, `${label} · ${la.toFixed(5)}, ${lo.toFixed(5)} · `, h('a', { href: osmLink(la, lo), target: '_blank', rel: 'noopener' }, 'apri il punto su OpenStreetMap')),
          r.aps.length
            ? [coverageMap(la, lo, r.aps), apTable(r.aps)]
            : h('div', { class: 'notice warn' }, r.restricted && !r.assignedCount
                ? 'Nessun POP/AP assegnato al tuo account: chiedi all’amministratore.'
                : nms(`Nessun AP con posizione entro ${r.maxKm} km: verifica la posizione o le coordinate degli AP in UISP.`, `Nessun AP${r.restricted ? ' tra quelli assegnati' : ''} entro ${r.maxKm} km da questo punto.`)),
          h('p', { class: 'small muted' }, 'Il puntamento è l’azimut dalla posizione della CPE verso l’AP (0° = nord, senso orario). La copertura effettiva dipende da visibilità ottica, ostacoli e allineamento.'),
        ),
      );
      orientArrows(out);
    } catch (e) {
      mount(out, h('div', { class: 'notice bad' }, e.message));
    }
  }

  const searchBtn = h('button', { class: 'primary', type: 'submit' }, 'Cerca indirizzo');
  const addrForm = h(
    'form',
    {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        busy(searchBtn, async () => {
          const list = await api(`/api/geocode?q=${encodeURIComponent(addr.value)}`);
          mount(
            results,
            list.length
              ? h(
                  'div',
                  { class: 'btns' },
                  list.map((r) => {
                    const b = h('button', { type: 'button' }, r.label);
                    b.onclick = () => {
                      lat.value = r.lat;
                      lon.value = r.lon;
                      check(r.lat, r.lon, r.label);
                    };
                    return b;
                  }),
                )
              : h('div', { class: 'notice warn' }, 'Indirizzo non trovato: prova ad aggiungere comune o CAP.'),
          );
          if (list.length === 1) check(list[0].lat, list[0].lon, list[0].label);
        });
      },
    },
    field('Indirizzo (via, civico, CAP, comune)', addr),
    searchBtn,
  );

  const coordBtn = h('button', { type: 'submit' }, 'Verifica coordinate');
  const coordForm = h(
    'form',
    {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        const la = Number(lat.value.replace(',', '.'));
        const lo = Number(lon.value.replace(',', '.'));
        if (!Number.isFinite(la) || !Number.isFinite(lo)) return mount(out, h('div', { class: 'notice bad' }, 'Coordinate non valide'));
        check(la, lo, 'Coordinate inserite');
      },
    },
    field('Latitudine', lat),
    field('Longitudine', lon),
    coordBtn,
  );

  const gps = h('button', { type: 'button' }, 'Usa la posizione di questo dispositivo');
  gps.onclick = () => {
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      mount(out, h('div', { class: 'notice warn' }, 'Il browser consente la posizione solo su HTTPS: usa l’indirizzo, le coordinate o l’app Android.'));
      return;
    }
    gps.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        gps.disabled = false;
        lat.value = p.coords.latitude.toFixed(6);
        lon.value = p.coords.longitude.toFixed(6);
        check(p.coords.latitude, p.coords.longitude, `Posizione del dispositivo (±${Math.round(p.coords.accuracy)} m)`);
      },
      (err) => {
        gps.disabled = false;
        mount(out, h('div', { class: 'notice bad' }, `Posizione non disponibile: ${err.message}`));
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  return h(
    'div',
    {},
    pageHead('Copertura', 'Gli AP più vicini a un indirizzo o a una posizione, con distanza e direzione di puntamento. Vengono mostrati solo gli AP entro il raggio configurato.'),
    card(h('h2', {}, 'Da indirizzo'), addrForm, results),
    card(h('h2', {}, 'Da coordinate o GPS'), coordForm, h('div', { class: 'btns' }, gps)),
    out,
  );
}
