import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';

const MESSAGES = {
  template_size: 'Dimensione file non valida',
  profile_not_system_cfg: 'Manca system.cfg.version=: non è un export airOS',
  profile_contains_vlan: 'Contiene chiavi VLAN legacy (vlan.* / ppp.N.devname=ath0.X)',
  profile_contains_nul: 'Contiene byte NUL',
  unknown_placeholders: 'Placeholder non riconosciuti',
  users_password_requires_hash_placeholder: 'users.N.password deve usare ${CPE_PASSWORD_HASH}, non ${CPE_PASSWORD}',
  non_key_value_lines: 'Alcune righe non sono nel formato chiave=valore',
};
const msg = (c) => MESSAGES[c] ?? (c.startsWith('missing_placeholder_') ? `Placeholder ${c.slice(20)} non presente` : c);

export async function profilesView() {
  const [profiles, placeholders] = await Promise.all([api('/api/admin/profiles'), api('/api/admin/placeholders')]);
  const editor = h('div', {});

  function open(p) {
    const file = h('input', { type: 'file', accept: '.cfg,text/plain' });
    const boardMatch = h('input', { value: p.profile?.boardMatch ?? '', placeholder: 'es. board\\.name=LiteBeam 5AC' });
    const report = h('div', {});
    let template = '';

    file.onchange = async () => {
      template = (await file.files?.[0]?.text()) ?? '';
      await inspect();
    };
    async function inspect() {
      if (!template) return;
      const r = await api(`/api/admin/profiles/${encodeURIComponent(p.model)}/inspect`, { method: 'POST', body: { template } });
      mount(
        report,
        h('div', { class: `notice ${r.ok ? (r.warnings.length ? 'warn' : 'good') : 'bad'}` }, r.ok ? `Profilo valido · ${r.lines} righe` : 'Profilo non valido'),
        r.errors.length ? h('ul', { class: 'plain' }, r.errors.map((e) => h('li', {}, msg(e)))) : null,
        r.warnings.length ? h('ul', { class: 'plain muted' }, r.warnings.map((e) => h('li', {}, msg(e)))) : null,
        r.unknownPlaceholders.length ? h('p', { class: 'mono small' }, r.unknownPlaceholders.join(', ')) : null,
        h('p', { class: 'small muted' }, `Placeholder usati: ${r.placeholders.join(', ') || 'nessuno'}`),
      );
    }

    const upload = h('button', { class: 'primary' }, 'Carica profilo cifrato');
    upload.onclick = () =>
      busy(upload, async () => {
        if (!template) throw new Error('Seleziona un export system.cfg');
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
        p.profile ? h('p', { class: 'small muted mono' }, `SHA-256 ${p.profile.sha256} · ${fmtDate(p.profile.updatedAt)}${p.profile.updatedBy ? ` · ${p.profile.updatedBy}` : ''}`) : null,
        h('div', { class: 'row' }, field('Export system.cfg (8.7.4, placeholder già inseriti)', file), field('Board match (regex su /etc/board.info)', boardMatch)),
        report,
        h('div', { class: 'btns' }, upload, p.profile ? del : null),
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
    pageHead('Profili airOS', 'Un export reale per modello, validato in laboratorio su 8.7.4. Il server sostituisce i placeholder e forza la policy CDA Net.'),
    card(
      table(
        [
          { label: 'Modello', key: 'model' },
          { label: 'Stato', render: (p) => (p.profile ? badge('Configurato', 'good') : badge('Mancante', 'bad')) },
          { label: 'Board match', render: (p) => h('span', { class: 'mono small' }, p.profile?.boardMatch ?? '—') },
          { label: 'Aggiornato', render: (p) => fmtDate(p.profile?.updatedAt) },
        ],
        profiles,
        open,
      ),
    ),
    editor,
    card(
      h('h2', {}, 'Placeholder disponibili'),
      h('p', { class: 'small muted' }, 'Policy sempre forzata dal server: watchdog, SNMP (community/contact/location), EIRP limit OFF, ATPC Station ON, Device Name. Nessuna VLAN.'),
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
