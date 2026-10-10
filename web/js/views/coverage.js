import { api } from '../api.js';
import { badge, busy, card, field, h, mount, pageHead, table } from '../dom.js';
import { createMap, drawCoverage, fit, legend, MAP_COLORS as C } from '../map.js';
import { nms } from '../terms.js';
import { adminCoverageView } from './coverage-admin.js';

/**
 * Coverage check: nearest APs to a position (address, coordinates or this device's GPS).
 * Only the few APs within range are returned by the server: no network-wide map.
 */
export const osmLink = (lat, lon) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
const km = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);

const CONF = { alta: 'good', media: 'warn', bassa: '' };
/** Rating from the server: APs are already sorted best first. */
export const RATING = { buono: ['buono', 'good'], possibile: ['possibile', 'warn'], 'senza stima': ['senza stima', ''], improbabile: ['improbabile', 'bad'], 'non attivo': ['non attivo', 'bad'] };

/** What the hills between the point and the AP do to the signal (same profile as Visibilità). */
const TERRAIN = {
  clear: () => 'terreno libero fino all’AP',
  fresnel: (db) => `una collina sfiora la linea di vista (−${Math.round(db)} dB)`,
  blocked: (db) => `ostruito dal terreno (−${Math.round(db)} dB): verifica con Visibilità`,
};

/** Expected signal of a new CPE: theory, terrain and the customers already on the AP. */
export function estimateCell(e) {
  if (!e || e.signalDbm == null) return h('span', { class: 'small muted' }, 'nessun cliente con segnale');
  return h(
    'div',
    {},
    h('b', {}, `${e.signalDbm} dBm`),
    h('span', { class: 'small muted' }, ` (${e.low}…${e.high})`),
    ' ',
    badge(`affidabilità ${e.confidence}`, CONF[e.confidence] ?? ''),
    e.inSector === false ? h('div', { class: 'small' }, 'fuori dal settore già servito') : null,
    e.beyondServed ? h('div', { class: 'small' }, 'più lontano dei clienti attuali') : null,
    e.tooFar ? h('div', { class: 'small' }, 'oltre 20 km: troppo lontano per un aggancio') : null,
    e.terrain ? h('div', { class: 'small' }, TERRAIN[e.terrain.verdict](e.terrain.lossDb)) : null,
    e.theoretical
      ? h('div', { class: 'small muted' }, 'stima teorica: l’AP non ha ancora clienti')
      : e.basis != null
        ? h('div', { class: 'small muted' }, `calibrata su ${e.basis} clienti${e.nearby ? `, ${e.nearby} vicini` : ''}`)
        : null,
  );
}

export function apTable(aps, admin = true) {
  return table(
    [
      { label: 'Valutazione', render: (a) => (a.rating ? badge(...RATING[a.rating]) : '—') },
      { label: 'AP', render: (a) => h('div', {}, h('b', {}, a.name || a.id), h('div', { class: 'small muted' }, a.siteName ?? '')) },
      { label: 'SSID', render: (a) => h('span', { class: 'mono' }, a.ssid ?? '—') },
      { label: 'Distanza', render: (a) => km(a.distanceM) },
      { label: 'Puntamento', render: (a) => h('span', { class: 'bearing' }, h('span', { class: 'arrow', style: null, 'data-deg': a.bearing }, '↑'), ` ${a.bearing}° ${a.direction}`) },
      { label: 'Segnale stimato', render: (a) => estimateCell(a.estimate) },
      { label: 'Stato', render: (a) => badge(a.status === 'active' ? 'online' : a.status, a.status === 'active' ? 'good' : 'bad') },
      { label: 'Client', render: (a) => (a.stations ?? '—') },
      admin ? { label: 'Frequenza', render: (a) => (a.frequency ? `${a.frequency} MHz` : '—') } : null,
    ].filter(Boolean),
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
    fit(map, drawCoverage(map, la, lo, aps));
  })().catch((e) => (note.textContent = e.message));
  return h(
    'div',
    {},
    el,
    legend([[C.point, 'Punto verificato'], [C.ap, restricted ? 'AP online' : 'AP online (tratteggio: area già servita dai clienti)'], [C.impacted, 'AP non attivo']]),
    note,
    h('p', { class: 'small muted' }, 'Il segnale stimato usa le CPE già collegate a ogni AP (posizione e segnale reale): distanza, direzione e clienti vicini al punto. Vale con visibilità ottica; ostacoli locali (alberi, edifici) possono peggiorarlo.'),
  );
}

