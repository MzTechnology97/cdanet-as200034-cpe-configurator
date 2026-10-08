import { busy, card, field, h } from '../dom.js';

export function loginView(onLogin) {
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
            await onLogin(user.value.trim(), pass.value);
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
  return h(
    'div',
    { class: 'login' },
    h('img', { class: 'login-logo', src: 'assets/cda-net-logo.svg', alt: 'CDA Net' }),
    card(
      h('h1', {}, 'Accesso'),
      h('p', { class: 'muted' }, 'Console Admin/NOC CDA Net. Il provisioning delle CPE si esegue dall’app Android.'),
      form,
    ),
  );
}
