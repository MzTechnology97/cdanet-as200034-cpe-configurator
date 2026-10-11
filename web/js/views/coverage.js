import { api } from '../api.js';
import { badge, busy, card, field, h, mount, pageHead, table } from '../dom.js';
import { createMap, drawCoverage, fit, legend, MAP_COLORS as C } from '../map.js';
import { nms } from '../terms.js';
import { adminCoverageView, DECLINATION_DEG, profileChart, signalBar } from './coverage-admin.js';

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
  fresnel: (db, t) => `${t.buildings ? 'degli edifici sfiorano' : 'una collina sfiora'} la linea di vista (−${Math.round(db)} dB)`,
  blocked: (db, t) => `ostruito ${t.buildings ? 'da edifici' : 'dal terreno'} (−${Math.round(db)} dB): verifica con Visibilità`,
};
/** Terrain line, and the trees crossed by the line of sight (land cover). */
const terrainText = (t) => [TERRAIN[t.verdict](t.lossDb - (t.foliageDb ?? 0), t), t.foliageM ? `attraversa ${t.foliageM} m di vegetazione (−${Math.round(t.foliageDb)} dB)` : null].filter(Boolean).join(' · ');

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
    e.terrain ? h('div', { class: 'small' }, terrainText(e.terrain)) : null,
    e.capacityMbps ? h('div', { class: 'small' }, `capacità del collegamento ~${e.capacityMbps} Mbit/s`) : null,
    e.theoretical
      ? h('div', { class: 'small muted' }, 'stima teorica: l’AP non ha ancora clienti')
      : e.basis != null
        ? h('div', { class: 'small muted' }, `calibrata su ${e.basis} ${e.basis === 1 ? 'cliente' : 'clienti'}${e.nearby ? `, ${e.nearby} ${e.nearby === 1 ? 'vicino' : 'vicini'}` : ''}`)
        : null,
  );
}

export function apTable(aps, admin = true, onRow = undefined) {
  return table(
    [
      { label: 'Valutazione', render: (a) => h('div', {}, a.rating ? badge(...RATING[a.rating]) : '—', a.failures ? h('div', { class: 'small' }, `${a.failures} ${a.failures === 1 ? 'installazione fallita' : 'installazioni fallite'} qui vicino verso questo AP`) : null) },
      { label: 'AP', render: (a) => h('div', {}, h('b', {}, a.name || a.id), h('div', { class: 'small muted' }, a.siteName ?? '')) },
      { label: 'SSID', render: (a) => h('span', { class: 'mono' }, a.ssid ?? '—') },
      { label: 'Distanza', render: (a) => km(a.distanceM) },
      { label: 'Puntamento', render: (a) => h('span', { class: 'bearing' }, h('span', { class: 'arrow', style: null, 'data-deg': a.bearing }, '↑'), ` ${a.bearing}° ${a.direction}`) },
      { label: 'Segnale stimato', render: (a) => estimateCell(a.estimate) },
      { label: 'Stato', render: (a) => badge(a.status === 'active' ? 'online' : a.status, a.status === 'active' ? 'good' : 'bad') },
      { label: 'Carico (20–23)', render: (a) => loadCell(a.load) },
      { label: 'Client', render: (a) => (a.stations ?? '—') },
      admin ? { label: 'Frequenza', render: (a) => (a.frequency ? `${a.frequency} MHz` : '—') } : null,
      { label: 'CPE', render: (a) => (a.cpe ? h('div', {}, a.cpe.name, h('div', { class: 'small muted' }, `${a.cpe.gainDbi} dBi${a.cpe.auto ? (a.cpe.proposed ? ' · consigliata' : '') : ''}`)) : '—') },
    ].filter(Boolean),
    aps,
    onRow,
  );
}

const LOAD = { libero: ['libero la sera', 'good'], medio: ['medio la sera', 'warn'], carico: ['carico la sera', 'bad'] };

