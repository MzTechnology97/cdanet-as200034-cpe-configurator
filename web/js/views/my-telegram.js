import { api } from '../api.js';
import { busy, card, field, h, mount, toast } from '../dom.js';

/**
 * Personal Telegram of the account (every user): the admin's bot writes to the user's own chat.
 * When it is not available, admins are told where to turn it on, installers whom to ask.
 */
export function myTelegramCard({ title = 'Notifiche Telegram', appHint = false } = {}) {
  const box = h('div', {});
  async function load() {
    const t = await api('/api/account/telegram');
    const app = appHint ? h('p', { class: 'small muted' }, 'Sul telefono: app CDA Net → Guasti Enel → "Avvisami dei guasti" (notifiche anche ad app chiusa).') : null;
    const what = t.outages ? 'i guasti Enel nelle tue zone e sui POP/AP assegnati' : 'le notifiche che ti riguardano';
    if (!t.available) {
      const why = {
        no_bot: t.canConfigure
          ? h('span', {}, 'Manca il bot Telegram: crealo con @BotFather e incolla il token in ', h('a', { href: '#/connectors' }, 'Connettori → Telegram'), '. Basta il token: il gruppo del NOC è facoltativo.')
          : 'Le notifiche Telegram personali non sono ancora attive: chiedi all’amministratore di configurare il bot.',
        personal_off: t.canConfigure
          ? h('span', {}, 'Le notifiche personali sono disattivate: riattivale in ', h('a', { href: '#/connectors' }, 'Connettori → Telegram'), '.')
          : 'L’amministratore ha disattivato le notifiche Telegram personali.',
        module_off: t.canConfigure
          ? h('span', {}, 'Il modulo Notifiche Telegram è spento: accendilo in ', h('a', { href: '#/modules' }, 'Funzionalità'), '.')
          : 'Le notifiche Telegram non sono attive su questo server.',
      }[t.reason] ?? 'Le notifiche Telegram personali non sono attive.';
      mount(box, card(h('h2', {}, title), h('p', { class: 'small muted' }, why), app));
      return;
    }
    if (t.linked) {
      const planned = h('input', { type: 'checkbox' });
      planned.checked = t.planned;
      planned.onchange = () => api('/api/account/telegram', { method: 'PUT', body: { planned: planned.checked } }).then(() => toast('Preferenza salvata'), (e) => toast(e.message, 'bad'));
      const off = h('button', { type: 'button', class: 'danger' }, 'Scollega Telegram');
      off.onclick = () =>
        busy(off, async () => {
          await api('/api/account/telegram', { method: 'DELETE' });
          await load();
        });
      mount(box, card(h('h2', {}, title), h('div', { class: 'notice good' }, `Telegram collegato (chat ${t.chatHint}): ricevi qui ${what}.`), t.outages ? h('label', { class: 'check' }, planned, 'Anche i lavori programmati') : null, h('div', { class: 'btns' }, off), app));
      return;
    }
    const linkBtn = h('button', { type: 'button', class: 'primary' }, 'Collega Telegram');
    const steps = h('div', {});
    linkBtn.onclick = () =>
      busy(linkBtn, async () => {
        const l = await api('/api/account/telegram/link', { method: 'POST', body: {} });
        const verify = h('button', { type: 'button', class: 'primary' }, 'Verifica');
        verify.onclick = () =>
          busy(verify, async () => {
            try {
              await api('/api/account/telegram/verify', { method: 'POST', body: {} });
            } catch (e) {
              if (e.body?.error === 'start_not_found') throw new Error('Non trovo ancora il tuo messaggio: apri il bot, premi Avvia e riprova');
              throw e;
            }
            toast('Telegram collegato');
            await load();
          });
        mount(
          steps,
          h('ol', { class: 'small' }, h('li', {}, 'Apri ', h('a', { href: l.url, target: '_blank', rel: 'noopener' }, `@${l.bot}`), ' su Telegram e premi ', h('b', {}, 'Avvia'), '.'), h('li', {}, `Torna qui e premi Verifica (entro ${l.expiresInMin} minuti).`)),
          h('div', { class: 'btns' }, verify),
        );
      });
    const chatId = h('input', { placeholder: 'es. 123456789', inputmode: 'numeric' });
    const saveId = h('button', { type: 'button' }, 'Usa questo ID');
    saveId.onclick = () =>
      busy(saveId, async () => {
        await api('/api/account/telegram', { method: 'PUT', body: { chatId: chatId.value.trim() } });
        toast('Telegram collegato: ti è arrivato un messaggio di prova');
        await load();
      });
    mount(
      box,
      card(
        h('h2', {}, title),
        h('p', { class: 'small muted' }, `Ricevi su Telegram ${what}, con il bot del server.`),
        h('div', { class: 'btns' }, linkBtn),
        steps,
        h('div', { class: 'row' }, field('Oppure il tuo ID Telegram', chatId)),
        h('p', { class: 'small muted' }, 'Prima di usare l’ID scrivi almeno un messaggio al bot, altrimenti Telegram non gli permette di scriverti.'),
        h('div', { class: 'btns' }, saveId),
        app,
      ),
    );
  }
  load().catch((e) => mount(box, card(h('h2', {}, title), h('div', { class: 'notice bad' }, e.message))));
  return box;
}
