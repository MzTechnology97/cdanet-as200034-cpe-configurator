import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';

const SSID_RX = /^CDA-NET-N(\d+)-D(\d+)$/;
const ssidOf = (n, d) => `CDA-NET-N${n}-D${String(d).padStart(2, '0')}`;
/** Natural order: N2 before N11, D02 before D10. */
const sortKey = (s) => {
  const m = SSID_RX.exec(s);
  return m ? Number(m[1]) * 1000 + Number(m[2]) : Number.MAX_SAFE_INTEGER;
};

export async function wirelessView() {
  let networks = [];
  const selected = new Set();
  const listEl = h('div', {});
  const importEl = h('div', {});

  // ---- Add / update a single key ----------------------------------------------
  const node = h('select', {});
  const district = h('select', {});
  for (let n = 2; n <= 99; n++) node.append(h('option', { value: n }, n));
  for (let d = 1; d <= 99; d++) district.append(h('option', { value: d }, String(d).padStart(2, '0')));
  const ssidPreview = h('input', { readonly: true });
  const psk = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 63 });
  const showPsk = h('input', { type: 'checkbox' });
  showPsk.onchange = () => (psk.type = showPsk.checked ? 'text' : 'password');
  const state = h('span', {});
  const save = h('button', { class: 'primary', type: 'submit' }, 'Salva chiave');
  const currentSsid = () => ssidOf(node.value, district.value);
  const syncForm = () => {
    ssidPreview.value = currentSsid();
    const exists = networks.some((n) => n.ssid === currentSsid());
    save.textContent = exists ? 'Aggiorna chiave' : 'Salva chiave';
    mount(state, exists ? badge('Già configurata: verrà sostituita', 'warn') : badge('Nuova rete', 'good'));
  };
  node.onchange = district.onchange = syncForm;

  function edit(ssid) {
    const m = SSID_RX.exec(ssid);
    if (!m) return;
    node.value = String(Number(m[1]));
    district.value = String(Number(m[2]));
    syncForm();
    psk.value = '';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    psk.focus();
  }

  const form = h(
    'form',
    {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        busy(save, async () => {
          const ssid = currentSsid();
          const existed = networks.some((n) => n.ssid === ssid);
          await api(`/api/admin/wireless-networks/${encodeURIComponent(ssid)}`, { method: 'PUT', body: { wpa2Password: psk.value } });
          psk.value = '';
          toast(`WPA2 di ${ssid} ${existed ? 'aggiornata' : 'salvata'}`);
          await load();
        });
      },
    },
    field('Nodo', node),
    field('Distretto', district),
    field('SSID', ssidPreview),
    field('Chiave WPA2 (8-63 caratteri)', psk),
    save,
  );

  // ---- CSV import ----------------------------------------------------------------
  const csvFile = h('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
  let csvText = '';
  csvFile.onchange = async () => {
    const f = csvFile.files?.[0];
    if (!f) return;
    csvText = await f.text();
    mount(importEl, h('p', { class: 'muted' }, 'Verifica del file…'));
    try {
      showImport(await api('/api/admin/wireless-networks/import', { method: 'POST', body: { csv: csvText, dryRun: true } }), f.name);
    } catch (e) {
      mount(importEl, h('div', { class: 'notice bad' }, e.message));
    }
  };

  function showImport(r, name) {
    const confirmBtn = h('button', { class: 'primary' }, `Importa ${r.created.length + r.updated.length} reti`);
    confirmBtn.onclick = () =>
      busy(confirmBtn, async () => {
        const done = await api('/api/admin/wireless-networks/import', { method: 'POST', body: { csv: csvText, dryRun: false } });
        toast(`Import completato: ${done.created.length} nuove, ${done.updated.length} aggiornate`);
        csvFile.value = '';
        csvText = '';
        mount(importEl);
        await load();
      });
    const list = (title, xs, kind) =>
      xs.length ? h('details', {}, h('summary', {}, badge(`${xs.length} ${title}`, kind)), h('p', { class: 'small mono' }, xs.join(', '))) : null;
    mount(
      importEl,
      h(
        'div',
        { class: `notice ${r.ok ? 'good' : 'bad'}` },
        r.ok
          ? `${name}: ${r.rows} righe valide. Nessuna modifica è stata ancora salvata.`
          : `${name}: ${r.errorCount} righe con errori. Correggi il file e ricaricalo: finché ci sono errori non viene importato nulla.`,
      ),
      r.errors.length
        ? table(
            [
              { label: 'Riga', key: 'line' },
              { label: 'Errore', key: 'error' },
            ],
            r.errors,
          )
        : null,
      h('div', { class: 'btns' }, list('nuove', r.created, 'good'), list('da aggiornare', r.updated, 'warn'), list('invariate', r.unchanged, '')),
      r.ok && r.created.length + r.updated.length > 0 ? h('div', { class: 'btns' }, confirmBtn) : r.ok ? h('p', { class: 'muted' }, 'Tutte le chiavi sono già aggiornate.') : null,
    );
  }

  // ---- List with multi-select -------------------------------------------------------
  const search = h('input', { type: 'search', placeholder: 'Filtra: N12, D05, CDA-NET-N2…' });
  const delSel = h('button', { class: 'danger' }, 'Elimina selezionate');
  const clearSel = h('button', {}, 'Deseleziona');
  const counter = h('span', { class: 'muted small' });
  const visible = () => {
    const q = search.value.trim().toUpperCase();
    return networks.filter((n) => !q || n.ssid.includes(q) || n.ssid.replace('CDA-NET-', '').includes(q));
  };
  const refreshActions = () => {
    delSel.disabled = selected.size === 0;
    clearSel.disabled = selected.size === 0;
    delSel.textContent = selected.size ? `Elimina selezionate (${selected.size})` : 'Elimina selezionate';
    counter.textContent = `${networks.length} reti configurate${selected.size ? ` · ${selected.size} selezionate` : ''}`;
  };
  search.oninput = () => renderList();
  clearSel.onclick = () => {
    selected.clear();
    renderList();
  };
  delSel.onclick = () => {
    const ssids = [...selected];
    if (!ssids.length) return;
    const preview = ssids.slice(0, 8).join('\n') + (ssids.length > 8 ? `\n… e altre ${ssids.length - 8}` : '');
    if (!confirm(`Eliminare la chiave WPA2 di ${ssids.length} reti?\n\n${preview}\n\nIl provisioning su queste reti verrà bloccato finché non reinserisci la chiave.`)) return;
    busy(delSel, async () => {
      const r = await api('/api/admin/wireless-networks/bulk-delete', { method: 'POST', body: { ssids } });
      selected.clear();
      toast(`${r.deleted} reti eliminate`);
      await load();
    });
  };

  function renderList() {
    const rows = visible();
    const all = h('input', { type: 'checkbox', 'aria-label': 'Seleziona tutte le reti visibili' });
    all.checked = rows.length > 0 && rows.every((r) => selected.has(r.ssid));
    all.indeterminate = !all.checked && rows.some((r) => selected.has(r.ssid));
    all.onchange = () => {
      for (const r of rows) all.checked ? selected.add(r.ssid) : selected.delete(r.ssid);
      renderList();
    };
    mount(
      listEl,
      table(
        [
          {
            label: 'Seleziona',
            header: all,
            render: (n) => {
              const cb = h('input', { type: 'checkbox', 'aria-label': `Seleziona ${n.ssid}` });
              cb.checked = selected.has(n.ssid);
              cb.onclick = (e) => e.stopPropagation();
              cb.onchange = () => {
                cb.checked ? selected.add(n.ssid) : selected.delete(n.ssid);
                renderList();
              };
              return cb;
            },
          },
          { label: 'SSID', render: (n) => h('span', { class: 'mono' }, n.ssid) },
          { label: 'Aggiornata', render: (n) => fmtDate(n.updatedAt) },
          {
            label: '',
            render: (n) => {
              const b = h('button', {}, 'Modifica WPA2');
              b.onclick = (e) => {
                e.stopPropagation();
                edit(n.ssid);
              };
              return b;
            },
          },
        ],
        rows,
      ),
    );
    refreshActions();
  }

  async function load() {
    networks = (await api('/api/admin/wireless-networks')).sort((a, b) => sortKey(a.ssid) - sortKey(b.ssid));
    for (const s of [...selected]) if (!networks.some((n) => n.ssid === s)) selected.delete(s);
    syncForm();
    renderList();
  }

  await load();
  return h(
    'div',
    {},
    pageHead('Reti Wi-Fi', 'Le chiavi WPA2 sono cifrate (AES-256-GCM) e non vengono mai mostrate. Salvare di nuovo una rete esistente ne sostituisce la chiave.'),
    card(h('h2', {}, 'Aggiungi o aggiorna una rete'), form, h('div', { class: 'btns' }, state, h('label', { class: 'check small' }, showPsk, 'Mostra chiave mentre scrivi'))),
    card(
      h('h2', {}, 'Importa da CSV'),
      h(
        'p',
        { class: 'small muted' },
        'Colonne: nodo;distretto;wpa2 (oppure ssid;wpa2). Separatore ; o , — una riga per rete. Le reti già presenti vengono aggiornate. Prima di salvare viene mostrata un’anteprima; se una riga è errata non viene importato nulla.',
      ),
      h('div', { class: 'row' }, field('File CSV', csvFile), h('a', { class: 'button-link', href: 'assets/esempio-reti-wifi.csv', download: 'esempio-reti-wifi.csv' }, 'Scarica CSV di esempio')),
      importEl,
    ),
    card(h('div', { class: 'row' }, field('Cerca', search), h('div', { class: 'btns' }, clearSel, delSel)), counter, listEl),
  );
}
