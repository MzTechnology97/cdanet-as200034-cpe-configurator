import { api } from '../api.js';
import { badge, card, h, pageHead, table } from '../dom.js';

/** Installer view: templates this account may use in the app (names only). */
export async function myTemplatesView() {
  const list = await api('/api/provisioning/templates');
  const models = [...new Set(list.map((t) => t.model))];
  return h(
    'div',
    {},
    pageHead('Template disponibili', 'I template airOS che puoi usare nell’app. Quello indicato come predefinito viene proposto automaticamente.'),
    list.length
      ? models.map((m) =>
          card(
            h('h2', {}, m),
            table(
              [
                { label: 'Nome', render: (t) => h('b', {}, t.name) },
                {
                  label: 'Note',
                  render: (t) => h('div', { class: 'btns' }, t.isDefault ? badge('predefinito per te', 'good') : null, t.personal ? badge('riservato', 'warn') : badge('tutti', '')),
                },
              ],
              list.filter((t) => t.model === m),
            ),
          ),
        )
      : card(h('p', { class: 'muted' }, 'Nessun template disponibile per il tuo account: contatta un amministratore.')),
  );
}
