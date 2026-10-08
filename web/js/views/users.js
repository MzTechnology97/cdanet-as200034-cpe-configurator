import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';

export async function usersView({ user: me }) {
  const list = h('div', {});
  let profiles = [];
  const editor = h('div', {});

  async function load() {
    const [users, p] = await Promise.all([api('/api/admin/users'), api('/api/admin/profiles')]);
    profiles = p;
    mount(
      list,
      table(
        [
          { label: 'Username', key: 'username' },
          { label: 'Ruolo', render: (u) => badge(u.role === 'admin' ? 'Admin' : 'Installatore', u.role === 'admin' ? 'warn' : '') },
          { label: 'Stato', render: (u) => badge(u.active ? 'Attivo' : 'Disabilitato', u.active ? 'good' : 'bad') },
          { label: '2FA', render: (u) => (u.totpEnabled ? badge('attiva', 'good') : u.role === 'admin' ? badge('no', 'warn') : '—') },
          { label: 'Ultimo accesso', render: (u) => fmtDate(u.lastLoginAt) },
          { label: 'Provisioning', key: 'jobs' },
        ],
        users,
        edit,
      ),
    );
  }

  function edit(u) {
    const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 12, placeholder: 'Minimo 12 caratteri' });
    const patch = async (body, msg) => {
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
      toast(msg);
      mount(editor);
      await load();
    };
    const resetBtn = h('button', {}, 'Reimposta password');
    resetBtn.onclick = () =>
      busy(resetBtn, async () => {
        if (pw.value.length < 12) throw new Error('Password: minimo 12 caratteri');
        await patch({ password: pw.value }, 'Password aggiornata: sessioni esistenti revocate');
      });
    const toggle = h('button', { class: u.active ? 'danger' : '' }, u.active ? 'Disabilita' : 'Abilita');
    toggle.onclick = () =>
      busy(toggle, async () => {
        if (u.active && !confirm(`Disabilitare ${u.username}? Le sessioni attive verranno chiuse.`)) return;
        await patch({ active: !u.active }, u.active ? 'Account disabilitato' : 'Account abilitato');
      });
    const resetTotp = h('button', {}, 'Azzera verifica in due passaggi');
    resetTotp.onclick = () =>
      confirm(`Azzerare la verifica in due passaggi di ${u.username}? (telefono perso) Le sue sessioni verranno chiuse.`) &&
      busy(resetTotp, () => patch({ resetTotp: true }, 'Verifica in due passaggi azzerata'));
    const role = h('button', {}, u.role === 'admin' ? 'Rendi installatore' : 'Rendi admin');
    role.onclick = () => busy(role, () => patch({ role: u.role === 'admin' ? 'installer' : 'admin' }, 'Ruolo aggiornato'));
    mount(
      editor,
      card(
        h('h2', {}, `Account ${u.username}`),
        h('p', { class: 'muted small' }, `Creato ${fmtDate(u.createdAt)}`),
        h('div', { class: 'row' }, field('Nuova password', pw), resetBtn),
        u.totpEnabled ? h('div', { class: 'btns' }, resetTotp) : null,
        h('h3', {}, 'Template airOS'),
        (() => {
          const mine = profiles.flatMap((m) => m.templates).filter((t) => t.audience === 'users' && t.users.some((x) => x.id === u.id));
          return mine.length
            ? h('ul', { class: 'plain small' }, mine.map((t) => h('li', {}, `${t.model} · ${t.name}`, t.defaultForAssigned ? ' (predefinito per lui/lei)' : '', t.users.length > 1 ? ` · condiviso con ${t.users.length - 1} altri` : '')))
            : h('p', { class: 'small muted' }, 'Usa i template visibili a tutti. Nessun template riservato.');
        })(),
        h('a', { class: 'button-link', href: `#/profiles?user=${u.id}` }, 'Crea template personale'),
        h('h3', {}, 'Stato e ruolo'),
        u.id === me.id ? h('p', { class: 'muted' }, 'Non puoi disabilitare o declassare il tuo account.') : h('div', { class: 'btns' }, toggle, role),
      ),
    );
    editor.scrollIntoView({ behavior: 'smooth' });
  }

  const newUser = h('input', { autocomplete: 'off', placeholder: 'mario.rossi' });
  const newPass = h('input', { type: 'password', autocomplete: 'new-password', minlength: 12 });
  const newRole = h('select', {}, h('option', { value: 'installer' }, 'Installatore'), h('option', { value: 'admin' }, 'Admin'));
  const create = h('button', { class: 'primary', type: 'submit' }, 'Crea account');
  const form = h(
    'form',
    {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        busy(create, async () => {
          await api('/api/admin/users', { method: 'POST', body: { username: newUser.value.trim(), password: newPass.value, role: newRole.value } });
          toast(`Account ${newUser.value.trim()} creato`);
          newUser.value = '';
          newPass.value = '';
          await load();
        });
      },
    },
    field('Username', newUser),
    field('Password iniziale', newPass),
    field('Ruolo', newRole),
    create,
  );

  const sec = await api('/api/admin/security');
  const policy = h('input', { type: 'checkbox' });
  policy.checked = sec.totpRequiredForAdmins;
  policy.onchange = async () => {
    try {
      await api('/api/admin/security', { method: 'PUT', body: { totpRequiredForAdmins: policy.checked } });
      toast(policy.checked ? 'Verifica in due passaggi obbligatoria per gli admin' : 'Verifica in due passaggi facoltativa');
    } catch (e) {
      policy.checked = !policy.checked;
      toast(e.message, 'bad');
    }
  };
  const securityCard = card(
    h('h2', {}, 'Sicurezza'),
    h('label', { class: 'check' }, policy, 'Verifica in due passaggi obbligatoria per gli amministratori'),
    h('p', { class: 'small muted' }, 'Gli admin senza 2FA potranno solo attivarla da "Il mio account". Per abilitarla devi averla già attiva tu. Gli installatori possono attivarla quando vogliono.'),
  );

  await load();
  return h('div', {}, pageHead('Account', 'Installatori e amministratori. Disabilitazione e reset revocano subito le sessioni.'), securityCard, card(h('h2', {}, 'Nuovo account'), form), card(list), editor);
}
