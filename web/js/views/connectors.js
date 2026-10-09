import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, toast } from '../dom.js';
import { telegramCard } from './telegram-card.js';

const ERRORS = {
  uisp_unreachable: 'UISP non raggiungibile dal server (indirizzo, DNS, firewall o porta).',
  uisp_auth_failed: 'Token rifiutato da UISP: verifica il token e che abbia permessi di lettura/scrittura.',
  uisp_tls_error: 'Certificato TLS non valido o autofirmato: attiva "Ignora verifica TLS" solo se la rete è fidata.',
  uisp_error: 'UISP ha risposto con un errore.',
  connector_incomplete: 'Servono indirizzo UISP e token.',
};

/** Admin page: external integrations (UISP) configured and tested from the console. */
export async function connectorsView() {
  const data = await api('/api/admin/connectors');
  const u = data.uisp;

  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = u.source === 'none' ? true : u.enabled;
  const url = h('input', { value: u.url, placeholder: 'https://uisp.cda-net.it', inputmode: 'url', autocomplete: 'off' });
  const token = h('input', {
    type: 'password',
    autocomplete: 'off',
    placeholder: u.tokenSet ? `Impostato (${u.tokenHint}) — lascia vuoto per non cambiarlo` : 'Token API di UISP',
  });
  const ignoreTls = h('input', { type: 'checkbox' });
  ignoreTls.checked = u.ignoreTls;
  const autoBackup = h('input', { type: 'checkbox' });
  autoBackup.checked = u.autoBackup;
  const radius = h('input', { type: 'number', min: 1, max: 100, value: u.coverageMaxKm });
  const cache = h('input', { type: 'number', min: 5, max: 3600, value: u.cacheSeconds });
  const tlsWarn = h('div', { class: 'notice warn' }, 'Con la verifica TLS disattivata il server accetta qualsiasi certificato da UISP: usala solo se UISP è raggiungibile su una rete di gestione fidata (es. certificato autofirmato interno).');
  const syncTls = () => (tlsWarn.hidden = !ignoreTls.checked);
  ignoreTls.onchange = syncTls;
  syncTls();
  const result = h('div', {});

  const body = () => ({
    enabled: enabled.checked,
    url: url.value.trim(),
    ...(token.value.trim() ? { token: token.value.trim() } : {}),
    ignoreTls: ignoreTls.checked,
    autoBackup: autoBackup.checked,
    coverageMaxKm: Number(radius.value) || 15,
    cacheSeconds: Number(cache.value) || 60,
  });

  function showTest(r) {
    if (r.ok) {
      mount(
        result,
        h('div', { class: 'notice good' }, `Connessione riuscita${r.version ? ` · UISP ${r.version}` : ''}${r.deployment ? ` (${r.deployment})` : ''} · ${r.latencyMs} ms`),
        h(
          'div',
          { class: 'grid' },
          stat('Dispositivi', r.devices),
          stat('AP (PtMP)', r.aps),
          stat('AP con posizione', r.apsWithLocation),
          r.ptpLinks != null ? stat('Link PtP (esclusi dalla copertura)', r.ptpLinks) : null,
          stat('In attesa di accettazione', r.pending),
          stat('Site', r.sites),
        ),
        r.aps > r.apsWithLocation
          ? h('p', { class: 'small muted' }, `${r.aps - r.apsWithLocation} AP senza coordinate (né sul dispositivo né sul site): non compariranno nella Copertura.`)
          : null,
      );
    } else {
      mount(
        result,
        h(
          'div',
          { class: 'notice bad' },
          ERRORS[r.error] ?? r.error,
          r.status ? ` (HTTP ${r.status})` : '',
          r.detail ? h('div', { class: 'small mono' }, r.detail) : null,
        ),
      );
    }
  }

  const testBtn = h('button', { type: 'button' }, 'Testa connessione');
  testBtn.onclick = () =>
    busy(testBtn, async () => {
      mount(result, h('p', { class: 'muted' }, 'Test in corso…'));
      try {
        showTest(await api('/api/admin/connectors/uisp/test', { method: 'POST', body: body() }));
      } catch (e) {
        mount(result, h('div', { class: 'notice bad' }, ERRORS[e.body?.error] ?? e.message));
      }
    });

  const saveBtn = h('button', { type: 'button', class: 'primary' }, 'Salva');
  saveBtn.onclick = () =>
    busy(saveBtn, async () => {
      try {
        const r = await api('/api/admin/connectors/uisp', { method: 'PUT', body: body() });
        token.value = '';
        toast(r.active ? 'Connettore UISP salvato e attivo' : 'Connettore UISP salvato (disattivato)');
        document.getElementById('view').replaceChildren(await connectorsView());
      } catch (e) {
        throw new Error(ERRORS[e.body?.error] ?? e.message);
      }
    });

  const resetBtn = h('button', { type: 'button', class: 'danger' }, 'Rimuovi configurazione');
  resetBtn.onclick = () =>
    confirm('Rimuovere la configurazione UISP salvata nella console? Verranno usati i valori del file .env, se presenti.') &&
    busy(resetBtn, async () => {
      await api('/api/admin/connectors/uisp', { method: 'DELETE' });
      toast('Configurazione rimossa');
      document.getElementById('view').replaceChildren(await connectorsView());
    });

  const sourceLabel = { console: 'configurato dalla console', env: 'da file .env del server', none: 'non configurato' }[u.source];

  return h(
    'div',
    {},
    pageHead('Connettori', 'Integrazioni con sistemi esterni. Le credenziali restano sul server, cifrate, e non vengono mai mostrate.'),
    card(
      h(
        'div',
        { class: 'page-head' },
        h('div', {}, h('h2', {}, 'UISP'), h('p', { class: 'small muted' }, 'AP vicini e copertura, stato delle CPE, accettazione dallo storico e backup.')),
        h('div', {}, badge(u.active ? 'attivo' : 'non attivo', u.active ? 'good' : ''), ' ', badge(sourceLabel, u.source === 'none' ? 'warn' : '')),
      ),
      u.updatedAt ? h('p', { class: 'small muted' }, `Ultima modifica ${fmtDate(u.updatedAt)}${u.updatedBy ? ` · ${u.updatedBy}` : ''}`) : null,
      u.source === 'env' ? h('p', { class: 'small muted' }, 'Attualmente letto dal .env: salvando qui la configurazione della console prende il sopravvento.') : null,
      h('label', { class: 'check' }, enabled, 'Connettore attivo'),
      h('div', { class: 'row' }, field('Indirizzo UISP', url), field('Token API', token)),
      h(
        'p',
        { class: 'small muted' },
        'Token da UISP → Settings → Users → API tokens (lettura/scrittura). API usate: /nms/api/v2.1 (UISP 1.x–3.x, verificato sulla specifica UISP API 1.5.0).',
      ),
      h('label', { class: 'check' }, ignoreTls, 'Ignora verifica TLS (certificato autofirmato)'),
      tlsWarn,
      h('label', { class: 'check' }, autoBackup, 'Backup automatico della CPE dopo "Accetta in UISP"'),
      h('div', { class: 'row' }, field('Raggio copertura (km)', radius), field('Cache dati UISP (secondi)', cache)),
      h('div', { class: 'btns' }, testBtn, saveBtn, u.source === 'console' ? resetBtn : null),
      result,
    ),
    data.telegram ? telegramCard(data.telegram, async () => document.getElementById('view').replaceChildren(await connectorsView())) : null,
    geocoderCard(data.geocoder),
  );
}

