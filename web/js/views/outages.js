import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, table, toast } from '../dom.js';
import { createMap, drawOutages, fit, legend, MAP_COLORS as C } from '../map.js';
import { itemLabel, itemNames, picker } from './infra-picker.js';
import { myTelegramCard } from './my-telegram.js';

const KIND = { guasto_mt: ['Guasto MT', 'bad'], guasto_bt: ['Guasto BT', 'warn'], lavoro: ['Lavoro programmato', ''], altro: ['Interruzione', 'warn'] };
const local = (s) => (s ? s.replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '—');
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const osm = (o) => `https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lon}#map=15/${o.lat}/${o.lon}`;

/**
 * New area of interest: GPS of the device (with the address filled in), address search or typed
 * coordinates (with "address from coordinates"). [post] stores it (shared zone or personal zone).
 */
function zoneForm({ post, onDone, rules = false }) {
  const name = h('input', { placeholder: 'es. Centro Enna, casa, frazione' });
  const street = h('input', { placeholder: 'Via Roma' });
  const number = h('input', { placeholder: '12', inputmode: 'numeric' });
  const city = h('input', { placeholder: 'Enna' });
  const prov = h('input', { placeholder: 'EN', maxlength: 30 });
  const cap = h('input', { placeholder: '94100', inputmode: 'numeric', maxlength: 5 });
  const lat = h('input', { placeholder: '37.5670', inputmode: 'decimal' });
  const lon = h('input', { placeholder: '14.2790', inputmode: 'decimal' });
  const zr = h('input', { type: 'number', min: 0.2, max: 50, step: 0.5, value: 2 });
  const where = h('p', { class: 'small muted' });
  // personal zones: which outages to be notified about (planned works off by default)
  const mt = h('input', { type: 'checkbox', checked: true });
  const bt = h('input', { type: 'checkbox', checked: true });
  const planned = h('input', { type: 'checkbox' });
  const fillAddress = async (la, lo) => {
    const r = await api(`/api/geocode/reverse?lat=${la}&lon=${lo}`).catch(() => null);
    if (!r) return;
    street.value = r.street;
    number.value = r.houseNumber;
    city.value = r.city;
    prov.value = r.province;
    cap.value = r.postcode;
    if (!name.value.trim()) name.value = [r.street, r.city].filter(Boolean).join(', ');
    where.textContent = r.label;
  };
  const gps = h('button', { type: 'button' }, 'Usa GPS di questo dispositivo');
  gps.onclick = () =>
    busy(gps, async () => {
      if (!navigator.geolocation) throw new Error('Geolocalizzazione non disponibile in questo browser');
      if (!window.isSecureContext) throw new Error('Il GPS del browser funziona solo con la console in HTTPS');
      const p = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, (e) => rej(new Error(e.code === 1 ? 'Permesso di posizione negato' : 'Posizione non disponibile')), { enableHighAccuracy: true, timeout: 20000 }));
      lat.value = p.coords.latitude.toFixed(6);
      lon.value = p.coords.longitude.toFixed(6);
      where.textContent = `Precisione ±${Math.round(p.coords.accuracy)} m · ricerca indirizzo…`;
      await fillAddress(p.coords.latitude, p.coords.longitude);
    });
  const find = h('button', { type: 'button' }, 'Cerca indirizzo');
  find.onclick = () =>
    busy(find, async () => {
      const q = [[street.value, number.value].filter(Boolean).join(' '), cap.value, city.value, prov.value].map((x) => x.trim()).filter(Boolean).join(', ');
      if (q.length < 3) throw new Error('Inserisci almeno via e città');
      const g = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!g.length) throw new Error('Indirizzo non trovato');
      lat.value = g[0].lat.toFixed(6);
      lon.value = g[0].lon.toFixed(6);
      where.textContent = g[0].label;
      if (!name.value.trim()) name.value = [street.value, city.value].map((x) => x.trim()).filter(Boolean).join(', ');
    });
  const fromCoords = h('button', { type: 'button' }, 'Indirizzo dalle coordinate');
  fromCoords.onclick = () => busy(fromCoords, () => fillAddress(Number(lat.value.replace(',', '.')), Number(lon.value.replace(',', '.'))));
  const add = h('button', { type: 'button', class: 'primary' }, 'Aggiungi zona');
  add.onclick = () =>
    busy(add, async () => {
      const la = Number(lat.value.replace(',', '.'));
      const lo = Number(lon.value.replace(',', '.'));
      if (!lat.value || !lon.value || !Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('Coordinate mancanti: usa il GPS, cerca l’indirizzo o inseriscile a mano');
      await post({ name: name.value.trim(), lat: la, lon: lo, radiusKm: Number(zr.value) || 2, ...(rules ? { notifyMt: mt.checked, notifyBt: bt.checked, notifyPlanned: planned.checked } : {}) });
      toast('Zona aggiunta: entra nel prossimo controllo (entro 10 minuti)');
      await onDone();
    });
  return h(
    'div',
    {},
    h('h3', {}, 'Nuova zona'),
    h('div', { class: 'row' }, field('Nome', name), field('Raggio (km)', zr)),
    h('div', { class: 'btns' }, gps),
    h('div', { class: 'row' }, field('Via', street), field('Civico', number), field('Città', city), field('Provincia', prov), field('CAP', cap)),
    h('div', { class: 'btns' }, find),
    h('div', { class: 'row' }, field('Latitudine', lat), field('Longitudine', lon)),
    rules
      ? h('div', { class: 'btns' }, h('span', { class: 'small muted' }, 'Avvisami di:'), h('label', {}, mt, ' guasti media tensione'), h('label', {}, bt, ' guasti bassa tensione'), h('label', {}, planned, ' lavori programmati'))
      : null,
    h('div', { class: 'btns' }, fromCoords, add),
    where,
  );
}

