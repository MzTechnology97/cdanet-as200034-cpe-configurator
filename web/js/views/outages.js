import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, table, toast } from '../dom.js';

const KIND = { guasto_mt: ['Guasto MT', 'bad'], guasto_bt: ['Guasto BT', 'warn'], lavoro: ['Lavoro programmato', ''], altro: ['Interruzione', 'warn'] };
const local = (s) => (s ? s.replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '—');
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const osm = (o) => `https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lon}#map=15/${o.lat}/${o.lon}`;

const label = (i) => (i.key.startsWith('pop:') ? `POP ${i.name}` : i.key.startsWith('ap:') ? i.name : `Zona ${i.name}`);

/** key -> name of every UISP POP/AP (and manual zone) the admin can pick. */
function itemNames(inf, zones) {
  const m = new Map();
  for (const p of inf.pops) {
    m.set(`pop:${p.id}`, p.name);
    for (const a of p.aps) m.set(`ap:${a.id}`, a.name);
  }
  for (const a of inf.apsWithoutPop) m.set(`ap:${a.id}`, a.name);
  for (const z of zones) m.set(z.id, z.name);
  return m;
}

/**
 * Searchable checkbox tree: UISP POPs with their APs (and manual zones). [chosen] is updated in place;
 * [only] limits the choice (e.g. to the monitored ones); [cascade] makes a POP tick/untick its APs.
 */
function picker({ inf, zones = [], chosen, only = null, cascade = false, popCoversAps = false }) {
  const q = h('input', { type: 'search', placeholder: 'Cerca POP, AP, SSID o indirizzo…' });
  const list = h('div', { class: 'pick' });
  const self = { el: h('div', {}, q, list), render: null, onChange: null };
  const ok = (k) => !only || only.has(k);
  const box = (key, text, extra, after) => {
    const i = h('input', { type: 'checkbox' });
    i.checked = chosen.has(key);
    i.onchange = () => {
      if (i.checked) chosen.add(key);
      else chosen.delete(key);
      after?.(i.checked);
      self.onChange?.();
    };
    return h('label', { class: 'check' }, i, text, extra ? h('span', { class: 'small muted' }, extra) : null);
  };
  const apLine = (a) => box(`ap:${a.id}`, a.name, [a.ssid && a.ssid !== a.name ? a.ssid : null, `${a.stations ?? 0} CPE`, a.locationFrom === 'pop' ? 'posizione del POP' : a.locationFrom === null ? 'senza posizione' : null].filter(Boolean).join(' · '));
  self.render = () => {
    const t = q.value.trim().toLowerCase();
    const hit = (...xs) => !t || xs.some((x) => x && String(x).toLowerCase().includes(t));
    const rows = [];
    for (const p of inf.pops) {
      const aps = p.aps.filter((a) => ok(`ap:${a.id}`));
      const popOk = ok(`pop:${p.id}`);
      if (!popOk && !aps.length) continue;
      const popHit = hit(p.name, p.address);
      const shown = popHit ? aps : aps.filter((a) => hit(a.name, a.ssid));
      if (!popHit && !shown.length) continue;
      const info = [p.address, p.lat == null ? 'senza posizione' : null, p.stations != null ? `${p.stations} CPE` : null, popCoversAps && p.aps.length ? 'include i suoi AP' : null].filter(Boolean).join(' · ');
      const head = popOk
        ? box(`pop:${p.id}`, h('b', {}, `POP ${p.name}`), info, cascade ? (on) => { for (const a of aps) on ? chosen.add(`ap:${a.id}`) : chosen.delete(`ap:${a.id}`); self.render(); } : null)
        : h('div', {}, h('b', {}, `POP ${p.name}`), h('span', { class: 'small muted' }, info));
      rows.push(h('div', { class: 'pick-pop' }, head, shown.length ? h('div', { class: 'pick-aps' }, shown.map(apLine)) : null));
    }
    const loose = inf.apsWithoutPop.filter((a) => ok(`ap:${a.id}`) && hit(a.name, a.ssid));
    if (loose.length) rows.push(h('div', { class: 'pick-pop' }, h('b', {}, 'AP senza POP'), h('div', { class: 'pick-aps' }, loose.map(apLine))));
    const zs = zones.filter((z) => hit(z.name));
    if (zs.length) rows.push(h('div', { class: 'pick-pop' }, h('b', {}, 'Zone manuali'), h('div', { class: 'pick-aps' }, zs.map((z) => box(z.id, z.name, `${z.radiusKm} km`)))));
    mount(list, rows.length ? rows : h('p', { class: 'small muted' }, only && !only.size ? 'Nessun POP/AP monitorato: selezionali sopra.' : 'Nessun risultato.'));
  };
  q.oninput = self.render;
  self.render();
  return self;
}