export async function coverageView({ user } = {}) {
  // admins: the full page with the map of every AP and the radio simulation
  if (user?.role === 'admin') return adminCoverageView();
  const out = h('div', {});
  const addr = h('input', { placeholder: 'Via Roma 12, 94100 Enna', autocomplete: 'off' });
  const lat = h('input', { inputmode: 'decimal', placeholder: '37.5671' });
  const lon = h('input', { inputmode: 'decimal', placeholder: '14.2790' });
  const results = h('div', {});
  const admin = user?.role === 'admin';
  // admins: how many APs and how far (installers: the server's limits)
  const howMany = h('select', {}, ...[5, 10, 20, 50].map((n) => h('option', { value: n }, `${n} AP`)));
  const howFar = h('select', {}, ...[5, 10, 15, 20].map((n) => h('option', { value: n, selected: n === 20 }, `entro ${n} km`)));

  async function check(la, lo, label) {
    mount(out, h('p', { class: 'muted' }, 'Ricerca degli AP vicini…'));
    try {
      // installers: how many APs and how far are decided by the server (Impostazioni server, Connettori)
      const r = await api(`/api/coverage?lat=${la}&lon=${lo}${admin ? `&limit=${howMany.value}&km=${howFar.value}` : ''}`);
      mount(
        out,
        card(
          h('h2', {}, 'AP consigliati'),
          h('p', { class: 'small muted' }, `${label} · ${la.toFixed(5)}, ${lo.toFixed(5)} · `, h('a', { href: osmLink(la, lo), target: '_blank', rel: 'noopener' }, 'apri il punto su OpenStreetMap')),
          r.aps.length
            ? [coverageMap(la, lo, r.aps), apTable(r.aps, admin)]
            : h('div', { class: 'notice warn' }, r.restricted && !r.assignedCount
                ? 'Nessun POP/AP assegnato al tuo account: chiedi all’amministratore.'
                : r.discarded
                  ? `Nessun AP utilizzabile: ${r.discarded === 1 ? 'l’unico AP' : `tutti i ${r.discarded} AP`} entro ${r.maxKm} km ${r.discarded === 1 ? 'ha' : 'hanno'} un segnale stimato insufficiente o non ${r.discarded === 1 ? 'è attivo' : 'sono attivi'}.`
                  : nms(`Nessun AP con posizione entro ${r.maxKm} km: verifica la posizione o le coordinate degli AP in UISP.`, `Nessun AP${r.restricted ? ' tra quelli assegnati' : ''} entro ${r.maxKm} km da questo punto.`)),
          r.aps.length
            ? h(
                'p',
                { class: 'small muted' },
                `Ordinati dal segnale stimato migliore (minimo per il collaudo: ${r.minSignalDbm} dBm); a parità, il più vicino. ${r.inRange} AP valutati entro ${r.maxKm} km`,
                r.discarded ? `, ${r.discarded} scartati perché non attivi o con segnale stimato insufficiente` : '',
                r.aps.length < r.inRange - (r.discarded ?? 0) ? `, mostrati i primi ${r.aps.length}` : '',
                '.',
              )
            : null,
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
    pageHead(
      'Copertura',
      admin
        ? 'Gli AP più vicini a un indirizzo o a una posizione, con distanza, direzione di puntamento e segnale stimato. La mappa di tutta la rete è in Stato rete.'
        : 'Gli AP consigliati per un indirizzo o una posizione: prima quelli con il segnale stimato migliore, con distanza e direzione di puntamento, entro il raggio configurato.',
    ),
    admin ? card(h('h2', {}, 'Ricerca'), h('div', { class: 'row' }, field('Quanti AP', howMany), field('Distanza massima', howFar))) : null,
    card(h('h2', {}, 'Da indirizzo'), addrForm, results),
    card(h('h2', {}, 'Da coordinate o GPS'), coordForm, h('div', { class: 'btns' }, gps)),
    out,
  );
}