/** Evening load of the AP: the verdict, and for admins the numbers behind it. */
export function loadCell(l) {
  if (!l || !l.level) return h('span', { class: 'small muted' }, '—');
  const n = (v, u) => (v === null || v === undefined ? null : `${v}${u}`);
  const details = [
    n(l.eveningAirtimePct, '% airtime'),
    n(l.eveningUtilizationPct, '% canale'),
    l.eveningPeakMbps != null ? `picco ${l.eveningPeakMbps}${l.capacityMbps ? `/${l.capacityMbps}` : ''} Mbit/s` : null,
    n(l.stations, ' CPE'),
    n(l.cpeAirtimePct, '% airtime per CPE'),
    l.snrDb != null ? `SNR ${l.snrDb} dB` : null,
    l.noiseDbm != null ? `rumore ${l.noiseDbm} dBm` : null,
  ].filter(Boolean);
  return h('div', {}, badge(...LOAD[l.level]), details.length ? h('div', { class: 'small muted' }, details.join(' · ')) : null);
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

  // the CPE to install and its height: they change the expected signal and the line of sight
  const cpeSel = h('select', {}, h('option', { value: 'auto' }, 'Consigliata per ogni AP'));
  const cpeHeight = h('input', { type: 'number', min: 1, max: 60, step: 1, inputmode: 'decimal', placeholder: 'predefinita' });
  const linkBox = h('div', {});
  let last = null; // the checked point and the AP of the open link
  let openAp = null;
  // another model or height: the same place checked again
  cpeSel.onchange = () => last && check(last.la, last.lo, last.label);
  cpeHeight.onchange = () => last && check(last.la, last.lo, last.label);

  /** The link with one AP, as in UISP Design: the figures, the CPE, the signal and the profile. */
  async function openLink(a) {
    if (!last) return;
    openAp = a.id;
    mount(linkBox, card(h('p', { class: 'muted' }, `Collegamento con ${a.name || a.id}…`)));
    let p;
    try {
      const hM = Number(cpeHeight.value);
      p = await api(`/api/pointing/profile?lat=${last.la}&lon=${last.lo}&apId=${encodeURIComponent(a.id)}${hM >= 1 ? `&height=${hM}` : ''}`);
    } catch (e) {
      return mount(linkBox, card(h('h2', {}, `Collegamento con ${a.name || a.id}`), h('div', { class: 'notice bad' }, e.message)));
    }
    const first = p.chart[0];
    const end = p.chart[p.chart.length - 1];
    const tilt = (Math.atan2(end.los - first.los, p.distanceM) * 180) / Math.PI;
    const free = p.worst ? Math.max(0, Math.round((100 * p.worst.clearanceM) / (p.worst.fresnel60M / 0.6 || 1))) : 100;
    const verdict = { clear: ['Linea libera', 'good'], fresnel: ['Fresnel invasa', 'warn'], blocked: [p.buildings ? 'Ostruita da edifici' : 'Ostruita dal terreno', 'bad'] }[p.verdict];
    const fact = (label, value, sub) => h('div', { class: 'link-fact' }, h('small', {}, label), h('strong', {}, value), sub ? h('span', { class: 'small muted' }, sub) : null);
    const step = (d) => () => {
      const now = Number(cpeHeight.value) || Math.round(first.los - first.ground);
      cpeHeight.value = String(Math.max(1, Math.min(60, now + d)));
      check(last.la, last.lo, last.label);
    };
    mount(
      linkBox,
      card(
        h('div', { class: 'link-head' }, h('h2', {}, `Collegamento con ${a.name || a.id}`), badge(verdict[0], verdict[1])),
        h(
          'div',
          { class: 'link-facts' },
          fact('Distanza', km(a.distanceM)),
          fact('Puntamento', `${a.bearing}° ${a.direction}`, `magnetico ${Math.round((a.bearing - DECLINATION_DEG + 360) % 360)}° · inclinazione ${tilt >= 0 ? '+' : ''}${Math.round(tilt * 10) / 10}°`),
          fact('Fresnel libera', `${free}%`, p.worst ? `punto critico a ${km(Math.round(p.worst.d / 50) * 50)}` : 'su tutto il collegamento'),
          a.estimate?.capacityMbps != null ? fact('Capacità stimata', `${a.estimate.capacityMbps} Mbit/s`) : null,
          a.cpe ? fact('CPE', a.cpe.name, `${a.cpe.gainDbi} dBi${a.cpe.auto ? (a.cpe.proposed ? ' · consigliata' : '') : ''}`) : null,
          h('div', { class: 'link-fact' }, h('small', {}, 'Altezza CPE'), h('div', { class: 'stepper' }, h('button', { type: 'button', onclick: step(-1) }, '−'), h('strong', {}, `${Math.round(first.los - first.ground)} m`), h('button', { type: 'button', onclick: step(1) }, '+'))),
        ),
        p.roofM ? h('p', { class: 'small muted' }, `Sul tetto: edificio di circa ${p.roofM} m, antenna a ${Math.round(p.mountedM)} m dal suolo.`) : null,
        signalBar(a.estimate?.signalDbm ?? null),
        profileChart(p),
        h('p', { class: 'small muted' }, p.verdict === 'clear' ? 'Profilo del terreno con edifici e alberi; verifica sempre a vista sul posto.' : p.raiseCpeM > 0 && p.raiseCpeM <= 15 ? `Alzando la CPE di ${Math.round(p.raiseCpeM * 10) / 10} m si libera la linea.` : 'Con questo AP la linea non si libera alzando la CPE: valuta un altro AP o un altro punto della casa.'),
      ),
    );
  }

  async function check(la, lo, label) {
    last = { la, lo, label };
    mount(out, h('p', { class: 'muted' }, 'Ricerca degli AP vicini…'));
    try {
      // installers: how many APs and how far are decided by the server (Impostazioni server, Connettori)
      const hM = Number(cpeHeight.value);
      const r = await api(`/api/coverage?lat=${la}&lon=${lo}${admin ? `&limit=${howMany.value}&km=${howFar.value}` : ''}&cpe=${encodeURIComponent(cpeSel.value)}${hM >= 1 ? `&height=${hM}` : ''}`);
      if (cpeSel.options.length === 1) for (const m of r.cpeModels ?? []) cpeSel.append(h('option', { value: m.id }, `${m.name} · ${m.gainDbi} dBi`));
      // the open link follows the check (another CPE or height), closed for a new place
      const again = openAp ? r.aps.find((x) => x.id === openAp) : null;
      if (again) setTimeout(() => openLink(again), 0);
      else mount(linkBox);
      mount(
        out,
        card(
          h('h2', {}, 'AP consigliati'),
          h('p', { class: 'small muted' }, `${label} · ${la.toFixed(5)}, ${lo.toFixed(5)} · `, h('a', { href: osmLink(la, lo), target: '_blank', rel: 'noopener' }, 'apri il punto su OpenStreetMap')),
          r.aps.length
            ? [coverageMap(la, lo, r.aps), apTable(r.aps, admin, (a) => openLink(a)), h('p', { class: 'small muted' }, 'Tocca un AP per il collegamento: puntamento, inclinazione, CPE consigliata, segnale atteso e profilo.')]
            : h('div', { class: 'notice warn' }, r.restricted && !r.assignedCount
                ? 'Nessun POP/AP assegnato al tuo account: chiedi all’amministratore.'
                : r.hiddenWeak
                  ? `Nessun AP con segnale stimato migliore di ${r.hideBelowDbm} dBm: ${r.hiddenWeak === 1 ? 'l’unico AP utile è più debole' : `${r.hiddenWeak} AP sono più deboli`} e non ${r.hiddenWeak === 1 ? 'viene mostrato' : 'vengono mostrati'} (Impostazioni server).`
                  : r.discarded
                  ? `Nessun AP utilizzabile: ${r.discarded === 1 ? 'l’unico AP' : `tutti i ${r.discarded} AP`} entro ${r.maxKm} km ${r.discarded === 1 ? 'ha' : 'hanno'} un segnale stimato insufficiente o non ${r.discarded === 1 ? 'è attivo' : 'sono attivi'}.`
                  : nms(`Nessun AP con posizione entro ${r.maxKm} km: verifica la posizione o le coordinate degli AP in UISP.`, `Nessun AP${r.restricted ? ' tra quelli assegnati' : ''} entro ${r.maxKm} km da questo punto.`)),
          r.aps.length
            ? h(
                'p',
                { class: 'small muted' },
                `Ordinati dal segnale stimato migliore (minimo per il collaudo: ${r.minSignalDbm} dBm); a parità, il più vicino. ${r.inRange} AP valutati entro ${r.maxKm} km`,
                r.discarded ? `, ${r.discarded} scartati perché non attivi o con segnale stimato insufficiente` : '',
                r.hiddenWeak ? `, ${r.hiddenWeak} non mostrati perché più deboli di ${r.hideBelowDbm} dBm` : '',
                r.aps.length < r.inRange - (r.discarded ?? 0) - (r.hiddenWeak ?? 0) ? `, mostrati i primi ${r.aps.length}` : '',
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
    card(
      h('h2', {}, 'CPE da installare'),
      h('div', { class: 'row' }, field('Modello', cpeSel), field('Altezza dal suolo (m)', cpeHeight)),
      h('p', { class: 'small muted' }, 'Con «Consigliata» per ogni AP viene proposta la CPE più piccola che dà un buon segnale. Il modello e l’altezza cambiano il segnale atteso e la visibilità.'),
    ),
    out,
    linkBox,
  );
}
