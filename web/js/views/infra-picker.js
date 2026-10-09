import { api } from '../api.js';
import { badge, busy, card, h, mount, table, toast } from '../dom.js';

/** "POP Nodo 2", "AP N2 D01", "Zona Centro" from an assignment/selection item. */
export const itemLabel = (i) => (i.key.startsWith('pop:') ? `POP ${i.name}` : i.key.startsWith('ap:') ? i.name : `Zona ${i.name}`);

/** key -> name of every UISP POP/AP (and manual zone) the admin can pick. */
export function itemNames(inf, zones) {
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
export function picker({ inf, zones = [], chosen, only = null, cascade = false, popCoversAps = false }) {
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
  const apLine = (a) =>
    box(`ap:${a.id}`, a.name, [a.ssid && a.ssid !== a.name ? a.ssid : null, `${a.stations ?? 0} CPE`, a.locationFrom === 'pop' ? 'posizione del POP' : a.locationFrom === null ? 'senza posizione' : null].filter(Boolean).join(' · '));
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
        ? box(
            `pop:${p.id}`,
            h('b', {}, `POP ${p.name}`),
            info,
            cascade
              ? (on) => {
                  for (const a of aps) on ? chosen.add(`ap:${a.id}`) : chosen.delete(`ap:${a.id}`);
                  self.render();
                }
              : null,
          )
        : h('div', {}, h('b', {}, `POP ${p.name}`), h('span', { class: 'small muted' }, info));
      rows.push(h('div', { class: 'pick-pop' }, head, shown.length ? h('div', { class: 'pick-aps' }, shown.map(apLine)) : null));
    }
    const loose = inf.apsWithoutPop.filter((a) => ok(`ap:${a.id}`) && hit(a.name, a.ssid));
    if (loose.length) rows.push(h('div', { class: 'pick-pop' }, h('b', {}, 'AP senza POP'), h('div', { class: 'pick-aps' }, loose.map(apLine))));
    const zs = zones.filter((z) => hit(z.name));
    if (zs.length) rows.push(h('div', { class: 'pick-pop' }, h('b', {}, 'Zone Guasti Enel'), h('div', { class: 'pick-aps' }, zs.map((z) => box(z.id, z.name, `${z.radiusKm} km`)))));
    mount(list, rows.length ? rows : h('p', { class: 'small muted' }, only && !only.size ? 'Nessun POP/AP monitorato: selezionali in Guasti Enel.' : 'Nessun risultato.'));
  };
  q.oninput = self.render;
  self.render();
  return self;
}

/**
 * Admin: POPs/APs (and Guasti Enel zones) assigned to each installer. Installers see only these
 * in the coverage check and in Guasti Enel (impacted POPs/APs), on the web, in the app and in notifications.
 */
export function assignmentsCard() {
  const box = h('div', {}, card(h('h2', {}, 'POP/AP assegnati agli installatori'), h('p', { class: 'muted small' }, 'Caricamento…')));
  const editor = h('div', {});

  async function load() {
    let inf, data;
    try {
      [inf, data] = await Promise.all([api('/api/admin/infrastructure'), api('/api/admin/assignments')]);
    } catch (e) {
      mount(box, card(h('h2', {}, 'POP/AP assegnati agli installatori'), h('div', { class: 'notice warn' }, e.body?.error === 'uisp_not_configured' ? 'Serve UISP configurato (Connettori): POP e AP arrivano da lì.' : e.message)));
      return;
    }
    const names = itemNames(inf, data.zones);
    const clients = h('input', { type: 'checkbox' });
    clients.checked = data.installerClients;
    clients.onchange = () =>
      api('/api/admin/assignments/settings', { method: 'PUT', body: { installerClients: clients.checked } }).then(
        () => toast(clients.checked ? 'Numero clienti visibile agli installatori' : 'Numero clienti nascosto agli installatori'),
        (e) => toast(e.message, 'bad'),
      );
    const edit = (u) => {
      const chosen = new Set(u.items.map((i) => i.key));
      for (const it of u.items) if (!names.has(it.key)) names.set(it.key, it.name);
      const pick = picker({ inf, zones: data.zones, chosen, popCoversAps: true });
      const save = h('button', { type: 'button', class: 'primary' }, `Salva assegnazioni di ${u.username}`);
      save.onclick = () =>
        busy(save, async () => {
          await api(`/api/admin/assignments/${u.id}`, { method: 'PUT', body: { items: [...chosen].map((key) => ({ key, name: names.get(key) ?? key })) } });
          toast(`Assegnazioni di ${u.username} salvate`);
          mount(editor);
          await load();
        });
      const cancel = h('button', { type: 'button' }, 'Annulla');
      cancel.onclick = () => mount(editor);
      mount(editor, h('h3', {}, `POP/AP di ${u.username}`), h('p', { class: 'small muted' }, 'Un POP assegnato include tutti i suoi AP.'), pick.el, h('div', { class: 'btns' }, save, cancel));
      editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    mount(
      box,
      card(
        h('h2', {}, 'POP/AP assegnati agli installatori'),
        h(
          'p',
          { class: 'small muted' },
          'Gli amministratori vedono tutto. Ogni installatore, nella verifica copertura e in Guasti Enel (POP/AP potenzialmente impattati), vede solo i POP e gli AP assegnati qui: sul web, nell’app e nelle notifiche. Le sue zone personali dei guasti restano sue.',
        ),
        data.users.length
          ? table(
              [
                { label: 'Installatore', render: (u) => h('div', {}, h('b', {}, u.username), !u.active ? h('div', { class: 'small muted' }, 'disattivato') : null) },
                {
                  label: 'Moduli',
                  render: (u) => h('div', { class: 'btns' }, badge(`Copertura ${u.modules.coverage ? 'sì' : 'no'}`, u.modules.coverage ? 'good' : ''), badge(`Guasti ${u.modules.power_outages ? 'sì' : 'no'}`, u.modules.power_outages ? 'good' : '')),
                },
                { label: 'Assegnati', render: (u) => (u.items.length ? h('div', { class: 'btns' }, u.items.map((i) => badge(itemLabel(i), ''))) : h('span', { class: 'small muted' }, 'nessuno: copertura vuota, guasti solo nelle sue zone')) },
                {
                  label: '',
                  render: (u) => {
                    const b = h('button', { type: 'button' }, 'Modifica');
                    b.onclick = () => edit(u);
                    return b;
                  },
                },
              ],
              data.users,
            )
          : h('p', { class: 'small muted' }, 'Nessun installatore.'),
        h('label', { class: 'check' }, clients, 'Mostra agli installatori il numero di clienti (CPE) dei loro POP/AP (guasti, mappe, copertura)'),
        editor,
      ),
    );
  }
  void load();
  return box;
}
