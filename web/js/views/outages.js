import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, table, toast } from '../dom.js';
import { itemLabel, itemNames, picker } from './infra-picker.js';

const KIND = { guasto_mt: ['Guasto MT', 'bad'], guasto_bt: ['Guasto BT', 'warn'], lavoro: ['Lavoro programmato', ''], altro: ['Interruzione', 'warn'] };
const local = (s) => (s ? s.replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '—');
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const osm = (o) => `https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lon}#map=15/${o.lat}/${o.lon}`;

/**
 * New area of interest: GPS of the device (with the address filled in), address search or typed
 * coordinates (with "address from coordinates"). [post] stores it (shared zone or personal zone).
 */
function zoneForm({ post, onDone }) {
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
      await post({ name: name.value.trim(), lat: la, lon: lo, radiusKm: Number(zr.value) || 2 });
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

/** Personal Telegram: the bot set by the admin writes to the user's own chat. */
function telegramCard() {
  const box = h('div', {});
  async function load() {
    const t = await api('/api/outages/telegram');
    const app = h('p', { class: 'small muted' }, 'Sul telefono: app CDA Net → Guasti Enel → "Avvisami dei guasti" (notifiche anche ad app chiusa).');
    if (!t.available) {
      mount(box, card(h('h2', {}, 'Notifiche'), h('p', { class: 'small muted' }, 'Le notifiche Telegram personali non sono attive: chiedi all’amministratore.'), app));
      return;
    }
    if (t.linked) {
      const planned = h('input', { type: 'checkbox' });
      planned.checked = t.planned;
      planned.onchange = () => api('/api/outages/telegram', { method: 'PUT', body: { planned: planned.checked } }).then(() => toast('Preferenza salvata'), (e) => toast(e.message, 'bad'));
      const off = h('button', { type: 'button', class: 'danger' }, 'Scollega Telegram');
      off.onclick = () =>
        busy(off, async () => {
          await api('/api/outages/telegram', { method: 'DELETE' });
          await load();
        });
      mount(box, card(h('h2', {}, 'Notifiche'), h('div', { class: 'notice good' }, `Telegram collegato (chat ${t.chatHint}): ricevi i guasti nelle tue zone e sui POP/AP assegnati.`), h('label', { class: 'check' }, planned, 'Anche i lavori programmati'), h('div', { class: 'btns' }, off), app));
      return;
    }
    const linkBtn = h('button', { type: 'button', class: 'primary' }, 'Collega Telegram');
    const steps = h('div', {});
    linkBtn.onclick = () =>
      busy(linkBtn, async () => {
        const l = await api('/api/outages/telegram/link', { method: 'POST', body: {} });
        const verify = h('button', { type: 'button', class: 'primary' }, 'Verifica');
        verify.onclick = () =>
          busy(verify, async () => {
            try {
              await api('/api/outages/telegram/verify', { method: 'POST', body: {} });
            } catch (e) {
              if (e.body?.error === 'start_not_found') throw new Error('Non trovo ancora il tuo messaggio: apri il bot, premi Avvia e riprova');
              throw e;
            }
            toast('Telegram collegato');
            await load();
          });
        mount(
          steps,
          h('ol', { class: 'small' }, h('li', {}, 'Apri ', h('a', { href: l.url, target: '_blank', rel: 'noopener' }, `@${l.bot}`), ' su Telegram e premi ', h('b', {}, 'Avvia'), '.'), h('li', {}, `Torna qui e premi Verifica (entro ${l.expiresInMin} minuti).`)),
          h('div', { class: 'btns' }, verify),
        );
      });
    const chatId = h('input', { placeholder: 'es. 123456789', inputmode: 'numeric' });
    const saveId = h('button', { type: 'button' }, 'Usa questo ID');
    saveId.onclick = () =>
      busy(saveId, async () => {
        await api('/api/outages/telegram', { method: 'PUT', body: { chatId: chatId.value.trim() } });
        toast('Telegram collegato: ti è arrivato un messaggio di prova');
        await load();
      });
    mount(
      box,
      card(
        h('h2', {}, 'Notifiche'),
        h('p', { class: 'small muted' }, 'Ricevi su Telegram i guasti nelle tue zone e sui POP/AP che ti sono assegnati.'),
        h('div', { class: 'btns' }, linkBtn),
        steps,
        h('div', { class: 'row' }, field('Oppure il tuo ID Telegram', chatId)),
        h('p', { class: 'small muted' }, 'Prima di usare l’ID scrivi almeno un messaggio al bot, altrimenti Telegram non gli permette di scriverti.'),
        h('div', { class: 'btns' }, saveId),
        app,
      ),
    );
  }
  load().catch((e) => mount(box, card(h('h2', {}, 'Notifiche'), h('div', { class: 'notice bad' }, e.message))));
  return box;
}

/** Guasti Enel: outages and planned works in the areas of interest (admins: everything; installers: their own). */
export async function outagesView({ user }) {
  const admin = user.role === 'admin';
  const out = h('div', {});
  const adminBox = h('div', {});
  const infraBox = h('div', {});
  const myBox = h('div', {});

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
    const { zones } = await api('/api/outages/zones');
    mount(
      myBox,
      card(
        h('h2', {}, 'Le mie zone di interesse'),
        h('p', { class: 'small muted' }, 'Ricevi i guasti e i lavori nelle tue zone (massimo 20). I POP/AP potenzialmente impattati li vedi solo per quelli che ti ha assegnato l’amministratore.'),
        zones.length
          ? zonesTable(zones, async (z) => {
              await api(`/api/outages/zones/${z.id.slice(1)}`, { method: 'DELETE' });
              await loadMine();
            })
          : h('p', { class: 'small muted' }, 'Nessuna zona: aggiungine una qui sotto.'),
        zoneForm({ post: (body) => api('/api/outages/zones', { method: 'POST', body }), onDone: loadMine }),
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
    telegramCard(),
    admin ? null : myBox,
    infraBox,
    adminBox,
  );
}
