import { api } from '../api.js';
import { badge, busy, card, fmtDate, h, mount, pageHead, toast } from '../dom.js';
import { myTelegramCard } from './my-telegram.js';

const ICON = { provisioning_failed: '❌', install_ko: '⛔', review_pending: '📶', install_activated: '✅', network_advice: '🛠️' };

/** Unread count for the bell and the menu (polled while logged in). */
export async function unreadCount() {
  try {
    return (await api('/api/notifications/count')).unread;
  } catch {
    return null;
  }
}

export async function notificationsView({ user }) {
  const listEl = h('div', { class: 'notif-list' });
  const onlyUnread = h('input', { type: 'checkbox' });
  const readAll = h('button', {}, 'Segna tutte come lette');
  const counter = h('span', { class: 'muted small' });
  const prefsEl = h('div', {});

  async function load() {
    const r = await api(`/api/notifications?limit=200${onlyUnread.checked ? '&unread=1' : ''}`);
    counter.textContent = r.unread ? `${r.unread} da leggere` : 'Nessuna da leggere';
    readAll.disabled = !r.unread;
    window.dispatchEvent(new CustomEvent('cda:unread', { detail: r.unread }));
    mount(
      listEl,
      r.items.length
        ? r.items.map((n) => {
            const open = h('a', { href: n.mac ? `#/jobs?q=${encodeURIComponent(n.mac)}` : '#/jobs' }, 'Apri nello storico');
            open.onclick = () => markRead([n.id]);
            const read = h('button', { class: 'chip' }, 'Letta');
            read.onclick = () => busy(read, async () => (await markRead([n.id]), load()));
            return h(
              'div',
              { class: `notif ${n.readAt ? '' : 'unread'}` },
              h('div', { class: 'notif-head' }, h('strong', {}, /^[✅❌]/u.test(n.title) ? n.title : `${ICON[n.kind] ?? '🔔'} ${n.title}`), h('span', { class: 'small muted' }, fmtDate(n.createdAt))),
              h('div', { class: 'small notif-body' }, n.body),
              h('div', { class: 'btns small' }, open, n.readAt ? null : read),
            );
          })
        : h('p', { class: 'muted' }, onlyUnread.checked ? 'Nessuna notifica da leggere.' : 'Nessuna notifica negli ultimi 90 giorni.'),
    );
  }
  const markRead = (ids) => api('/api/notifications/read', { method: 'POST', body: { ids } }).catch(() => null);
  onlyUnread.onchange = () => load();
  readAll.onclick = () =>
    busy(readAll, async () => {
      await api('/api/notifications/read', { method: 'POST', body: { all: true } });
      await load();
    });

  async function loadPrefs() {
    const p = await api('/api/notifications/prefs');
    const boxes = p.kinds.map((k) => {
      const cb = h('input', { type: 'checkbox', value: k.kind });
      cb.checked = k.telegram;
      return { k, cb };
    });
    const save = h('button', { class: 'primary' }, 'Salva');
    save.onclick = () =>
      busy(save, async () => {
        await api('/api/notifications/prefs', { method: 'PUT', body: { telegram: boxes.filter((b) => b.cb.checked).map((b) => b.k.kind) } });
        toast('Preferenze salvate');
      });
    mount(
      prefsEl,
      card(
        h('h2', {}, 'Anche su Telegram'),
        h(
          'p',
          { class: 'small muted' },
          'Tutte le notifiche restano in questa pagina. Scegli quali ricevere anche nella tua chat Telegram personale.' +
            (user.role === 'admin' ? ' Quelle del NOC arrivano già al gruppo Telegram, se configurato in Connettori.' : ''),
        ),
        !p.telegram.available
          ? h('div', { class: 'notice warn' }, user.role === 'admin' ? 'Telegram non configurato: imposta il bot in Connettori → Telegram.' : 'Telegram non disponibile: chiedi all’amministratore.')
          : !p.telegram.linked
            ? h('div', { class: 'notice warn' }, 'Collega prima la tua chat Telegram qui sotto.')
            : null,
        h(
          'div',
          { class: 'pick' },
          boxes.map(({ k, cb }) => h('label', { class: 'check' }, cb, k.label, k.noc ? badge('NOC', '') : null)),
        ),
        h('div', { class: 'btns' }, save),
      ),
      p.telegram.available && !p.telegram.linked ? myTelegramCard({ title: 'Collega Telegram' }) : null,
    );
  }

  await Promise.all([load(), loadPrefs()]);
  return h(
    'div',
    {},
    pageHead(
      'Notifiche',
      user.role === 'admin'
        ? 'Reparto NOC: provisioning falliti, installazioni KO o rimandate, collaudi con segnale pessimo da approvare. In più l’esito delle tue installazioni.'
        : 'L’esito delle tue installazioni: approvazioni del NOC e attivazioni.',
    ),
    card(h('div', { class: 'row' }, h('label', { class: 'check small' }, onlyUnread, 'Solo da leggere'), h('div', { class: 'btns' }, counter, readAll)), listEl),
    prefsEl,
  );
}