const zonesTable = (zones, del, owner = false) =>
  table(
    [
      ...(owner ? [{ label: 'Installatore', key: 'owner' }] : []),
      { label: 'Nome', key: 'name' },
      { label: 'Centro', render: (z) => h('a', { href: osm(z), target: '_blank', rel: 'noopener' }, `${z.lat.toFixed(4)}, ${z.lon.toFixed(4)}`) },
      { label: 'Raggio', render: (z) => `${z.radiusKm} km` },
      {
        label: '',
        render: (z) => {
          const b = h('button', { type: 'button', class: 'danger' }, 'Elimina');
          b.onclick = () => confirm(`Eliminare la zona ${z.name}?`) && busy(b, () => del(z));
          return b;
        },
      },
    ],
    zones,
  );

/**
 * The user's own areas of interest, each with its rules: active or paused, and which outages notify
 * (app and personal Telegram). Changes are saved at once.
 */
const myZonesTable = (zones, onChange, del) => {
  const save = async (z, patch, el) => {
    el.disabled = true;
    try {
      await api(`/api/outages/zones/${z.id.slice(1)}`, { method: 'PUT', body: patch });
      await onChange();
    } catch (e) {
      toast(e.message, 'bad');
      el.disabled = false;
    }
  };
  const check = (z, key, label) => {
    const c = h('input', { type: 'checkbox', checked: z[key], disabled: z.paused });
    c.onchange = () => save(z, { [key]: c.checked }, c);
    return h('label', { class: 'small' }, c, ` ${label}`);
  };
  return table(
    [
      { label: 'Zona', render: (z) => h('div', {}, h('strong', {}, z.name), h('div', { class: 'small muted' }, h('a', { href: osm(z), target: '_blank', rel: 'noopener' }, `${z.lat.toFixed(4)}, ${z.lon.toFixed(4)}`), ` · ${z.radiusKm} km`)) },
      { label: 'Ora', render: (z) => (z.activeCount ? badge(`${z.activeCount} ${z.activeCount === 1 ? 'interruzione' : 'interruzioni'}`, 'warn') : badge('nessuna', 'good')) },
      { label: 'Avvisi', render: (z) => h('div', { class: 'btns' }, check(z, 'notifyMt', 'MT'), check(z, 'notifyBt', 'BT'), check(z, 'notifyPlanned', 'lavori')) },
      {
        label: '',
        render: (z) => {
          const p = h('button', { type: 'button' }, z.paused ? 'Riattiva' : 'Metti in pausa');
          p.onclick = () => save(z, { paused: !z.paused }, p);
          const b = h('button', { type: 'button', class: 'danger' }, 'Elimina');
          b.onclick = () => confirm(`Eliminare la zona ${z.name}?`) && busy(b, () => del(z));
          return h('div', { class: 'btns' }, z.paused ? badge('in pausa', 'warn') : null, p, b);
        },
      },
    ],
    zones,
  );
};

