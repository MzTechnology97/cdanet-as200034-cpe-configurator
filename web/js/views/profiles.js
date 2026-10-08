import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';

const MESSAGES = {
  template_size: 'Dimensione non valida (minimo 64 caratteri)',
  profile_not_system_cfg: 'Non sembra una configurazione airOS (mancano radio./wireless./netconf./users.)',
  profile_contains_vlan: 'Contiene una VLAN (vlan.* o ppp.N.devname=ath0.X): la policy CDA Net non la prevede.',
  profile_contains_nul: 'Contiene byte NUL',
  unknown_placeholders: 'Placeholder non riconosciuti',
  users_password_requires_hash_placeholder: 'users.N.password deve usare ${CPE_PASSWORD_HASH}, non ${CPE_PASSWORD}',
  non_key_value_lines: 'Alcune righe non sono nel formato chiave=valore',
  template_name_exists: 'Esiste già un template con questo nome per il modello',
  board_match_invalid_regex: 'Board match: espressione regolare non valida',
};
const msg = (c) => MESSAGES[c] ?? (c.startsWith('missing_placeholder_') ? `Placeholder ${c.slice(20)} non presente` : c);

function downloadText(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function reportView(r) {
  return [
    h(
      'div',
      { class: `notice ${r.ok ? (r.warnings.length ? 'warn' : 'good') : 'bad'}` },
      r.ok ? `Template valido · ${r.lines} righe · placeholder: ${r.placeholders.join(', ') || 'nessuno'}` : 'Template non valido:',
      r.errors.length ? h('ul', { class: 'plain' }, r.errors.map((e) => h('li', {}, msg(e)))) : null,
      r.unknownPlaceholders?.length ? h('p', { class: 'mono small' }, r.unknownPlaceholders.join(', ')) : null,
    ),
    r.warnings.length ? h('div', { class: 'notice warn' }, h('ul', { class: 'plain' }, r.warnings.map((w) => h('li', {}, msg(w))))) : null,
  ];
}

export async function profilesView() {
  const [models, placeholders] = await Promise.all([api('/api/admin/profiles'), api('/api/admin/placeholders')]);
  const editorEl = h('div', {});
  let dirty = false;
  window.onbeforeunload = null;

  async function rerender() {
    dirty = false;
    document.getElementById('view').replaceChildren(await profilesView());
  }

  /**
   * Editor for a new template (from a CPE backup or a copy) or an existing one.
   * opts: { model, id?, name?, template?, boardMatch?, isDefault?, fromBackup?, suggestedBoardMatch? }
   */
  function openEditor(opts) {
    const isNew = !opts.id;
    const name = h('input', { value: opts.name ?? '', placeholder: 'es. Standard, Palo alto, Bassa potenza', maxlength: 60 });
    const boardMatch = h('input', { value: opts.boardMatch ?? opts.suggestedBoardMatch ?? '', placeholder: 'es. board\\.name=LiteBeam 5AC' });
    const isDefault = h('input', { type: 'checkbox' });
    isDefault.checked = !!opts.isDefault;
    const text = h('textarea', { class: 'code-editor', spellcheck: 'false', autocomplete: 'off', rows: 22, wrap: 'off' });
    text.value = opts.template ?? '';
    const stats = h('span', { class: 'small muted' });
    const updateStats = () => (stats.textContent = `${text.value.split('\n').length} righe`);
    const report = h('div', {});
    const replacements = h('div', {});
    const markDirty = () => {
      dirty = true;
      window.onbeforeunload = () => true;
    };
    for (const el of [name, boardMatch, text]) el.addEventListener('input', markDirty);
    isDefault.onchange = markDirty;
    text.addEventListener('input', updateStats);
    updateStats();

    const insert = (token) => {
      const { selectionStart: a, selectionEnd: b, value } = text;
      text.value = value.slice(0, a) + token + value.slice(b);
      text.selectionStart = text.selectionEnd = a + token.length;
      text.focus();
      markDirty();
      updateStats();
    };
    const chips = h(
      'div',
      { class: 'chips' },
      placeholders.map((p) => {
        const b = h('button', { type: 'button', class: 'chip', title: p.description }, `\${${p.name}}`);
        b.onclick = () => insert(`\${${p.name}}`);
        return b;
      }),
    );

    // Optional: start from a CPE backup (new templates only).
    const backupFile = h('input', { type: 'file', accept: '.cfg,.txt,text/plain' });
    backupFile.onchange = () =>
      busy(save, async () => {
        const f = backupFile.files?.[0];
        if (!f) return;
        const r = await api(`/api/admin/profiles/${encodeURIComponent(opts.model)}/autotemplate`, { method: 'POST', body: { backup: await f.text() } });
        text.value = r.template;
        if (!boardMatch.value.trim()) boardMatch.value = r.suggestedBoardMatch;
        if (!name.value.trim()) name.value = f.name.replace(/\.[^.]+$/, '').slice(0, 60);
        markDirty();
        updateStats();
        mount(report, reportView(r.report), r.warnings.length ? h('div', { class: 'notice warn' }, h('ul', { class: 'plain' }, r.warnings.map((w) => h('li', {}, w)))) : null);
        mount(
          replacements,
          h('details', { open: true }, h('summary', {}, `${r.replacements.length} valori sostituiti dal backup`),
            table(
              [
                { label: 'Riga', key: 'line' },
                { label: 'Chiave', render: (x) => h('span', { class: 'mono small' }, x.key) },
                { label: 'Valore nel backup', render: (x) => h('span', { class: 'mono small' }, x.original) },
                { label: 'Diventa', render: (x) => h('code', {}, `\${${x.placeholder}}`) },
              ],
              r.replacements,
            ),
          ),
        );
      });

    const check = h('button', { type: 'button' }, 'Controlla');
    check.onclick = () =>
      busy(check, async () => {
        const r = await api(`/api/admin/profiles/${encodeURIComponent(opts.model)}/inspect`, {
          method: 'POST',
          body: { template: text.value, ...(boardMatch.value.trim() ? { boardMatch: boardMatch.value.trim() } : {}) },
        });
        mount(report, reportView(r));
      });

    const save = h('button', { type: 'button', class: 'primary' }, isNew ? 'Salva nuovo template' : 'Salva modifiche');
    save.onclick = () =>
      busy(save, async () => {
        if (!name.value.trim()) throw new Error('Inserisci un nome per il template');
        if (!text.value.trim()) throw new Error('Il template è vuoto: carica un backup o incolla una configurazione');
        try {
          const body = { name: name.value.trim(), template: text.value, boardMatch: boardMatch.value.trim() };
          const r = isNew
            ? await api(`/api/admin/profiles/${encodeURIComponent(opts.model)}/templates`, { method: 'POST', body: { ...body, isDefault: isDefault.checked } })
            : await api(`/api/admin/templates/${opts.id}`, { method: 'PATCH', body: { ...body, ...(isDefault.checked && !opts.isDefault ? { isDefault: true } : {}) } });
          toast(`Template "${r.name}" salvato · ${r.sha256.slice(0, 12)}…`);
          window.onbeforeunload = null;
          await rerender();
        } catch (e) {
          if (e.body?.report) mount(report, reportView(e.body.report));
          throw new Error(MESSAGES[e.body?.error] ?? e.message);
        }
      });

    const download = h('button', { type: 'button' }, 'Scarica');
    download.onclick = () => downloadText(`template-${opts.model.replace(/\s+/g, '-')}-${(name.value || 'nuovo').replace(/[^\w.-]+/g, '_')}.cfg`, text.value);
    const cancel = h('button', { type: 'button' }, 'Chiudi');
    cancel.onclick = () => {
      if (dirty && !confirm('Chiudere senza salvare le modifiche?')) return;
      dirty = false;
      window.onbeforeunload = null;
      mount(editorEl);
    };

    mount(
      editorEl,
      card(
        h('h2', {}, isNew ? `Nuovo template · ${opts.model}` : `Modifica template · ${opts.model} · ${opts.name}`),
        !isNew && opts.updatedAt ? h('p', { class: 'small muted' }, `Ultima modifica ${fmtDate(opts.updatedAt)}${opts.updatedBy ? ` · ${opts.updatedBy}` : ''} · SHA-256 ${opts.sha256?.slice(0, 16)}…`) : null,
        isNew ? h('div', { class: 'row' }, field('Parti da un backup della CPE (.cfg) — opzionale', backupFile)) : null,
        h('div', { class: 'row' }, field('Nome', name), field('Board match (regex su /etc/board.info)', boardMatch)),
        h('label', { class: 'check small' }, isDefault, opts.isDefault ? 'Template predefinito del modello' : 'Imposta come predefinito per il modello'),
        h('h3', {}, 'Configurazione'),
        h('p', { class: 'small muted' }, 'Clic su un placeholder per inserirlo nel punto del cursore. Watchdog, SNMP, EIRP/ATPC e Device Name vengono comunque forzati dal server a ogni provisioning.'),
        chips,
        text,
        stats,
        report,
        replacements,
        h('div', { class: 'btns' }, save, check, download, cancel),
      ),
    );
    editorEl.scrollIntoView({ behavior: 'smooth' });
  }

  async function edit(t) {
    const full = await api(`/api/admin/templates/${t.id}`);
    openEditor({ ...full, model: t.model });
  }

  function modelCard(m) {
    const fromBackup = h('button', { class: 'primary' }, 'Nuovo template');
    fromBackup.onclick = () => {
      if (dirty && !confirm('Ci sono modifiche non salvate nell’editor. Continuare?')) return;
      openEditor({ model: m.model, isDefault: m.templates.length === 0, name: m.templates.length === 0 ? 'Standard' : '' });
    };
    const actions = (t) => {
      const box = h('div', { class: 'btns' });
      const editBtn = h('button', {}, 'Modifica');
      editBtn.onclick = (e) => {
        e.stopPropagation();
        if (dirty && !confirm('Ci sono modifiche non salvate nell’editor. Continuare?')) return;
        busy(editBtn, () => edit(t));
      };
      const dupBtn = h('button', {}, 'Duplica');
      dupBtn.onclick = (e) => {
        e.stopPropagation();
        busy(dupBtn, async () => {
          const full = await api(`/api/admin/templates/${t.id}`);
          openEditor({ model: t.model, name: `${t.name} (copia)`.slice(0, 60), template: full.template, boardMatch: full.boardMatch });
        });
      };
      const defBtn = h('button', {}, 'Rendi predefinito');
      defBtn.onclick = (e) => {
        e.stopPropagation();
        busy(defBtn, async () => {
          await api(`/api/admin/templates/${t.id}`, { method: 'PATCH', body: { isDefault: true } });
          toast(`"${t.name}" è ora il predefinito per ${t.model}`);
          await rerender();
        });
      };
      const delBtn = h('button', { class: 'danger' }, 'Elimina');
      delBtn.onclick = (e) => {
        e.stopPropagation();
        const last = m.templates.length === 1;
        if (!confirm(`Eliminare il template "${t.name}" di ${t.model}?${last ? '\n\nÈ l’unico template del modello: il provisioning di questo modello verrà bloccato.' : t.isDefault ? '\n\nÈ il predefinito: diventerà predefinito il template modificato più di recente.' : ''}`)) return;
        busy(delBtn, async () => {
          await api(`/api/admin/templates/${t.id}`, { method: 'DELETE' });
          toast('Template eliminato');
          await rerender();
        });
      };
      box.append(editBtn, dupBtn);
      if (!t.isDefault) box.append(defBtn);
      box.append(delBtn);
      return box;
    };
    return card(
      h(
        'div',
        { class: 'page-head' },
        h('div', {}, h('h2', {}, m.model), h('p', { class: 'small muted' }, `airOS ${m.firmware} · ${m.templates.length ? `${m.templates.length} template` : 'nessun template: provisioning bloccato'}`)),
        h('div', { class: 'btns' }, fromBackup),
      ),
      m.templates.length
        ? table(
            [
              { label: 'Nome', render: (t) => h('div', {}, h('b', {}, t.name), ' ', t.isDefault ? badge('predefinito', 'good') : null) },
              { label: 'Board match', render: (t) => h('span', { class: 'mono small' }, t.boardMatch) },
              { label: 'Aggiornato', render: (t) => h('span', { class: 'small' }, `${fmtDate(t.updatedAt)}${t.updatedBy ? ` · ${t.updatedBy}` : ''}`) },
              { label: 'Azioni', render: actions },
            ],
            m.templates,
          )
        : null,
    );
  }

  return h(
    'div',
    {},
    pageHead(
      'Profili airOS',
      'Per ogni modello puoi avere più template con nomi diversi: il predefinito viene usato se in app non se ne sceglie un altro. Crea un template da un backup di una CPE di laboratorio (airOS 8.7.4) e modificalo qui.',
    ),
    editorEl,
    models.map(modelCard),
  );
}
