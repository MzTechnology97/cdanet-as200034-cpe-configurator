import { api } from '../api.js';
import { badge, busy, card, field, h, mount, pageHead, table, toast } from '../dom.js';

const KINDS = { new: 'Nuova installazione', repoint: 'Ripuntamento / cambio AP', repair: 'Guasto', survey: 'Sopralluogo' };
const STATUS = { open: ['da fare', ''], started: ['in corso', 'warn'], done: ['fatto', 'good'], postponed: ['rimandato', 'warn'], cancelled: ['annullato', 'bad'] };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dmy = (d) => d.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3/$2/$1');
const statusBadge = (o) => h('span', {}, badge(STATUS[o.status]?.[0] ?? o.status, STATUS[o.status]?.[1] ?? ''), o.overdue ? badge('in ritardo', 'bad') : null);

/**
 * "Interventi": the office plans the day of each installer with the customer's data and PPPoE
 * credentials; installers find them in the app ("Oggi") and here, read-only.
 */
export async function workOrdersView({ user }) {
  return user.role === 'admin' ? officeView() : installerView();
}

async function installerView() {
  const box = h('div', {});
  const day = h('input', { type: 'date', value: today() });
  async function load() {
    const d = await api(`/api/work-orders?day=${day.value}`);
    mount(
      box,
      card(
        table(
          [
            { label: 'Giorno', render: (o) => `${dmy(o.day)}${o.slot ? ` · ${o.slot}` : ''}` },
            { label: 'Cliente', render: (o) => h('div', {}, h('strong', {}, o.customer), h('div', { class: 'small muted' }, o.address || '—')) },
            { label: 'Tipo', render: (o) => KINDS[o.kind] },
            { label: 'Contatto', render: (o) => o.contact || '—' },
            { label: 'Note', render: (o) => o.notes || '—' },
            { label: 'Stato', render: statusBadge },
          ],
          d.items,
        ),
        h('p', { class: 'small muted' }, 'Gli interventi si avviano dall’app (Oggi → Inizia): cliente, posizione e PPPoE sono già compilati.'),
      ),
    );
  }
  day.onchange = load;
  await load();
  return h('div', {}, pageHead('I miei interventi', 'Assegnati dall’ufficio: quelli di oggi e quelli rimasti aperti.'), card(field('Giorno', day)), box);
}

