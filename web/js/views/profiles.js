import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';

const MESSAGES = {
  template_size: 'Dimensione file non valida',
  profile_not_system_cfg: 'Non sembra un backup di configurazione airOS (mancano radio./wireless./netconf./users.)',
  profile_contains_vlan: 'Contiene una VLAN (vlan.* o ppp.N.devname=ath0.X): la policy CDA Net non la prevede. Rimuovila dalla CPE di laboratorio e riesporta.',
  profile_contains_nul: 'Contiene byte NUL',
  unknown_placeholders: 'Placeholder non riconosciuti',
  users_password_requires_hash_placeholder: 'users.N.password deve usare ${CPE_PASSWORD_HASH}, non ${CPE_PASSWORD}',
  non_key_value_lines: 'Alcune righe non sono nel formato chiave=valore',
};
const msg = (c) => MESSAGES[c] ?? (c.startsWith('missing_placeholder_') ? `Placeholder ${c.slice(20)} non presente` : c);

function downloadText(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function profilesView() {
  const [profiles, placeholders] = await Promise.all([api('/api/admin/profiles'), api('/api/admin/placeholders')]);
  const editor = h('div', {});

  function open(p) {
    const file = h('input', { type: 'file', accept: '.cfg,.txt,text/plain' });
    const boardMatch = h('input', { value: p.profile?.boardMatch ?? '', placeholder: 'es. board\\.name=LiteBeam 5AC' });
    const preview = h('div', {});
    let template = '';

    const save = h('button', { class: 'primary', disabled: true }, 'Salva come profilo');
    const download = h('button', { disabled: true }, 'Scarica template generato');
    download.onclick = () => downloadText(`template-${p.model.replace(/\s+/g, '-')}-8.7.4.cfg`, template);

    file.onchange = () =>
      busy(save, async () => {
        const f = file.files?.[0];
        if (!f) return;
        const backup = await f.text();
        mount(preview, h('p', { class: 'muted' }, 'Analisi del backup…'));
        const r = await api(`/api/admin/profiles/${encodeURIComponent(p.model)}/autotemplate`, { method: 'POST', body: { backup } });
        template = r.template;
        if (!boardMatch.value.trim()) boardMatch.value = r.suggestedBoardMatch;
        const ok = r.report.ok;
        mount(
          preview,
          h(
            'div',
            { class: `notice ${ok ? (r.warnings.length ? 'warn' : 'good') : 'bad'}` },
            ok
              ? `Template pronto: ${r.replacements.length} valori sostituiti con i placeholder, il resto della configurazione resta quello del laboratorio.`
              : 'Il backup non può diventare un profilo:',
            r.report.errors.length ? h('ul', { class: 'plain' }, r.report.errors.map((e) => h('li', {}, msg(e)))) : null,
          ),
          r.warnings.length ? h('div', { class: 'notice warn' }, h('b', {}, 'Da verificare'), h('ul', { class: 'plain' }, r.warnings.map((w) => h('li', {}, w)))) : null,
          h('h3', {}, 'Sostituzioni'),
          table(
            [
              { label: 'Riga', key: 'line' },
              { label: 'Chiave', render: (x) => h('span', { class: 'mono small' }, x.key) },
              { label: 'Valore nel backup', render: (x) => h('span', { class: 'mono small' }, x.original) },
              { label: 'Diventa', render: (x) => h('code', {}, `\${${x.placeholder}}`) },
            ],
            r.replacements,
          ),
          h(
            'p',
            { class: 'small muted' },
            'I valori segreti del backup (WPA2, PPPoE, password, UISP) non vengono mostrati e non restano nel template. ' +
              'Watchdog, SNMP, EIRP/ATPC e Device Name vengono comunque forzati dal server a ogni provisioning.',
          ),
        );
        save.disabled = !ok;
        download.disabled = !template;
      });

    save.onclick = () =>
      busy(save, async () => {
        if (!template) throw new Error('Seleziona prima il backup della CPE');
        const r = await api(`/api/admin/profiles/${encodeURIComponent(p.model)}`, { method: 'PUT', body: { template, boardMatch: boardMatch.value.trim() } });
        toast(`Profilo ${p.model} salvato · ${r.sha256.slice(0, 12)}…`);
        rerender();
      });

    const del = h('button', { class: 'danger' }, 'Elimina profilo');
    del.onclick = () =>
      confirm(`Eliminare il profilo di ${p.model}? Il provisioning di questo modello verrà bloccato.`) &&
      busy(del, async () => {
        await api(`/api/admin/profiles/${encodeURIComponent(p.model)}`, { method: 'DELETE' });
        toast('Profilo eliminato');
        rerender();
      });

    mount(
      editor,
      card(
        h('h2', {}, `${p.model} · airOS ${p.firmware}`),
        p.profile
          ? h('p', { class: 'small muted mono' }, `Profilo attuale: SHA-256 ${p.profile.sha256.slice(0, 16)}… · ${fmtDate(p.profile.updatedAt)}${p.profile.updatedBy ? ` · ${p.profile.updatedBy}` : ''}`)
          : null,
        h(
          'ol',
          { class: 'small' },
          h('li', {}, 'Configura una CPE di laboratorio (8.7.4) esattamente come in campo e verifica che funzioni.'),
          h('li', {}, 'Scarica il backup: System → Back Up Configuration → Download.'),
          h('li', {}, 'Caricalo qui così com’è: i parametri del cliente vengono sostituiti in automatico.'),
          h('li', {}, 'Controlla le sostituzioni e il board match (in SSH: cat /etc/board.info), poi salva.'),
        ),
        h('div', { class: 'row' }, field('Backup della CPE (.cfg)', file), field('Board match (regex su /etc/board.info)', boardMatch)),
        preview,
        h('div', { class: 'btns' }, save, download, p.profile ? del : null),
      ),
    );
    editor.scrollIntoView({ behavior: 'smooth' });
  }

  async function rerender() {
    const view = await profilesView();
    document.getElementById('view').replaceChildren(view);
  }

  return h(
    'div',
    {},
    pageHead('Profili airOS', 'Carica il backup di una CPE di laboratorio: il template con i placeholder viene creato in automatico. Un profilo per modello, airOS 8.7.4.'),
    card(
      table(
        [
          { label: 'Modello', key: 'model' },
          { label: 'Stato', render: (p) => (p.profile ? badge('Configurato', 'good') : badge('Mancante', 'bad')) },
          { label: 'Board match', render: (p) => h('span', { class: 'mono small' }, p.profile?.boardMatch ?? '—') },
          { label: 'Aggiornato', render: (p) => fmtDate(p.profile?.updatedAt) },
          { label: '', render: () => h('button', {}, 'Importa backup') },
        ],
        profiles,
        open,
      ),
    ),
    editor,
    card(
      h('h2', {}, 'Placeholder'),
      h('p', { class: 'small muted' }, 'Vengono inseriti automaticamente. Puoi anche caricare un template già preparato a mano: le righe con un placeholder restano invariate.'),
      table(
        [
          { label: 'Placeholder', render: (x) => h('code', {}, `\${${x.name}}`) },
          { label: 'Descrizione', key: 'description' },
        ],
        placeholders,
      ),
    ),
  );
}
