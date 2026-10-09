import { api, session } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, toast } from '../dom.js';
import { myTelegramCard } from './my-telegram.js';

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
    a.totpRequired && !a.totpEnabled
      ? h('div', { class: 'notice bad' }, 'Per gli amministratori la verifica in due passaggi è obbligatoria: attivala qui sotto per usare la console.')
      : null,
    pageHead('Il mio account', `${a.username} · ${a.role === 'admin' ? 'Amministratore' : 'Installatore'}`),
    card(h('div', { class: 'grid' }, stat('Utente', a.username), stat('Ruolo', a.role === 'admin' ? 'Amministratore' : 'Installatore'), stat('Ultimo accesso', fmtDate(a.lastLoginAt)), stat('Creato il', fmtDate(a.createdAt)))),
    card(h('h2', {}, 'Password'), form),
    totpCard(a),
    myTelegramCard(),
    quickLoginCard(),
    card(
      h('h2', {}, 'Sessioni'),
      h('p', { class: 'small muted' }, 'Telefono perso o accesso da un PC condiviso? Chiudi tutte le sessioni: servirà un nuovo accesso ovunque.'),
      h('div', { class: 'btns' }, all),
    ),
  );
}

/** Two-step verification: QR enrolment, recovery codes, disable. */
function totpCard(a) {
  const box = h('div', {});
  const pwd = () => h('input', { type: 'password', autocomplete: 'current-password' });
  const codesBlock = (codes) =>
    h(
      'div',
      { class: 'notice warn' },
      h('b', {}, 'Codici di recupero: salvali ora, non verranno più mostrati.'),
      h('p', { class: 'small' }, 'Ognuno vale una sola volta, al posto del codice dell’app (es. telefono perso o cambiato).'),
      h('pre', { class: 'mono' }, codes.join('\n')),
      h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Codici copiati')) }, 'Copia'),
    );

  if (!a.totpEnabled) {
    const p = pwd();
    const start = h('button', { type: 'button', class: 'primary' }, 'Attiva');
    start.onclick = () =>
      busy(start, async () => {
        const s = await api('/api/auth/totp/setup', { method: 'POST', body: { password: p.value } });
        const qr = window.qrcode ? window.qrcode(0, 'M') : null;
        let svg = null;
        if (qr) {
          qr.addData(s.otpauthUrl);
          qr.make();
          svg = h('div', { class: 'qr' });
          svg.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
        }
        const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456' });
        const ok = h('button', { type: 'button', class: 'primary' }, 'Conferma e attiva');
        ok.onclick = () =>
          busy(ok, async () => {
            const r = await api('/api/auth/totp/enable', { method: 'POST', body: { code: code.value.trim() } });
            toast('Verifica in due passaggi attiva');
            mount(box, h('div', { class: 'notice good' }, 'Attiva: dal prossimo accesso servirà anche il codice dell’app.'), codesBlock(r.recoveryCodes));
          });
        mount(
          box,
          h('ol', { class: 'small' },
            h('li', {}, 'Apri Google Authenticator, Microsoft Authenticator o un’app simile e aggiungi un account con il QR code.'),
            h('li', {}, 'Inserisci il codice di 6 cifre che compare nell’app.')),
          svg,
          h('p', { class: 'small muted' }, 'Non riesci a inquadrarlo? Chiave da inserire a mano: ', h('span', { class: 'mono' }, s.secret.replace(/(.{4})/g, '$1 ').trim())),
          h('div', { class: 'row' }, field('Codice', code), ok),
        );
      });
    mount(box, h('p', { class: 'small muted' }, 'Oltre alla password serve un codice di 6 cifre generato dal telefono: chi ruba la password non entra.'), h('div', { class: 'row' }, field('Password attuale', p), start));
  } else {
    const p = pwd();
    const code = h('input', { inputmode: 'numeric', maxlength: 9, placeholder: '123456' });
    const regen = h('button', { type: 'button' }, 'Nuovi codici di recupero');
    regen.onclick = () =>
      busy(regen, async () => {
        const r = await api('/api/auth/totp/recovery', { method: 'POST', body: { password: p.value } });
        mount(out, codesBlock(r.recoveryCodes));
      });
    const off = h('button', { type: 'button', class: 'danger' }, 'Disattiva');
    off.onclick = () =>
      confirm('Disattivare la verifica in due passaggi?') &&
      busy(off, async () => {
        await api('/api/auth/totp/disable', { method: 'POST', body: { password: p.value, code: code.value.trim() } });
        toast('Verifica in due passaggi disattivata');
        document.getElementById('view').replaceChildren(await accountView());
      });
    const out = h('div', {});
    mount(
      box,
      h('p', {}, badge('attiva', 'good'), ` · codici di recupero rimasti: ${a.recoveryCodesLeft}`),
      a.recoveryCodesLeft <= 2 ? h('div', { class: 'notice warn' }, 'Ti restano pochi codici di recupero: generane di nuovi.') : null,
      h('div', { class: 'row' }, field('Password attuale', p), field('Codice (per disattivare)', code)),
      h('div', { class: 'btns' }, regen, a.totpRequired ? null : off),
      a.totpRequired ? h('p', { class: 'small muted' }, 'Obbligatoria per gli amministratori: non si può disattivare.') : null,
      out,
    );
  }
  return card(h('h2', {}, 'Verifica in due passaggi'), box);
}

/** Phones signed in to the app (persistent login or fingerprint/face): list and revoke. */
function quickLoginCard() {
  const box = h('div', {});
  async function load() {
    const { devices } = await api('/api/auth/devices');
    const rows = devices.map((d) => {
      const off = h('button', { type: 'button', class: 'danger small' }, 'Scollega');
      off.onclick = () =>
        confirm(`Scollegare ${d.name}? Al prossimo avvio l’app chiederà la password.`) &&
        busy(off, async () => {
          await api(`/api/auth/devices/${d.id}`, { method: 'DELETE' });
          toast('Telefono scollegato');
          await load();
        });
      return h(
        'div',
        { class: 'setting' },
        h('b', {}, d.name || 'Telefono'),
        ' ',
        badge(d.active ? 'attivo' : 'scaduto', d.active ? 'good' : ''),
        ' ',
        badge(d.persistent ? 'resta collegato' : 'impronta o volto', ''),
        h('div', { class: 'small muted' }, `Attivato ${fmtDate(d.createdAt)} · ultimo uso ${fmtDate(d.lastUsedAt)}${d.expiresAt ? ` · scade ${fmtDate(d.expiresAt)} se non usato` : ''}`),
        off,
      );
    });
    mount(
      box,
      card(
        h('h2', {}, 'Telefoni collegati'),
        h(
          'p',
          { class: 'small muted' },
          'Dopo il primo accesso l’app resta collegata (la sessione si rinnova a ogni apertura e scade dopo 30 giorni senza uso); in Impostazioni si può chiedere impronta o volto a ogni apertura. La password non resta sul telefono; "Esci da tutti i dispositivi", il cambio password o la disattivazione dell’account scollegano anche i telefoni.',
        ),
        ...(rows.length ? rows : [h('p', { class: 'small' }, 'Nessun telefono collegato.')]),
      ),
    );
  }
  load().catch((e) => mount(box, card(h('h2', {}, 'Telefoni collegati'), h('div', { class: 'notice bad' }, e.message))));
  return box;
}
