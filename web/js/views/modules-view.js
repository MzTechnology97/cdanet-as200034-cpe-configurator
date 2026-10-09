import { api } from '../api.js';
import { setModules } from '../modules.js';
import { badge, card, h, pageHead, toast } from '../dom.js';

/** Funzionalità: turn optional modules on/off (hidden in console and app, API refused). */
export async function modulesView({ onChange } = {}) {
  const list = await api('/api/admin/modules');
  const rows = list.map((m) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = m.enabled;
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        const next = await api('/api/admin/modules', { method: 'PUT', body: { [m.key]: cb.checked } });
        setModules(Object.fromEntries(next.map((x) => [x.key, x.enabled])));
        toast(`${m.label}: ${cb.checked ? 'attivata' : 'disattivata'}`);
        onChange?.();
      } catch (e) {
        cb.checked = !cb.checked;
        toast(e.message, 'bad');
      } finally {
        cb.disabled = false;
      }
    };
    return h(
      'label',
      { class: 'module-row' },
      cb,
      h('span', {}, h('b', {}, m.label), ' ', badge(m.area, ''), m.default ? null : h('span', { class: 'small muted' }, ' · spento di default'), h('div', { class: 'small muted' }, m.description)),
    );
  });
  return h(
    'div',
    {},
    pageHead('Funzionalità', 'Moduli facoltativi. Se disattivati spariscono dalla console e dall’app e il server rifiuta le relative richieste.'),
    card(h('div', { class: 'modules' }, ...rows)),
    card(
      h('h2', {}, 'Sempre attivi'),
      h('p', { class: 'small muted' }, 'Provisioning, storico, profili airOS, reti Wi-Fi, account, connettori e registro attività fanno parte del nucleo e non si disattivano.'),
      h('p', { class: 'small muted' }, 'L’app Android aggiorna i moduli all’accesso: le modifiche valgono dal login successivo.'),
    ),
  );
}
