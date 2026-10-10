import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, toast } from '../dom.js';

const ERRORS = {
  crm_incomplete: 'Servono indirizzo, API ID e API key.',
  crm_unreachable: 'ISP Billing non raggiungibile dal server (indirizzo, DNS o firewall).',
  crm_auth_failed: 'API ID o API key non validi.',
  crm_forbidden: 'Accesso negato: la chiave non ha questo permesso, oppure l’IP del server non è tra quelli autorizzati della chiave.',
  crm_error: 'ISP Billing ha risposto con un errore.',
};

/**
 * Connettori → CRM (ISP Billing): API key sealed on the server, test of every module the
 * integration reads (each key has its own permissions).
 */
export function crmCard(c, reload) {
  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = c.configured ? c.enabled : true;
  const url = h('input', { value: c.url, placeholder: 'https://ispbilling.it', inputmode: 'url', autocomplete: 'off' });
  const apiId = h('input', { value: c.apiId, placeholder: 'api_id', autocomplete: 'off' });
  const apiKey = h('input', {
    type: 'password',
    autocomplete: 'off',
    placeholder: c.keySet ? `Impostata (${c.keyHint}): lascia vuoto per non cambiarla` : 'API key',
  });
  const result = h('div', {});
  const body = () => ({ enabled: enabled.checked, url: url.value.trim(), apiId: apiId.value.trim(), ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}) });
  const fail = (e) => new Error(ERRORS[e.body?.error] ?? e.body?.issues?.[0]?.message ?? e.message);

  function showTest(r) {
    if (!r.modules) {
      return mount(result, h('div', { class: 'notice bad' }, ERRORS[r.error] ?? r.error, r.status ? ` (HTTP ${r.status})` : '', r.detail ? h('div', { class: 'small mono' }, r.detail) : null));
    }
    const readable = r.modules.filter((m) => m.ok).length;
    mount(
      result,
      h(
        'div',
        { class: `notice ${r.ok ? (readable === r.modules.length ? 'good' : 'warn') : 'bad'}` },
        r.ok ? `Chiave valida · ${readable} moduli su ${r.modules.length} leggibili · ${r.latencyMs} ms` : ERRORS[r.error] ?? r.error,
      ),
      h(
        'div',
        { class: 'pick' },
        r.modules.map((m) =>
          h(
            'div',
            { class: 'row' },
            h('span', {}, m.ok ? '✅ ' : '⛔ ', m.label),
            h(
              'span',
              { class: 'small muted' },
              m.ok ? (m.count != null ? `${m.count.toLocaleString('it-IT')} record` : 'leggibile') : m.error === 'crm_forbidden' ? 'permesso mancante (o IP non autorizzato)' : `${ERRORS[m.error] ?? m.error}${m.status ? ` · HTTP ${m.status}` : ''}`,
            ),
          ),
        ),
      ),
      readable < r.modules.length
        ? h('p', { class: 'small muted' }, 'Per i moduli bloccati aggiungi il permesso alla chiave in ISP Billing (Dashboard → API) oppure lasciali così se non servono.')
        : null,
    );
  }

  const testBtn = h('button', { type: 'button' }, 'Testa connessione');
  testBtn.onclick = () =>
    busy(testBtn, async () => {
      mount(result, h('p', { class: 'muted' }, 'Test in corso: un controllo per modulo…'));
      try {
        showTest(await api('/api/admin/connectors/crm/test', { method: 'POST', body: body() }));
      } catch (e) {
        throw fail(e);
      }
    });

  const saveBtn = h('button', { type: 'button', class: 'primary' }, 'Salva');
  saveBtn.onclick = () =>
    busy(saveBtn, async () => {
      try {
        const r = await api('/api/admin/connectors/crm', { method: 'PUT', body: body() });
        apiKey.value = '';
        toast(r.enabled ? 'Connettore CRM salvato e attivo' : 'Connettore CRM salvato (disattivato)');
        await reload();
      } catch (e) {
        throw fail(e);
      }
    });

  const resetBtn = h('button', { type: 'button', class: 'danger' }, 'Rimuovi configurazione');
  resetBtn.onclick = () =>
    confirm('Rimuovere il connettore CRM? La chiave salvata viene cancellata dal server.') &&
    busy(resetBtn, async () => {
      await api('/api/admin/connectors/crm', { method: 'DELETE' });
      toast('Connettore CRM rimosso');
      await reload();
    });

  // RADIUS state copied for the NOC (Salute CPE, Stato rete): last sync and sync now
  const radius = h('div', {});
  const syncBtn = h('button', { type: 'button' }, 'Sincronizza stato RADIUS');
  async function showRadius() {
    const r = await api('/api/admin/crm/radius/status');
    if (!r.configured) return mount(radius);
    mount(
      radius,
      h('h3', {}, 'Stato RADIUS per il NOC'),
      h(
        'p',
        { class: 'small muted' },
        r.at
          ? `Aggiornato ${fmtDate(r.at)} in ${Math.round((r.ms ?? 0) / 1000)} s: ${r.accounts.toLocaleString('it-IT')} account, ${r.online} online, ${r.offline} offline, ${r.suspended} sospesi.`
          : 'Non ancora sincronizzato: parte da solo entro un minuto dall’avvio e poi ogni 10 minuti.',
        r.running ? ' Sincronizzazione in corso…' : '',
      ),
      r.error ? h('div', { class: 'notice warn' }, `Ultima sincronizzazione non riuscita: ${ERRORS[r.error] ?? r.error}`) : null,
      h('div', { class: 'btns' }, syncBtn),
    );
    if (r.running) setTimeout(() => void showRadius().catch(() => {}), 4000);
  }
  syncBtn.onclick = () =>
    busy(syncBtn, async () => {
      await api('/api/admin/crm/radius/sync', { method: 'POST' });
      toast('Sincronizzazione avviata: dura circa un minuto');
      await showRadius();
    });
  if (c.configured && c.enabled) void showRadius().catch(() => {});

  return card(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h2', {}, 'CRM · ISP Billing'), h('p', { class: 'small muted' }, 'Clienti, account RADIUS e profili, servizi, attività e magazzino.')),
      h('div', {}, badge(c.configured && c.enabled ? 'attivo' : c.configured ? 'disattivato' : 'non configurato', c.configured && c.enabled ? 'good' : c.configured ? '' : 'warn')),
    ),
    c.updatedAt ? h('p', { class: 'small muted' }, `Ultima modifica ${fmtDate(c.updatedAt)}${c.updatedBy ? ` · ${c.updatedBy}` : ''}`) : null,
    h('label', { class: 'check' }, enabled, 'Connettore attivo'),
    h('div', { class: 'row' }, field('Indirizzo', url), field('API ID', apiId), field('API key', apiKey)),
    h(
      'p',
      { class: 'small muted' },
      'Crea la chiave in ISP Billing (Dashboard → API) con i soli permessi di lettura che servono e, se possibile, limita gli IP all’indirizzo pubblico di questo server. La chiave resta cifrata sul server e non viene mai mostrata; gli installatori non vedono questa fonte.',
    ),
    h('div', { class: 'btns' }, testBtn, saveBtn, c.configured ? resetBtn : null),
    result,
    radius,
  );
}
