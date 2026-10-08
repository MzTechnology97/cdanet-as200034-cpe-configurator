import { api, session } from '../api.js';
import { busy, card, field, fmtDate, h, mount, pageHead, stat, toast } from '../dom.js';

/** Own account: password change and "log out everywhere" (admins and installers). */
export async function accountView() {
  const a = await api('/api/auth/account');

  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 12 });
  const confirm2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 12 });
  const msg = h('div', {});

  const save = h('button', { type: 'submit', class: 'primary' }, 'Cambia password');
  const form = h(
    'form',
    {},
    h('div', { class: 'row' }, field('Password attuale', current)),
    h('div', { class: 'row' }, field('Nuova password (min 12 caratteri)', next), field('Ripeti la nuova password', confirm2)),
    h('p', { class: 'small muted' }, 'Dopo il cambio, le altre sessioni (app e browser) vengono chiuse: andrà rifatto l’accesso con la nuova password.'),
    h('div', { class: 'btns' }, save),
    msg,
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    mount(msg);
    if (next.value.length < 12) return mount(msg, h('div', { class: 'notice bad' }, 'La nuova password deve avere almeno 12 caratteri.'));
    if (next.value !== confirm2.value) return mount(msg, h('div', { class: 'notice bad' }, 'Le due password nuove non coincidono.'));
    return busy(save, async () => {
      const r = await api('/api/auth/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
      session.set({ ...session.get(), token: r.token, expiresAt: r.expiresAt });
      form.reset();
      toast('Password cambiata');
      mount(msg, h('div', { class: 'notice good' }, 'Password cambiata. Le altre sessioni sono state chiuse.'));
    });
  };

  const all = h('button', { type: 'button', class: 'danger' }, 'Esci da tutti i dispositivi');
  all.onclick = () =>
    confirm('Chiudere tutte le sessioni di questo account, compresa questa e quelle dell’app?') &&
    busy(all, async () => {
      await api('/api/auth/logout-all', { method: 'POST', body: {} });
      session.clear();
      window.dispatchEvent(new Event('cda:logout'));
    });

  return h(
    'div',
    {},
    pageHead('Il mio account', `${a.username} · ${a.role === 'admin' ? 'Amministratore' : 'Installatore'}`),
    card(h('div', { class: 'grid' }, stat('Utente', a.username), stat('Ruolo', a.role === 'admin' ? 'Amministratore' : 'Installatore'), stat('Ultimo accesso', fmtDate(a.lastLoginAt)), stat('Creato il', fmtDate(a.createdAt)))),
    card(h('h2', {}, 'Password'), form),
    card(
      h('h2', {}, 'Sessioni'),
      h('p', { class: 'small muted' }, 'Telefono perso o accesso da un PC condiviso? Chiudi tutte le sessioni: servirà un nuovo accesso ovunque.'),
      h('div', { class: 'btns' }, all),
    ),
  );
}
