import { api } from '../api.js';
import { badge, busy, card, fmtDate, h, mount, toast } from '../dom.js';

const ERRORS = {
  mapbox_incomplete: 'Serve il token di Mapbox.',
  mapbox_unreachable: 'Mapbox non raggiungibile dal server (DNS o firewall).',
  mapbox_token_rejected: 'Token rifiutato da Mapbox: controlla che sia attivo e senza restrizioni di URL.',
  mapbox_error: 'Mapbox ha risposto con un errore.',
  mapbox_not_configured: 'Token non configurato.',
};

/**
 * Connettori → Mapbox: satellite and hybrid imagery on the admins' maps of the console. The token
 * is sealed on the server and the tiles go through it, so installers keep the usual basemap.
 */
export function mapboxCard(c, reload) {
  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = c.configured ? c.enabled : true;
  const token = h('input', {
    type: 'password',
    autocomplete: 'off',
    placeholder: c.tokenSet ? `Impostato (${c.tokenHint}): lascia vuoto per non cambiarlo` : 'pk.…',
  });
  const result = h('div', {});
  const body = () => ({ enabled: enabled.checked, ...(token.value.trim() ? { token: token.value.trim() } : {}) });
  const fail = (e) => new Error(ERRORS[e.body?.error] ?? e.body?.issues?.[0]?.message ?? e.message);

  const testBtn = h('button', { type: 'button' }, 'Prova');
  testBtn.onclick = () =>
    busy(testBtn, async () => {
      try {
        const r = await api('/api/admin/connectors/mapbox/test', { method: 'POST', body: token.value.trim() ? { token: token.value.trim() } : {} });
        mount(result, h('div', { class: `notice ${r.ok ? 'good' : 'bad'}` }, r.ok ? 'Token valido: le immagini satellitari arrivano.' : ERRORS[r.error] ?? r.error));
      } catch (e) {
        throw fail(e);
      }
    });
  const saveBtn = h('button', { type: 'button', class: 'primary' }, 'Salva');
  saveBtn.onclick = () =>
    busy(saveBtn, async () => {
      try {
        const r = await api('/api/admin/connectors/mapbox', { method: 'PUT', body: body() });
        token.value = '';
        toast(r.enabled ? 'Mapbox salvato: satellite attivo sulle mappe degli admin' : 'Mapbox salvato (disattivato)');
        await reload();
      } catch (e) {
        throw fail(e);
      }
    });
  const resetBtn = h('button', { type: 'button', class: 'danger' }, 'Rimuovi configurazione');
  resetBtn.onclick = () =>
    confirm('Rimuovere il connettore Mapbox? Il token salvato viene cancellato dal server.') &&
    busy(resetBtn, async () => {
      await api('/api/admin/connectors/mapbox', { method: 'DELETE' });
      toast('Connettore Mapbox rimosso');
      await reload();
    });

  return card(
    h('h2', {}, 'Mapbox (satellite) ', c.configured ? badge(c.enabled ? 'attivo' : 'disattivato', c.enabled ? 'good' : '') : badge('non configurato')),
    h(
      'p',
      { class: 'small muted' },
      'Foto aeree e vista ibrida (foto con strade e nomi) sulle mappe della console, solo per gli amministratori: le immagini passano dal server, il token non arriva mai ai browser e gli installatori vedono la mappa di sempre. Token da account.mapbox.com → Tokens (il token pubblico predefinito va bene).',
    ),
    h('label', { class: 'check' }, enabled, 'Attivo'),
    h('label', {}, 'Token', token),
    c.updatedAt ? h('p', { class: 'small muted' }, `Ultima modifica ${fmtDate(c.updatedAt)}${c.updatedBy ? ` da ${c.updatedBy}` : ''}`) : null,
    h('div', { class: 'btns' }, testBtn, saveBtn, c.configured ? resetBtn : null),
    result,
  );
}
