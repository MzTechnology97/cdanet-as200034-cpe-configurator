import { api } from '../api.js';
import { busy, card, field, h, mount, pageHead, stat } from '../dom.js';

export async function routerosView() {
  const catalog = await api('/api/routeros/catalog');
  const host = h('input', { placeholder: '10.0.0.1' });
  const port = h('input', { type: 'number', value: '22', min: 1, max: 65535 });
  const user = h('input', { autocomplete: 'username', placeholder: 'admin' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const command = h('input', { placeholder: '/interface print detail without-paging' });
  const summary = h('div', {});
  const out = h('div', {});

  async function run(action, button, cmd) {
    return busy(button, async () => {
      if (!host.value.trim() || !user.value.trim() || !pass.value) throw new Error('Host, username e password richiesti');
      mount(out, h('p', { class: 'muted' }, 'Interrogazione RouterOS in corso…'));
      try {
        const d = await api('/api/routeros/action', {
          method: 'POST',
          body: { host: host.value.trim(), port: Number(port.value) || 22, username: user.value.trim(), password: pass.value, action, command: cmd },
        });
        const s = d.summary;
        mount(
          summary,
          card(
            h('div', { class: 'grid' }, stat('Identity', s.identity), stat('RouterOS', s.version), stat('Board', s.boardName), stat('Uptime', s.uptime), stat('CPU load', s.cpuLoad), stat('RAM libera', s.freeMemory), stat('Firmware', s.currentFirmware)),
          ),
        );
        mount(
          out,
          d.note ? h('div', { class: 'notice warn' }, d.note) : null,
          d.sections.map((x) => card(h('h2', {}, x.title), h('p', { class: 'mono small muted' }, x.command), h('pre', {}, x.output || 'Nessun dato'))),
        );
      } catch (e) {
        mount(out, h('div', { class: 'notice bad' }, e.message));
      }
    });
  }

  const connect = h('button', { class: 'primary' }, 'Connetti / Dashboard');
  connect.onclick = () => run('dashboard', connect);
  const termBtn = h('button', {}, 'Esegui');
  termBtn.onclick = () => run('terminal', termBtn, command.value.trim());
  command.addEventListener('keydown', (e) => e.key === 'Enter' && termBtn.click());
  const supout = h('button', {}, 'Genera supout.rif');
  supout.onclick = () => confirm('Generare cda-supout.rif sul router? Può contenere informazioni sensibili e resta nei Files del router.') && run('supout', supout);
  const forget = h('button', {}, 'Dimentica password');
  forget.onclick = () => {
    pass.value = '';
    mount(summary);
    mount(out);
  };

  return h(
    'div',
    {},
    pageHead('MikroTik · RouterOS', 'Consultazione in sola lettura via SSH dal server. Le password restano solo in memoria per la singola richiesta.'),
    card(h('div', { class: 'row' }, field('Host / IP', host), field('Porta SSH', port), field('Username', user), field('Password', pass)), h('div', { class: 'btns' }, connect, supout, forget)),
    summary,
    card(
      h('h2', {}, 'Sezioni'),
      h(
        'div',
        { class: 'btns' },
        catalog.sections.map((s) => {
          const b = h('button', {}, s.title);
          b.onclick = () => run(s.id, b);
          return b;
        }),
      ),
      h('h3', {}, 'Terminale (sola lettura)'),
      h('div', { class: 'row' }, field('Comando', command), termBtn),
    ),
    out,
  );
}
