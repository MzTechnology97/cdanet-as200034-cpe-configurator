import { api } from '../api.js';
import { badge, card, fmtDate, h, mount, pageHead, stat, table } from '../dom.js';
import { nms } from '../terms.js';

const STATE = { ok: ['in funzione', 'good'], degraded: ['molte CPE offline', 'warn'], down: ['non raggiungibile', 'bad'] };
const OFFLINE = { none: null, some: 'alcune CPE offline', many: 'molte CPE offline' };

/** "Stato rete": POPs and APs (installers: the assigned ones), refreshed every minute. No notifications. */
export async function networkView({ user }) {
  const admin = user.role === 'admin';
  const out = h('div', {}, h('p', { class: 'muted' }, 'Caricamento…'));
  let timer = null;

  const apLine = (a) =>
    h(
      'div',
      { class: 'net-ap' },
      badge(STATE[a.state][0], STATE[a.state][1]),
      ' ',
      h('b', {}, a.name),
      a.ssid && a.ssid !== a.name ? h('span', { class: 'small muted' }, ` ${a.ssid}`) : null,
      a.cpe ? h('span', { class: 'small' }, ` · CPE ${a.cpe.total - a.cpe.offline}/${a.cpe.total} online`) : OFFLINE[a.cpeOffline] ? h('span', { class: 'small' }, ` · ${OFFLINE[a.cpeOffline]}`) : null,
      a.lastSeen ? h('span', { class: 'small muted' }, ` · ultimo contatto ${fmtDate(a.lastSeen)}`) : null,
      a.powerOutage ? [' ', badge('guasto Enel vicino', 'bad')] : null,
    );

  async function load() {
    let d;
    try {
      d = await api('/api/network/status');
    } catch (e) {
      mount(out, h('div', { class: 'notice bad' }, e.message));
      return;
    }
    if (!document.body.contains(out) && timer) {
      clearInterval(timer);
      return;
    }
    const s = d.summary;
    mount(
      out,
      card(
        h('div', { class: 'grid' }, stat('AP', s.aps), stat('Non raggiungibili', s.down), stat('Con molte CPE offline', s.degraded), stat('Con guasto Enel vicino', s.powerOutage)),
        h('p', { class: 'small muted' }, `Aggiornato ${fmtDate(d.generatedAt)} · si aggiorna ogni minuto${nms(' · dati da UISP', '')}.`),
      ),
      d.restricted && !d.assignedCount
        ? h('div', { class: 'notice warn' }, 'Nessun POP/AP assegnato al tuo account: chiedi all’amministratore.')
        : card(
            h('h2', {}, d.restricted ? 'I tuoi POP e AP' : 'POP e AP'),
            d.pops.length || d.apsWithoutPop.length
              ? table(
                  [
                    { label: 'POP', render: (p) => h('div', {}, h('b', {}, p.name), h('div', {}, badge(STATE[p.state][0], STATE[p.state][1])), p.powerOutage ? badge('guasto Enel vicino', 'bad') : null) },
                    { label: 'AP', render: (p) => (p.aps.length ? h('div', {}, p.aps.map(apLine)) : h('span', { class: 'small muted' }, 'nessun AP')) },
                  ],
                  [...d.pops, ...(d.apsWithoutPop.length ? [{ name: 'AP senza POP', state: 'ok', powerOutage: false, aps: d.apsWithoutPop }] : [])],
                )
              : h('p', { class: 'small muted' }, 'Nessun POP o AP.'),
            h('p', { class: 'small muted' }, '"Molte CPE offline": almeno il 30% delle CPE dell’AP non è raggiungibile (probabile problema di settore, non del singolo cliente).'),
          ),
    );
  }

  await load();
  timer = setInterval(load, 60_000);
  return h('div', {}, pageHead('Stato rete', admin ? 'Stato di POP e AP: raggiungibilità, CPE offline e guasti Enel vicini.' : 'Stato dei POP e degli AP che ti sono assegnati.'), out);
}
