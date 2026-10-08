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
  template_audience_empty: 'Seleziona almeno un installatore',
  default_must_be_public: 'Il predefinito generale deve essere visibile a tutti: rendi predefinito un altro template prima di riservare questo.',
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

export async function profilesView({ params } = {}) {
  const [models, placeholders, users] = await Promise.all([api('/api/admin/profiles'), api('/api/admin/placeholders'), api('/api/admin/users')]);
  const activeUsers = users.filter((u) => u.active);
  const editorEl = h('div', {});
  let dirty = false;
  window.onbeforeunload = null;

  async function rerender() {
    dirty = false;
    if (location.hash.includes('?')) location.hash = '#/profiles';
    document.getElementById('view').replaceChildren(await profilesView());
  }

  /**
   * Editor for a new template (from a CPE backup or a copy) or an existing one.
   * opts: { model, id?, name?, template?, boardMatch?, isDefault?, suggestedBoardMatch?, audience?, users?|userIds?, defaultForAssigned? }
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

    // ---- Who may use it: everyone, or only selected installers (personal templates)
    const chosen = new Set(opts.userIds ?? (opts.users ?? []).map((u) => u.id));
    const audAll = h('input', { type: 'radio', name: 'audience', value: 'all' });
    const audUsers = h('input', { type: 'radio', name: 'audience', value: 'users' });
    (opts.audience === 'users' ? audUsers : audAll).checked = true;
    const dfa = h('input', { type: 'checkbox' });
    dfa.checked = opts.audience === 'users' ? !!opts.defaultForAssigned : true;
    const userChecks = activeUsers.map((u) => {
      const cb = h('input', { type: 'checkbox', value: u.id });
      cb.checked = chosen.has(u.id);
      cb.onchange = () => (cb.checked ? chosen.add(u.id) : chosen.delete(u.id), markDirty());
      return h('label', { class: 'check small' }, cb, `${u.username}${u.role === 'admin' ? ' (admin)' : ''}`);
    });
    const userBox = h('div', { class: 'user-picks' }, userChecks.length ? userChecks : h('p', { class: 'muted small' }, 'Nessun account attivo.'));
    const dfaWrap = h('label', { class: 'check small' }, dfa, 'Predefinito per gli installatori selezionati (proposto automaticamente nell’app)');
    const syncAudience = () => {
      const restricted = audUsers.checked;
      userBox.hidden = dfaWrap.hidden = !restricted;
      isDefault.disabled = restricted;
      if (restricted) isDefault.checked = false;
    };
    audAll.onchange = audUsers.onchange = () => (syncAudience(), markDirty());
    dfa.onchange = markDirty;
    isDefault.onchange = markDirty;
    syncAudience();
    const audienceBody = () =>
      audUsers.checked
        ? { audience: 'users', userIds: [...chosen], defaultForAssigned: dfa.checked }
        : { audience: 'all' };
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
        if (audUsers.checked && chosen.size === 0) throw new Error('Seleziona almeno un installatore oppure scegli "Tutti gli installatori"');
        try {
          const body = { name: name.value.trim(), template: text.value, boardMatch: boardMatch.value.trim(), ...audienceBody() };
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
        h('h3', {}, 'Chi può usarlo'),
        h('label', { class: 'check small' }, audAll, 'Tutti gli installatori'),
        h('label', { class: 'check small' }, audUsers, 'Solo gli installatori selezionati (template personale o di squadra)'),
        userBox,
        dfaWrap,
        h('label', { class: 'check small' }, isDefault, opts.isDefault ? 'Predefinito generale del modello' : 'Imposta come predefinito generale del modello (solo se visibile a tutti)'),
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
          openEditor({ model: t.model, name: `${t.name} (copia)`.slice(0, 60), template: full.template, boardMatch: full.boardMatch, audience: full.audience, users: full.users, defaultForAssigned: full.defaultForAssigned });
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
              {
                label: 'Chi può usarlo',
                render: (t) =>
                  t.audience === 'users'
                    ? h('div', {}, badge(t.users.length === 1 ? 'personale' : `${t.users.length} installatori`, 'warn'), ' ', h('span', { class: 'small' }, t.users.map((u) => u.username).join(', ')), t.defaultForAssigned ? h('div', { class: 'small muted' }, 'predefinito per loro') : null)
                    : badge('tutti', ''),
              },
              { label: 'Board match', render: (t) => h('span', { class: 'mono small' }, t.boardMatch) },
              { label: 'Aggiornato', render: (t) => h('span', { class: 'small' }, `${fmtDate(t.updatedAt)}${t.updatedBy ? ` · ${t.updatedBy}` : ''}`) },
              { label: 'Azioni', render: actions },
            ],
            m.templates,
          )
        : null,
    );
  }

  function personalShortcut(userId) {
    const u = users.find((x) => x.id === userId);
    if (!u) return null;
    const model = h('select', {}, models.map((m) => h('option', { value: m.model }, m.model)));
    const base = h('select', {});
    const fillBase = () => {
      const m = models.find((x) => x.model === model.value);
      base.replaceChildren(h('option', { value: '' }, 'Vuoto / da backup CPE'), ...m.templates.map((t) => h('option', { value: t.id, selected: t.isDefault }, `Copia di "${t.name}"`)));
    };
    model.onchange = fillBase;
    fillBase();
    const go = h('button', { class: 'primary' }, 'Crea template personale');
    go.onclick = () =>
      busy(go, async () => {
        const src = base.value ? await api(`/api/admin/templates/${base.value}`) : null;
        openEditor({
          model: model.value,
          name: `${u.username}${src ? ` · ${src.name}` : ''}`.slice(0, 60),
          template: src?.template,
          boardMatch: src?.boardMatch,
          audience: 'users',
          userIds: [u.id],
          defaultForAssigned: true,
        });
      });
    return card(
      h('h2', {}, `Template personale per ${u.username}`),
      h('p', { class: 'small muted' }, 'Sarà visibile solo a questo installatore e proposto come suo predefinito nell’app. Puoi partire da un template esistente o da un backup.'),
      h('div', { class: 'row' }, field('Modello', model), field('Parti da', base), go),
    );
  }

  return h(
    'div',
    {},
    pageHead(
      'Profili airOS',
      'Più template per modello, ognuno visibile a tutti gli installatori o solo a quelli scelti (template personali). Il predefinito viene proposto nell’app; un installatore vede e usa solo i template a cui ha accesso.',
    ),
    params?.get('user') ? personalShortcut(Number(params.get('user'))) : null,
    editorEl,
    models.map(modelCard),
  );
}
