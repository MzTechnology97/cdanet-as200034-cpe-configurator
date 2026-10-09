import { ApiError, api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';

/** CDA-NET-N{nodo}-D{distretto}, -R{n} for a relay ("rilancio") AP of the district. */
const SSID_RX = /^CDA-NET-N(\d+)-D(\d+)(?:-R(\d+))?$/;
const ssidOf = (n, d, r) => `CDA-NET-N${n}-D${String(d).padStart(2, '0')}${Number(r) ? `-R${r}` : ''}`;
/** Natural order: N2 before N11, D02 before D10, the district's AP before its relays. */
const sortKey = (s) => {
  const m = SSID_RX.exec(s);
  return m ? Number(m[1]) * 100000 + Number(m[2]) * 100 + Number(m[3] ?? 0) : Number.MAX_SAFE_INTEGER;
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
  const relay = h('select', {}, h('option', { value: 0 }, 'nessuno (AP del distretto)'));
  for (let r = 1; r <= 9; r++) relay.append(h('option', { value: r }, `R${r}`));
  const ssidPreview = h('input', { readonly: true });
  const psk = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 63 });
  const showPsk = h('input', { type: 'checkbox' });
  showPsk.onchange = () => (psk.type = showPsk.checked ? 'text' : 'password');
  const state = h('span', {});
  const save = h('button', { class: 'primary', type: 'submit' }, 'Salva chiave');
  const currentSsid = () => ssidOf(node.value, district.value, relay.value);
  const syncForm = () => {
    ssidPreview.value = currentSsid();
    const exists = networks.some((n) => n.ssid === currentSsid());
    save.textContent = exists ? 'Aggiorna chiave' : 'Salva chiave';
    mount(state, exists ? badge('Già configurata: verrà sostituita', 'warn') : badge('Nuova rete', 'good'));
  };
  node.onchange = district.onchange = relay.onchange = syncForm;

  function edit(ssid) {
    const m = SSID_RX.exec(ssid);
    if (!m) return;
    node.value = String(Number(m[1]));
    district.value = String(Number(m[2]));
    relay.value = String(Number(m[3] ?? 0));
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
    field('Rilancio', relay),
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

  // ---- From UISP: the SSIDs not yet imported, one shared WPA2 key ---------------------------
  const uispEl = h('div', {});
  const uispKey = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 63, placeholder: 'chiave WPA2 comune a tutti gli AP' });
  const uispShow = h('input', { type: 'checkbox' });
  uispShow.onchange = () => (uispKey.type = uispShow.checked ? 'text' : 'password');
  const uispAll = h('input', { type: 'checkbox' });
  const uispAllText = h('span', {});
  const uispSearch = h('input', { type: 'search', placeholder: 'Filtra: N12, D05…' });
  const pickEl = h('div', { class: 'pick ssid-pick' });
  const pickCount = h('span', { class: 'muted small' });
  const readBtn = h('button', { type: 'button' }, 'Leggi gli SSID da UISP');
  const applyBtn = h('button', { type: 'button', class: 'primary' }, 'Importa');
  const pickAll = h('button', { type: 'button' }, 'Tutti');
  const pickNone = h('button', { type: 'button' }, 'Nessuno');
  let found = null;
  const chosen = new Set();

  const matches = (ssid) => {
    const q = uispSearch.value.trim().toUpperCase();
    return !q || ssid.includes(q) || ssid.replace('CDA-NET-', '').includes(q);
  };
  const refreshApply = () => {
    const n = chosen.size + (uispAll.checked ? found?.imported ?? 0 : 0);
    applyBtn.textContent = chosen.size ? `Importa ${chosen.size} SSID` : uispAll.checked ? `Aggiorna ${found?.imported ?? 0} reti` : 'Importa';
    applyBtn.disabled = n === 0;
    pickCount.textContent = `${chosen.size} di ${found?.pending.length ?? 0} selezionati`;
  };
  /** One compact row per node: N2 · D01 D02 D02-R1 … (AP names on hover). */
  function renderPick() {
    const byNode = new Map();
    for (const s of found.pending.filter((p) => matches(p.ssid))) {
      const m = SSID_RX.exec(s.ssid);
      const nodeKey = Number(m[1]);
      byNode.set(nodeKey, [...(byNode.get(nodeKey) ?? []), s]);
    }
    const rows = [...byNode].sort((a, b) => a[0] - b[0]);
    mount(
      pickEl,
      rows.length
        ? rows.map(([n, list]) =>
            h(
              'div',
              { class: 'pick-pop' },
              h('b', { class: 'mono' }, `N${n}`),
              h(
                'div',
                { class: 'chips' },
                list
                  .sort((a, b) => sortKey(a.ssid) - sortKey(b.ssid))
                  .map((s) => {
                    const cb = h('input', { type: 'checkbox', 'aria-label': s.ssid });
                    cb.checked = chosen.has(s.ssid);
                    cb.onchange = () => {
                      cb.checked ? chosen.add(s.ssid) : chosen.delete(s.ssid);
                      refreshApply();
                    };
                    return h('label', { class: 'check', title: `${s.ssid}\n${s.aps.join(', ')}` }, cb, s.ssid.replace(/^CDA-NET-N\d+-/, ''));
                  }),
              ),
            ),
          )
        : h('p', { class: 'muted small' }, 'Nessun SSID corrisponde al filtro.'),
    );
    refreshApply();
  }
  uispSearch.oninput = () => renderPick();
  pickAll.onclick = () => {
    for (const s of found.pending) if (matches(s.ssid)) chosen.add(s.ssid);
    renderPick();
  };
  pickNone.onclick = () => {
    for (const s of found.pending) if (matches(s.ssid)) chosen.delete(s.ssid);
    renderPick();
  };
  uispAll.onchange = refreshApply;

  function showUisp() {
    if (!found) return mount(uispEl);
    chosen.clear();
    for (const s of found.pending) chosen.add(s.ssid);
    uispAllText.textContent = `Sostituisci la chiave anche sulle ${found.imported} reti già importate`;
    const skipped = found.skipped.length
      ? h(
          'details',
          {},
          h('summary', { class: 'small muted' }, `${found.skipped.length} SSID non nel formato CDA-NET-N{nodo}-D{distretto} (non importabili)`),
          h('p', { class: 'small mono' }, found.skipped.map((s) => s.ssid).join(', ')),
        )
      : null;
    if (!found.pending.length) {
      if (!found.imported) return mount(uispEl, h('p', { class: 'muted' }, 'Nessun AP CDA Net trovato in UISP.'), skipped);
      mount(
        uispEl,
        h('div', { class: 'notice good' }, `Tutti i ${found.imported} SSID degli AP in UISP sono già importati.`),
        skipped,
        h('div', { class: 'row' }, field('Chiave WPA2 comune (8-63 caratteri)', uispKey), h('div', { class: 'btns' }, applyBtn)),
        h('label', { class: 'check small' }, uispShow, 'Mostra chiave mentre scrivi'),
        h('label', { class: 'check small' }, uispAll, uispAllText),
      );
      return refreshApply();
    }
    mount(
      uispEl,
      h('p', { class: 'small' }, badge(`${found.pending.length} da importare`, 'good'), ' ', badge(`${found.imported} già importati`, '')),
      h('div', { class: 'row' }, field('Cerca', uispSearch), h('div', { class: 'btns' }, pickAll, pickNone, pickCount)),
      pickEl,
      skipped,
      h('div', { class: 'row' }, field('Chiave WPA2 comune (8-63 caratteri)', uispKey), h('div', { class: 'btns' }, applyBtn)),
      h('label', { class: 'check small' }, uispShow, 'Mostra chiave mentre scrivi'),
      found.imported ? h('label', { class: 'check small' }, uispAll, uispAllText) : null,
    );
    renderPick();
  }
  readBtn.onclick = () =>
    busy(readBtn, async () => {
      found = await api('/api/admin/wireless-networks/uisp');
      uispSearch.value = '';
      showUisp();
    });
  applyBtn.onclick = () =>
    busy(applyBtn, async () => {
      if (uispKey.value.length < 8 || uispKey.value.length > 63) throw new Error('La chiave WPA2 deve avere da 8 a 63 caratteri');
      const body = { wpa2Password: uispKey.value, ssids: [...chosen], scope: uispAll.checked ? 'all' : 'new' };
      const preview = await api('/api/admin/wireless-networks/uisp-import', { method: 'POST', body: { ...body, dryRun: true } });
      const n = preview.created.length + preview.updated.length;
      if (!n) return toast('Tutte le reti hanno già questa chiave');
      const parts = [preview.created.length ? `${preview.created.length} nuove` : '', preview.updated.length ? `${preview.updated.length} già importate (la chiave verrà sostituita)` : ''].filter(Boolean);
      if (!confirm(`Applicare la chiave a ${n} reti?\n${parts.join(', ')}.`)) return;
      const r = await api('/api/admin/wireless-networks/uisp-import', { method: 'POST', body: { ...body, dryRun: false } });
      uispKey.value = '';
      uispAll.checked = false;
      toast(`Chiave applicata: ${r.created.length} nuove, ${r.updated.length} aggiornate`);
      found = await api('/api/admin/wireless-networks/uisp');
      showUisp();
      await load();
    });

  // ---- Export with the keys in clear (the admin's password again) ----------------------------
  const exportBtn = h('button', { type: 'button' }, 'Esporta CSV con le chiavi');
  const exportEl = h('div', {});
  exportBtn.onclick = () => {
    const pw = h('input', { type: 'password', autocomplete: 'current-password' });
    const go = h('button', { class: 'primary', type: 'submit' }, 'Scarica');
    const cancel = h('button', { type: 'button' }, 'Annulla');
    cancel.onclick = () => mount(exportEl);
    const what = selected.size ? `le ${selected.size} reti selezionate` : `tutte le ${networks.length} reti`;
    mount(
      exportEl,
      h(
        'form',
        {
          class: 'notice warn',
          onsubmit: (e) => {
            e.preventDefault();
            busy(go, async () => {
              const body = { password: pw.value, ...(selected.size ? { ssids: [...selected] } : {}) };
              const r = await api('/api/admin/wireless-networks/export', { method: 'POST', body, raw: true });
              if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => ({})));
              const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'reti-wifi.csv';
              const a = h('a', { href: URL.createObjectURL(await r.blob()), download: name });
              document.body.append(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
              mount(exportEl);
              toast('CSV scaricato: contiene le chiavi in chiaro, conservalo al sicuro');
            });
          },
        },
        h('p', { class: 'small' }, `Il file conterrà ${what} con la chiave WPA2 in chiaro (stesso formato dell'import CSV). L'esportazione viene registrata e segnalata agli amministratori.`),
        h('div', { class: 'row' }, field('La tua password', pw), h('div', { class: 'btns' }, go, cancel)),
      ),
    );
    pw.focus();
  };

  await load();
  return h(
    'div',
    {},
    pageHead('Reti Wi-Fi', 'Le chiavi WPA2 sono cifrate (AES-256-GCM) e non vengono mai mostrate. Salvare di nuovo una rete esistente ne sostituisce la chiave.'),
    card(
      h('h2', {}, 'Importa da UISP'),
      h('p', { class: 'small muted' }, 'Gli SSID degli AP dei clienti presi da UISP (rilanci compresi, collegamenti PtP esclusi) che non hanno ancora una chiave: una sola chiave WPA2 comune per tutti, senza inserirli a mano uno per volta.'),
      h('div', { class: 'btns' }, readBtn),
      uispEl,
    ),
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
    card(h('div', { class: 'row' }, field('Cerca', search), h('div', { class: 'btns' }, clearSel, delSel, exportBtn)), exportEl, counter, listEl),
  );
}
