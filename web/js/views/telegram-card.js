import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, toast } from '../dom.js';

const EVENTS = [
  ['provisioning_failed', 'Provisioning fallito', 'installatore, CPE, fase ed errore: il NOC può aiutare chi è sul tetto'],
  ['uisp_pending', 'CPE da accettare in UISP', 'con il link allo storico per premere "Accetta in UISP"'],
  ['uisp_status', 'UISP giù / di nuovo su', 'solo al cambio di stato, controllo ogni 5 minuti'],
  ['security', 'Sicurezza', 'account bloccato per tentativi, admin da un indirizzo nuovo, password admin cambiate'],
  ['power_outage', 'Guasti Enel', 'guasti e lavori e-distribuzione nelle zone di interesse e vicino agli AP, e i ripristini'],
  ['daily_summary', 'Riepilogo serale', 'installazioni riuscite/fallite, collaudi, CPE ancora da accettare'],
];

/** Connettori → Telegram: bot token, chat, events, test. */
export function telegramCard(t, reload) {
  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = t.configured ? t.enabled : true;
  const token = h('input', { type: 'password', autocomplete: 'off', placeholder: t.tokenSet ? `Impostato (${t.tokenHint}) — lascia vuoto per non cambiarlo` : '123456789:AA…' });
  const chat = h('input', { value: t.chatId, placeholder: '-1001234567890', inputmode: 'numeric' });
  const hour = h('input', { type: 'number', min: 0, max: 23, value: t.summaryHour });
  const boxes = EVENTS.map(([id, label, hint]) => {
    const cb = h('input', { type: 'checkbox', value: id });
    cb.checked = t.events.includes(id);
    return h('label', { class: 'check' }, cb, h('span', {}, h('b', {}, label), h('span', { class: 'small muted' }, ` — ${hint}`)));
  });
  const out = h('div', {});
  const events = () => boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);

  const findBtn = h('button', { type: 'button' }, 'Trova chat ID');
  findBtn.onclick = () =>
    busy(findBtn, async () => {
      const chats = await api('/api/admin/connectors/telegram/chats', { method: 'POST', body: { token: token.value.trim() } });
      if (!chats.length) return mount(out, h('div', { class: 'notice warn' }, 'Nessuna chat: aggiungi il bot al gruppo del NOC, scrivi un messaggio nel gruppo e riprova.'));
      mount(
        out,
        h('p', { class: 'small' }, 'Chat che hanno scritto al bot (clic per usarla):'),
        h('div', { class: 'btns' }, chats.map((c) => h('button', { type: 'button', onclick: () => (chat.value = c.id) }, `${c.title || c.id} (${c.type})`))),
      );
    });

  const testBtn = h('button', { type: 'button' }, 'Invia messaggio di prova');
  testBtn.onclick = () =>
    busy(testBtn, async () => {
      const r = await api('/api/admin/connectors/telegram/test', { method: 'POST', body: { token: token.value.trim(), chatId: chat.value.trim() } });
      mount(out, h('div', { class: 'notice good' }, `Messaggio inviato dal bot @${r.bot ?? '?'}: controlla il gruppo.`));
    });

  const previewBtn = h('button', { type: 'button' }, 'Anteprima riepilogo');
  previewBtn.onclick = () =>
    busy(previewBtn, async () => {
      const r = await api('/api/admin/connectors/telegram/summary');
      mount(out, h('pre', { class: 'small' }, r.text.replace(/<[^>]+>/g, '')));
    });

  const saveBtn = h('button', { type: 'button', class: 'primary' }, 'Salva');
  saveBtn.onclick = () =>
    busy(saveBtn, async () => {
      await api('/api/admin/connectors/telegram', {
        method: 'PUT',
        body: { enabled: enabled.checked, token: token.value.trim(), chatId: chat.value.trim(), events: events(), summaryHour: Number(hour.value) || 19 },
      });
      toast('Notifiche Telegram salvate');
      await reload();
    });

  const resetBtn = h('button', { type: 'button', class: 'danger' }, 'Rimuovi');
  resetBtn.onclick = () =>
    confirm('Rimuovere la configurazione Telegram?') &&
    busy(resetBtn, async () => {
      await api('/api/admin/connectors/telegram', { method: 'DELETE' });
      toast('Configurazione Telegram rimossa');
      await reload();
    });

  return card(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h2', {}, 'Telegram (notifiche NOC)'), h('p', { class: 'small muted' }, 'Solo ciò che richiede un’azione. Nei messaggi: modello, MAC, SSID e installatore; mai nome, indirizzo o posizione del cliente.')),
      h('div', {}, badge(t.configured && t.enabled ? 'attivo' : 'non attivo', t.configured && t.enabled ? 'good' : '')),
    ),
    t.updatedAt ? h('p', { class: 'small muted' }, `Ultima modifica ${fmtDate(t.updatedAt)}${t.updatedBy ? ` · ${t.updatedBy}` : ''}`) : null,
    h(
      'details',
      {},
      h('summary', {}, 'Come si configura'),
      h(
        'ol',
        { class: 'small' },
        h('li', {}, 'Su Telegram apri @BotFather, comando /newbot: ottieni il token del bot.'),
        h('li', {}, 'Aggiungi il bot al gruppo del NOC e scrivi un messaggio qualsiasi nel gruppo.'),
        h('li', {}, 'Incolla il token qui, premi "Trova chat ID" e scegli il gruppo.'),
        h('li', {}, 'Premi "Invia messaggio di prova", scegli gli eventi e salva.'),
      ),
    ),
    h('label', { class: 'check' }, enabled, 'Notifiche attive'),
    h('div', { class: 'row' }, field('Token del bot', token), field('Chat ID del gruppo', chat)),
    h('h3', {}, 'Eventi'),
    ...boxes,
    h('div', { class: 'row' }, field('Ora del riepilogo serale (0-23, ora italiana)', hour)),
    t.publicUrl
      ? h('p', { class: 'small muted' }, `I messaggi includono il link alla console: ${t.publicUrl}`)
      : h('p', { class: 'small muted' }, 'Per avere nei messaggi il link allo storico imposta PUBLIC_URL nel .env (es. https://cpe.cda-net.it).'),
    h('div', { class: 'btns' }, findBtn, testBtn, previewBtn, saveBtn, t.configured || t.tokenSet ? resetBtn : null),
    out,
  );
}