/** Guasti Enel: outages and planned works of e-distribuzione in the CDA Net areas of interest. */
export async function outagesView({ user }) {
  const out = h('div', {});
  const adminBox = h('div', {});
  const infraBox = h('div', {});
  const assignBox = h('div', {});

  /** POPs and APs straight from UISP (names, addresses, coordinates): pick the ones to monitor. */
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
      ),
    );
    await loadAssign(inf, sel, cfg.zones, names);
  }

  /** Installers see only the POPs/APs/zones assigned here (web, app and app notifications). */
  async function loadAssign(inf, sel, zones, names) {
    const { users } = await api('/api/admin/outages/assignments');
    const only = sel.selectionOnly ? new Set(sel.items.map((i) => i.key)) : null;
    const editor = h('div', {});
    const edit = (u) => {
      const chosen = new Set(u.items.map((i) => i.key));
      for (const it of u.items) if (!names.has(it.key)) names.set(it.key, it.name);
      const pick = picker({ inf, zones, chosen, only, popCoversAps: true });
      const save = h('button', { type: 'button', class: 'primary' }, `Salva assegnazioni di ${u.username}`);
      save.onclick = () =>
        busy(save, async () => {
          await api(`/api/admin/outages/assignments/${u.id}`, { method: 'PUT', body: { items: [...chosen].map((key) => ({ key, name: names.get(key) ?? key })) } });
          toast(`Assegnazioni di ${u.username} salvate`);
          await loadAssign(inf, sel, zones, names);
        });
      const cancel = h('button', { type: 'button' }, 'Annulla');
      cancel.onclick = () => mount(editor);
      mount(editor, h('h3', {}, `Cosa vede ${u.username}`), h('p', { class: 'small muted' }, 'Un POP assegnato include tutti i suoi AP.'), pick.el, h('div', { class: 'btns' }, save, cancel));
      editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    mount(
      assignBox,
      card(
        h('h2', {}, 'Assegnazioni agli installatori'),
        h('p', { class: 'small muted' }, 'Gli amministratori vedono tutto. Ogni installatore vede (sul web, nell’app e nelle notifiche del telefono) solo i guasti che toccano i POP, gli AP o le zone assegnati qui. Le notifiche Telegram al gruppo restano complete.'),
        users.length
          ? table(
              [
                { label: 'Installatore', render: (u) => h('div', {}, h('b', {}, u.username), !u.active ? h('div', { class: 'small muted' }, 'disattivato') : null) },
                { label: 'Modulo Guasti', render: (u) => (u.outagesModule ? badge('attivo', 'good') : badge('disattivato', '')) },
                { label: 'Assegnati', render: (u) => (u.items.length ? h('div', { class: 'btns' }, u.items.map((i) => badge(label(i), ''))) : h('span', { class: 'small muted' }, 'niente: non vede guasti')) },
                {
                  label: '',
                  render: (u) => {
                    const b = h('button', { type: 'button' }, 'Modifica');
                    b.onclick = () => edit(u);
                    return b;
                  },
                },
              ],
              users,
            )
          : h('p', { class: 'small muted' }, 'Nessun installatore: creali in Utenti.'),
        editor,
      ),
    );
  }

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
          stat('POP/AP potenzialmente impattati', new Set(d.active.flatMap((o) => o.impact.map((i) => `${i.type}:${i.id}`))).size),
        ),
        h(
          'p',
          { class: 'small muted' },
          d.lastRun ? `Ultimo controllo ${fmtDate(d.lastRun.at)}${d.lastRun.ok ? '' : ` · errore: ${d.lastRun.error}`} · ` : d.generatedAt ? `Ultimo controllo ${fmtDate(d.generatedAt)} · ` : 'Nessun controllo ancora eseguito · ',
          'fonte: mappa pubblica dei guasti di e-distribuzione, controllata ogni 10 minuti.',
        ),
      ),
      d.scope && !d.scope.all
        ? card(
            h('h2', {}, 'Assegnati a te'),
            d.scope.assigned.length
              ? h('div', { class: 'btns' }, d.scope.assigned.map((i) => badge(label(i), '')))
              : h('div', { class: 'notice warn' }, 'Nessun POP, AP o zona assegnati: chiedi all’amministratore di assegnarteli.'),
          )
        : null,
      card(
        h('h2', {}, d.scope && !d.scope.all ? 'In corso sui tuoi POP/AP' : 'In corso nelle zone di interesse'),
        d.active.length
          ? table(
              [
                { label: 'Tipo', render: (o) => badge(KIND[o.kind]?.[0] ?? o.kind, KIND[o.kind]?.[1] ?? '') },
                { label: 'Località', render: (o) => h('div', {}, o.place || '—', h('div', { class: 'small muted' }, o.province)) },
                { label: 'Zona / AP', render: (o) => h('div', {}, o.zones[0]?.name ?? '—', h('div', { class: 'small muted' }, o.zones[0] ? `a ${dist(o.zones[0].distanceM)}${o.zones.length > 1 ? ` · +${o.zones.length - 1}` : ''}` : '')) },
                {
                  label: 'POP/AP impattati',
                  render: (o) =>
                    o.impact.length
                      ? h('div', { class: 'btns' }, o.impact.slice(0, 4).map((i) => badge(`${i.type === 'pop' ? 'POP' : 'AP'} ${i.name} · ${dist(i.distanceM)}${i.stations != null ? ` · ${i.stations} CPE` : ''}`, 'bad')), o.impact.length > 4 ? h('span', { class: 'small' }, `+${o.impact.length - 4}`) : null)
                      : '—',
                },
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

    const name = h('input', { placeholder: 'es. Nodo 7 Valle, Centro Enna' });
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
        await api('/api/admin/outages/zones', { method: 'POST', body: { name: name.value.trim(), lat: la, lon: lo, radiusKm: Number(zr.value) || 2 } });
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
        h('label', { class: 'check' }, apZones, `Zone automatiche attorno a ogni AP e POP di UISP (${c.apZonesCount} con posizione)`),
        h('div', { class: 'row' }, field('Raggio attorno agli AP (km)', radius), field('Raggio "POP/AP impattati" (km)', impactR)),
        h('p', { class: 'small muted' }, 'Un guasto più vicino di questo raggio a un POP o a un AP di UISP viene segnalato come impatto probabile (🚨 su Telegram), anche fuori dalle zone.'),
        h('label', { class: 'check' }, planned, 'Includi i lavori programmati'),
        h('div', { class: 'btns' }, save, refresh),
        h('h3', {}, 'Zone manuali (aree extra senza AP o POP, es. una frazione)'),
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
        h('h3', {}, 'Nuova zona'),
        h('div', { class: 'row' }, field('Nome', name), field('Raggio (km)', zr)),
        h('div', { class: 'btns' }, gps),
        h('div', { class: 'row' }, field('Via', street), field('Civico', number), field('Città', city), field('Provincia', prov), field('CAP', cap)),
        h('div', { class: 'btns' }, find),
        h('div', { class: 'row' }, field('Latitudine', lat), field('Longitudine', lon)),
        h('div', { class: 'btns' }, fromCoords, add),
        where,
        h('p', { class: 'small muted' }, 'Le notifiche Telegram si attivano in Connettori → Telegram → evento "Guasti Enel". Dall’app ogni utente può attivare le notifiche sul telefono.'),
      ),
    );
  }

  try {
    await load();
    if (user.role === 'admin') await Promise.all([loadAdmin(), loadInfra()]);
  } catch (e) {
    mount(out, h('div', { class: 'notice bad' }, e.message));
  }
  return h('div', {}, pageHead('Guasti Enel', 'Guasti e lavori della rete elettrica (e-distribuzione) nelle zone di interesse e attorno agli AP.'), out, infraBox, assignBox, adminBox);
}