/** OpenStreetMap (Nominatim): local container of the stack, with optional public fallback. */
function geocoderCard(g) {
  const result = h('div', {});
  const line = (title, st, primary) =>
    h(
      'div',
      { class: `notice ${st.ok ? 'good' : 'warn'}` },
      h('strong', {}, title),
      ` · ${st.ok ? 'operativo' : 'non disponibile'} · ${st.latencyMs} ms`,
      st.version ? ` · Nominatim ${st.version}` : '',
      st.dataUpdated ? ` · dati aggiornati al ${fmtDate(st.dataUpdated)}` : '',
      !st.ok ? h('div', { class: 'small' }, primary && st.local ? `${st.message} — se è appena stato installato, l'import dei dati OSM è probabilmente ancora in corso (sudo cdanet-cpe geocoder).` : st.message) : null,
    );
  const testBtn = h('button', { type: 'button' }, 'Verifica servizio');
  testBtn.onclick = () =>
    busy(testBtn, async () => {
      mount(result, h('p', { class: 'muted' }, 'Verifica in corso…'));
      const r = await api('/api/admin/connectors/geocoder/test', { method: 'POST', body: {} });
      mount(result, line(r.primary.local ? 'Nominatim locale' : 'Servizio pubblico', r.primary, true), r.fallback ? line('Riserva', r.fallback, false) : null);
    });
  return card(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h2', {}, 'OpenStreetMap (ricerca indirizzi)'), h('p', { class: 'small muted' }, 'Converte un indirizzo in coordinate per Copertura e provisioning.')),
      h('div', {}, badge(g.local ? 'locale' : 'pubblico', g.local ? 'good' : 'warn')),
    ),
    g.local
      ? h('p', { class: 'small muted' }, 'Nominatim gira nello stesso server (container "nominatim"): gli indirizzi cercati non escono dalla rete.' + (g.fallbackUrl ? ' Se il servizio locale non risponde (es. durante il primo import) si usa la riserva.' : ''))
      : h('p', { class: 'small muted' }, 'Servizio pubblico di OpenStreetMap: riceve solo l’indirizzo cercato, massimo 1 richiesta al secondo. Per averlo in locale: sudo CDANET_GEOCODER=local ./deploy/install-debian.sh'),
    h('div', { class: 'grid' }, stat('Servizio', g.url), stat('Riserva', g.fallbackUrl || '—'), g.local ? null : stat('Contatto', g.contact || '—')),
    h('div', { class: 'btns' }, testBtn),
    result,
  );
}