/** Map of outages, zones and POPs/APs (installers: only assigned POPs/APs, as an approximate area). */
function outagesMap(admin) {
  const el = h('div', { class: 'map' });
  const note = h('p', { class: 'small muted' }, admin ? '' : 'POP e AP sono mostrati come area approssimativa.');
  const box = card(
    h('h2', {}, 'Mappa'),
    el,
    legend([
      [C.guasto_mt, 'Guasto MT'],
      [C.guasto_bt, 'Guasto BT'],
      [C.lavoro, 'Lavoro programmato'],
      [C.pop, 'POP'],
      [C.ap, 'AP'],
      [C.impacted, 'POP/AP potenzialmente impattato'],
      [admin ? C.zone : C.personal, admin ? 'Zona condivisa / personale' : 'Le tue zone'],
    ]),
    note,
  );
  (async () => {
    const map = await createMap(el);
    if (!map) return;
    const d = await api('/api/outages/map');
    const layers = drawOutages(map, d);
    fit(map, layers);
  })().catch((e) => (note.textContent = e.message));
  return box;
}

/** Guasti Enel: outages and planned works in the areas of interest (admins: everything; installers: their own). */
export async function outagesView({ user }) {
  const admin = user.role === 'admin';
  const out = h('div', {});
  const adminBox = h('div', {});
  const infraBox = h('div', {});
  const myBox = h('div', {});
  const mapBox = outagesMap(admin);

  /** Admin: POPs and APs straight from UISP (names, addresses, coordinates): pick the ones to monitor. */
  async function loadInfra() {
    let inf, sel, cfg;
    try {
      [inf, sel, cfg] = await Promise.all([api('/api/admin/outages/infra'), api('/api/admin/outages/selection'), api('/api/admin/outages/config')]);
    } catch (e) {
      mount(infraBox, card(h('h2', {}, 'POP e AP da UISP'), h('p', { class: 'small muted' }, e.body?.error === 'uisp_not_configured' ? 'UISP non configurato: POP e AP arrivano da UISP (Connettori).' : e.message)));
      return;
    }
    const names = itemNames(inf, cfg.zones);
    for (const it of sel.items) if (!names.has(it.key)) names.set(it.key, it.name);
    const chosen = new Set(sel.items.map((i) => i.key));
    const all = h('input', { type: 'radio', name: 'selmode' });
    const only = h('input', { type: 'radio', name: 'selmode' });
    (sel.selectionOnly ? only : all).checked = true;
    const pick = picker({ inf, chosen, cascade: true });
    const count = h('span', { class: 'small muted' });
    const upd = () => (count.textContent = `${[...chosen].filter((k) => k.startsWith('pop:')).length} POP · ${[...chosen].filter((k) => k.startsWith('ap:')).length} AP selezionati`);
    pick.onChange = upd;
    upd();
    const allBtn = h('button', { type: 'button' }, 'Seleziona tutti');
    allBtn.onclick = () => {
      for (const k of names.keys()) if (!k.startsWith('z')) chosen.add(k);
      pick.render();
      upd();
    };
    const noneBtn = h('button', { type: 'button' }, 'Nessuno');
    noneBtn.onclick = () => {
      chosen.clear();
      pick.render();
      upd();
    };
    const save = h('button', { type: 'button', class: 'primary' }, 'Salva selezione');
    save.onclick = () =>
      busy(save, async () => {
        if (only.checked && !chosen.size) throw new Error('Seleziona almeno un POP o un AP, oppure scegli "tutti"');
        await api('/api/admin/outages/selection', { method: 'PUT', body: { selectionOnly: only.checked, items: [...chosen].map((key) => ({ key, name: names.get(key) ?? key })) } });
        toast(only.checked ? `Monitorati solo i ${chosen.size} POP/AP selezionati` : 'Monitorati tutti i POP/AP di UISP');
        await Promise.all([loadInfra(), loadAdmin()]);
      });
    const live = new Set(itemNames(inf, []).keys());
    const gone = sel.items.filter((i) => !live.has(i.key));
    mount(
      infraBox,
      card(
        h('h2', {}, `POP e AP da UISP: ${inf.pops.length} POP · ${inf.pops.reduce((t, p) => t + p.aps.length, 0) + inf.apsWithoutPop.length} AP`),
        h('p', { class: 'small muted' }, 'Elenco, nomi, indirizzi e coordinate sono importati da UISP a ogni controllo: per correggerli modifica il site o il dispositivo in UISP. Un AP senza posizione propria usa quella del suo POP.'),
        inf.missing.pops.length || inf.missing.aps.length
          ? h('div', { class: 'notice warn' }, `Senza posizione in UISP (non monitorabili): ${[...inf.missing.pops.map((n) => `POP ${n}`), ...inf.missing.aps.map((n) => `AP ${n}`)].join(', ')}. Impostala in UISP → Sites/Devices → Location.`)
          : null,
        h('label', { class: 'check' }, all, 'Monitora tutti i POP e gli AP di UISP'),
        h('label', { class: 'check' }, only, 'Monitora solo quelli selezionati qui sotto'),
        gone.length ? h('div', { class: 'notice warn' }, `Selezionati ma non più presenti in UISP: ${gone.map((i) => i.name).join(', ')}.`) : null,
        h('div', { class: 'btns' }, allBtn, noneBtn, count),
        pick.el,
        h('div', { class: 'btns' }, save),
        h('p', { class: 'small muted' }, 'Quali POP/AP vede ogni installatore (guasti e verifica copertura) si decide in Account → POP/AP assegnati agli installatori.'),
      ),
    );
  }

  /** Installer: own areas of interest. */
  async function loadMine() {
    const { zones, max } = await api('/api/outages/zones');
    mount(
      myBox,
      card(
        h('h2', {}, 'Le mie aree di interesse'),
        h(
          'p',
          { class: 'small muted' },
          `Luoghi che vuoi seguire, anche fuori dai POP/AP che ti sono assegnati (massimo ${max ?? 20}). Per ognuna scegli quali avvisi ricevere sul telefono e su Telegram, oppure mettila in pausa: i guasti restano comunque visibili qui. I POP/AP potenzialmente impattati li vedi solo per quelli assegnati.`,
        ),
        zones.length
          ? myZonesTable(zones, loadMine, async (z) => {
              await api(`/api/outages/zones/${z.id.slice(1)}`, { method: 'DELETE' });
              await loadMine();
            })
          : h('p', { class: 'small muted' }, 'Nessuna area: aggiungine una qui sotto.'),
        zoneForm({ post: (body) => api('/api/outages/zones', { method: 'POST', body }), onDone: loadMine, rules: true }),
      ),
    );
  }

  async function load() {
    const d = await api('/api/outages?recent=1');
    const faults = d.active.filter((o) => o.kind !== 'lavoro');
    const seesImpact = admin || d.scope?.assigned?.length > 0;
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
          seesImpact ? stat('POP/AP potenzialmente impattati', new Set(d.active.flatMap((o) => o.impact.map((i) => `${i.type}:${i.id}`))).size) : null,
        ),
        admin
          ? h('p', { class: 'small muted' }, d.lastRun ? `Ultimo controllo ${fmtDate(d.lastRun.at)}${d.lastRun.ok ? '' : ` · errore: ${d.lastRun.error}`} · ` : 'Nessun controllo ancora eseguito · ', 'fonte: mappa pubblica dei guasti di e-distribuzione, controllata ogni 10 minuti.')
          : h('p', { class: 'small muted' }, d.generatedAt ? `Aggiornato ${fmtDate(d.generatedAt)} · ogni 10 minuti` : 'In attesa del primo aggiornamento'),
      ),
      mapBox,
      !admin && d.scope
        ? card(
            h('h2', {}, 'POP/AP assegnati a te'),
            d.scope.assigned.length
              ? h('div', { class: 'btns' }, d.scope.assigned.map((i) => badge(itemLabel(i), '')))
              : h('p', { class: 'small muted' }, 'Nessuno: vedi i guasti nelle tue zone, senza i POP/AP potenzialmente impattati.'),
          )
        : null,
      card(
        h('h2', {}, admin ? 'In corso nelle zone di interesse' : 'In corso nelle tue zone'),
        d.active.length
          ? table(
              [
                { label: 'Tipo', render: (o) => badge(KIND[o.kind]?.[0] ?? o.kind, KIND[o.kind]?.[1] ?? '') },
                { label: 'Località', render: (o) => h('div', {}, o.place || '—', h('div', { class: 'small muted' }, o.province)) },
                { label: 'Zona', render: (o) => h('div', {}, o.zones[0]?.name ?? '—', h('div', { class: 'small muted' }, o.zones[0] ? `a ${dist(o.zones[0].distanceM)}${o.zones.length > 1 ? ` · +${o.zones.length - 1}` : ''}` : '')) },
                ...(seesImpact
                  ? [
                      {
                        label: 'POP/AP impattati',
                        render: (o) =>
                          o.impact.length
                            ? h('div', { class: 'btns' }, o.impact.slice(0, 4).map((i) => badge(`${i.type === 'pop' ? 'POP' : 'AP'} ${i.name} · ${dist(i.distanceM)}${i.stations != null ? ` · ${i.stations} CPE` : ''}`, 'bad')), o.impact.length > 4 ? h('span', { class: 'small' }, `+${o.impact.length - 4}`) : null)
                            : '—',
                      },
                    ]
                  : []),
                { label: 'Clienti', key: 'customers' },
                { label: 'Dal', render: (o) => local(o.start) },
                { label: 'Ripristino previsto', render: (o) => local(o.expectedRestore) },
                { label: '', render: (o) => h('a', { href: osm(o), target: '_blank', rel: 'noopener' }, 'mappa') },
              ],
              d.active,
            )
          : h('div', { class: 'notice good' }, admin ? 'Nessun guasto né lavoro in corso nelle zone di interesse.' : 'Nessun guasto né lavoro in corso nelle tue zone.'),
      ),
      d.recent?.length
        ? card(
            h('h2', {}, 'Ripristinati nelle ultime 48 ore'),
            table(
              [
                { label: 'Tipo', render: (o) => badge(KIND[o.kind]?.[0] ?? o.kind, '') },
                { label: 'Località', render: (o) => `${o.place} (${o.province})` },
                { label: 'Zona', render: (o) => o.zones[0]?.name ?? '—' },
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
    const impactR = h('input', { type: 'number', min: 0.1, max: 5, step: 0.1, value: c.config.impactRadiusKm ?? 1 });
    const planned = h('input', { type: 'checkbox' });
    planned.checked = c.config.includePlanned;
    const save = h('button', { type: 'button', class: 'primary' }, 'Salva impostazioni');
    save.onclick = () =>
      busy(save, async () => {
        await api('/api/admin/outages/config', { method: 'PUT', body: { apZones: apZones.checked, apRadiusKm: Number(radius.value) || 3, includePlanned: planned.checked, impactRadiusKm: Number(impactR.value) || 1 } });
        toast('Impostazioni salvate');
        await loadAdmin();
      });
    const refresh = h('button', { type: 'button' }, 'Controlla ora');
    refresh.onclick = () =>
      busy(refresh, async () => {
        const r = await api('/api/admin/outages/refresh', { method: 'POST', body: {} });
        toast(r.ok ? `Controllo eseguito: ${r.active.length} eventi nelle zone` : `Errore: ${r.error}`, r.ok ? '' : 'bad');
        await load();
      });
    const delZone = async (z) => {
      await api(`/api/admin/outages/zones/${z.id.slice(1)}`, { method: 'DELETE' });
      await loadAdmin();
    };

    mount(
      adminBox,
      card(
        h('h2', {}, 'Zone di interesse'),
        h('label', { class: 'check' }, apZones, `Zone automatiche attorno a ogni AP e POP monitorato (${c.apZonesCount} con posizione)`),
        h('div', { class: 'row' }, field('Raggio attorno agli AP (km)', radius), field('Raggio "POP/AP impattati" (km)', impactR)),
        h('p', { class: 'small muted' }, 'Un guasto più vicino di questo raggio a un POP o a un AP monitorato viene segnalato come impatto probabile (🚨 su Telegram), anche fuori dalle zone.'),
        h('label', { class: 'check' }, planned, 'Includi i lavori programmati'),
        h('div', { class: 'btns' }, save, refresh),
        h('h3', {}, 'Zone condivise (aree extra senza AP o POP, es. una frazione)'),
        c.zones.length ? zonesTable(c.zones, delZone) : h('p', { class: 'small muted' }, 'Nessuna zona condivisa.'),
        zoneForm({ post: (body) => api('/api/admin/outages/zones', { method: 'POST', body }), onDone: loadAdmin }),
        c.personalZones?.length
          ? [h('h3', {}, 'Zone personali degli installatori'), h('p', { class: 'small muted' }, 'Notificate solo all’installatore (app e Telegram personale), non al gruppo.'), zonesTable(c.personalZones, delZone, true)]
          : null,
        h('p', { class: 'small muted' }, 'Le notifiche Telegram al gruppo si attivano in Connettori → Telegram → evento "Guasti Enel".'),
      ),
    );
  }

  try {
    await load();
    if (admin) await Promise.all([loadAdmin(), loadInfra()]);
    else await loadMine();
  } catch (e) {
    mount(out, h('div', { class: 'notice bad' }, e.message));
  }
  return h(
    'div',
    {},
    pageHead('Guasti Enel', admin ? 'Guasti e lavori della rete elettrica (e-distribuzione) nelle zone di interesse e attorno agli AP.' : 'Guasti e lavori della rete elettrica nelle tue zone.'),
    out,
    myTelegramCard({ title: 'Notifiche', appHint: true }),
    admin ? null : myBox,
    infraBox,
    adminBox,
  );
}
