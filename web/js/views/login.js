import { busy, card, field, h, mount } from '../dom.js';

export function loginView(onLogin, onTotp) {
  const user = h('input', { autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Accedi');
  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        busy(submit, async () => {
          try {
            const r = await onLogin(user.value.trim(), pass.value);
            if (r?.mfaToken) mount(box, codeStep(r.mfaToken));
          } finally {
            pass.value = '';
          }
        });
      },
    },
    field('Username', user),
    field('Password', pass),
    submit,
  );
  /** Second step: 6-digit code from the authenticator app, or a recovery code. */
  function codeStep(mfaToken) {
    const code = h('input', { autocomplete: 'one-time-code', inputmode: 'numeric', required: true, maxlength: 9, placeholder: '123456' });
    const ok = h('button', { class: 'primary', type: 'submit' }, 'Verifica');
    const f = h(
      'form',
      { onsubmit: (e) => (e.preventDefault(), busy(ok, () => onTotp(mfaToken, code.value.trim()))) },
      field('Codice dell’app di autenticazione', code),
      h('p', { class: 'small muted' }, 'Hai perso il telefono? Inserisci uno dei codici di recupero (es. 7KQ2-M9XD).'),
      ok,
    );
    setTimeout(() => code.focus(), 0);
    return [h('h1', {}, 'Verifica in due passaggi'), f, h('button', { type: 'button', class: 'link', onclick: () => mount(box, h('h1', {}, 'Accesso'), intro, form) }, 'Torna indietro')];
  }

  const intro = h('p', { class: 'muted' }, 'Console Admin/NOC CDA Net. Il provisioning delle CPE si esegue dall’app Android.');
  const box = card(h('h1', {}, 'Accesso'), intro, form);
  return h('div', { class: 'login' }, h('img', { class: 'login-logo', src: 'assets/cda-net-logo.svg', alt: 'CDA Net' }), box);
}