async function officeView() {
  const users = (await api('/api/admin/users')).filter((u) => u.active !== false && u.role !== 'admin');
  const models = (await api('/api/admin/profiles')).map((p) => p.model);
  const listBox = h('div', {});
  const formBox = h('div', {});
  const from = h('input', { type: 'date', value: today() });
  const to = h('input', { type: 'date', value: today() });
  const who = h('select', {}, h('option', { value: '' }, 'Tutti'), users.map((u) => h('option', { value: u.id }, u.username)));
  let editing = null;

  async function load() {
    const q = new URLSearchParams({ from: from.value, to: to.value < from.value ? from.value : to.value });
    if (who.value) q.set('user', who.value);
    const d = await api(`/api/admin/work-orders?${q}`);
    mount(
      listBox,
      card(
        h('h2', {}, `${d.items.length} interventi`),
        table(
          [
            { label: 'Giorno', render: (o) => `${dmy(o.day)}${o.slot ? ` · ${o.slot}` : ''}` },
            { label: 'Installatore', render: (o) => o.assignee ?? badge('da assegnare', 'warn') },
            { label: 'Cliente', render: (o) => h('div', {}, h('strong', {}, o.customer), h('div', { class: 'small muted' }, o.address || '—')) },
            { label: 'Tipo', render: (o) => KINDS[o.kind] },
            { label: 'PPPoE', render: (o) => (o.pppoeUser ? h('span', {}, o.pppoeUser, o.hasPassword ? '' : h('span', { class: 'small muted' }, ' · senza password')) : '—') },
            { label: 'Stato', render: (o) => h('div', {}, statusBadge(o), o.statusNote ? h('div', { class: 'small muted' }, o.statusNote) : null) },
            {
              label: '',
              render: (o) => {
                const edit = h('button', { type: 'button' }, 'Modifica');
                edit.onclick = () => openForm(o);
                const del = h('button', { type: 'button', class: 'danger' }, o.jobId || o.status === 'done' ? 'Annulla' : 'Elimina');
                del.onclick = () =>
                  confirm(`${o.jobId ? 'Annullare' : 'Eliminare'} l’intervento di ${o.customer}?`) &&
                  busy(del, async () => {
                    await api(`/api/admin/work-orders/${o.id}`, { method: 'DELETE' });
                    await load();
                  });
                return h('div', { class: 'btns' }, o.status === 'done' || o.status === 'cancelled' ? null : edit, o.status === 'cancelled' ? null : del);
              },
            },
          ],
          d.items,
        ),
      ),
    );
  }

  function openForm(o = null) {
    editing = o;
    const assigned = h('select', {}, h('option', { value: '' }, '— da assegnare —'), users.map((u) => h('option', { value: u.id, selected: o?.assignedTo === u.id }, u.username)));
    const day = h('input', { type: 'date', value: o?.day ?? from.value });
    const slot = h('input', { placeholder: 'es. 09:00-11:00 o mattina', value: o?.slot ?? '', maxlength: 40 });
    const kind = h('select', {}, Object.entries(KINDS).map(([k, v]) => h('option', { value: k, selected: (o?.kind ?? 'new') === k }, v)));
    const customer = h('input', { value: o?.customer ?? '', placeholder: 'Nome e cognome o ragione sociale' });
    const address = h('input', { value: o?.address ?? '', placeholder: 'Via, civico, CAP, comune' });
    const lat = h('input', { value: o?.lat ?? '', inputmode: 'decimal', placeholder: '37.5670' });
    const lon = h('input', { value: o?.lon ?? '', inputmode: 'decimal', placeholder: '14.2790' });
    const contact = h('input', { value: o?.contact ?? '', placeholder: 'Telefono o referente sul posto' });
    const pppoeUser = h('input', { value: o?.pppoeUser ?? '', placeholder: 'cliente@cda-net.it' });
    const pppoePassword = h('input', { type: 'password', autocomplete: 'new-password', placeholder: o?.hasPassword ? 'impostata · scrivi per cambiarla' : 'Password PPPoE del cliente' });
    const model = h('select', {}, h('option', { value: '' }, 'da scegliere sul posto'), models.map((m) => h('option', { value: m, selected: o?.model === m }, m)));
    const notes = h('textarea', { rows: 2, placeholder: 'Accesso al tetto, cancello, orari…' }, o?.notes ?? '');
    const where = h('p', { class: 'small muted' });
    const find = h('button', { type: 'button' }, 'Cerca indirizzo');
    find.onclick = () =>
      busy(find, async () => {
        const g = await api(`/api/geocode?q=${encodeURIComponent(address.value.trim())}`);
        if (!g.length) throw new Error('Indirizzo non trovato');
        lat.value = g[0].lat.toFixed(6);
        lon.value = g[0].lon.toFixed(6);
        where.textContent = g[0].label;
      });
    const save = h('button', { type: 'button', class: 'primary' }, o ? 'Salva modifiche' : 'Crea intervento');
    save.onclick = () =>
      busy(save, async () => {
        const num = (x) => (x.value.trim() ? Number(x.value.replace(',', '.')) : null);
        const body = {
          assignedTo: assigned.value ? Number(assigned.value) : null,
          day: day.value,
          slot: slot.value.trim(),
          kind: kind.value,
          customer: customer.value.trim(),
          address: address.value.trim(),
          lat: num(lat),
          lon: num(lon),
          contact: contact.value.trim(),
          pppoeUser: pppoeUser.value.trim(),
          model: model.value,
          notes: notes.value.trim(),
          ...(pppoePassword.value ? { pppoePassword: pppoePassword.value } : {}),
        };
        if (editing) await api(`/api/admin/work-orders/${editing.id}`, { method: 'PUT', body });
        else await api('/api/admin/work-orders', { method: 'POST', body });
        toast(editing ? 'Intervento aggiornato' : 'Intervento creato: l’installatore lo trova in Oggi');
        closeForm();
        await load();
      });
    const cancel = h('button', { type: 'button' }, 'Chiudi');
    cancel.onclick = closeForm;
    mount(
      formBox,
      card(
        h('h2', {}, o ? `Modifica: ${o.customer}` : 'Nuovo intervento'),
        h('div', { class: 'row' }, field('Installatore', assigned), field('Giorno', day), field('Fascia oraria', slot), field('Tipo', kind)),
        h('div', { class: 'row' }, field('Cliente', customer), field('Contatto', contact)),
        h('div', { class: 'row' }, field('Indirizzo', address), field('Latitudine', lat), field('Longitudine', lon)),
        h('div', { class: 'btns' }, find),
        where,
        h('div', { class: 'row' }, field('Utente PPPoE', pppoeUser), field('Password PPPoE', pppoePassword), field('Modello CPE', model)),
        h('p', { class: 'small muted' }, 'La password viene cifrata sul server e non viene mai mostrata: l’app la inserisce da sola nella configurazione della CPE.'),
        field('Note per l’installatore', notes),
        h('div', { class: 'btns' }, save, cancel),
      ),
    );
    formBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeForm() {
    editing = null;
    mount(formBox);
  }

  from.onchange = to.onchange = who.onchange = load;
  const add = h('button', { type: 'button', class: 'primary' }, 'Nuovo intervento');
  add.onclick = () => openForm();
  await load();
  return h(
    'div',
    {},
    pageHead('Interventi', 'L’agenda degli installatori: ognuno trova i suoi in Oggi nell’app, con cliente, posizione e PPPoE già compilati.', add),
    card(h('div', { class: 'row' }, field('Dal', from), field('Al', to), field('Installatore', who))),
    formBox,
    listBox,
  );
}
