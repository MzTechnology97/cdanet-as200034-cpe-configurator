import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, toast } from '../dom.js';

const ERRORS = {
  imagery_incomplete: 'Manca la chiave (o l’indirizzo del servizio).',
  imagery_unreachable: 'Servizio non raggiungibile dal server (DNS o firewall).',
  imagery_key_rejected: 'Chiave rifiutata: controlla che sia attiva, con il servizio abilitato e senza restrizioni di indirizzo.',
  imagery_error: 'Il servizio ha risposto con un errore.',
  imagery_empty: 'Nessuna immagine in quel punto (Sicilia centrale): controlla i layer.',
  imagery_not_configured: 'Non configurato.',
};

/** Providers with a key: name, where to get the key, what to enable. */
const KEYED = [
  ['mapbox', 'Mapbox', 'Token da account.mapbox.com → Tokens (il token pubblico predefinito va bene). Piano gratuito con un limite mensile di immagini.', 'pk.…'],
  ['esri', 'Esri (ArcGIS)', 'Chiave API da location.arcgis.com (ArcGIS Location Platform) → Developer credentials, con il privilegio “Basemaps”. Piano gratuito con un limite mensile.', 'AAPK… / AAPT…'],
  ['google', 'Google', 'Chiave API da Google Cloud con la “Map Tiles API” attiva e un account di fatturazione. Le condizioni di Google chiedono di mostrare il logo e l’attribuzione.', 'AIza…'],
];

/**
 * Connettori → Immagini satellitari: one or more providers of aerial imagery for the admins' maps.
 * Each one switched on appears in the layer switch of the maps, to compare them on the same place;
 * keys are sealed on the server and the tiles go through it.
 */
export function imageryCard(v, reload) {
  const fail = (e) => new Error(ERRORS[e.body?.error] ?? e.body?.issues?.[0]?.message ?? e.message);
  const section = (id, title, help, inputs, body, configured, on) => {
    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = configured ? on : true;
    const result = h('div', {});
    const test = h('button', { type: 'button' }, 'Prova');
    test.onclick = () =>
      busy(test, async () => {
        try {
          const r = await api(`/api/admin/connectors/imagery/${id}/test`, { method: 'POST', body: body() });
          mount(result, h('div', { class: `notice ${r.ok ? 'good' : 'bad'}` }, r.ok ? 'Immagini disponibili.' : ERRORS[r.error] ?? r.error));
        } catch (e) {
          throw fail(e);
        }
      });
    const save = h('button', { type: 'button', class: 'primary' }, 'Salva');
    save.onclick = () =>
      busy(save, async () => {
        try {
          await api(`/api/admin/connectors/imagery/${id}`, { method: 'PUT', body: { enabled: enabled.checked, ...body() } });
          toast(enabled.checked ? `${title}: attivo sulle mappe degli admin` : `${title}: salvato, disattivato`);
          await reload();
        } catch (e) {
          throw fail(e);
        }
      });
    const remove = h('button', { type: 'button', class: 'danger' }, 'Rimuovi');
    remove.onclick = () =>
      confirm(`Rimuovere ${title}? La chiave salvata viene cancellata dal server.`) &&
      busy(remove, async () => {
        await api(`/api/admin/connectors/imagery/${id}`, { method: 'DELETE' });
        toast(`${title} rimosso`);
        await reload();
      });
    return h(
      'div',
      { class: 'advice' },
      h('h3', {}, title, ' ', configured ? badge(on ? 'attivo' : 'disattivato', on ? 'good' : '') : badge('non configurato')),
      h('p', { class: 'small muted' }, help),
      h('label', { class: 'check' }, enabled, 'Attivo'),
      ...inputs,
      h('div', { class: 'btns' }, test, save, configured ? remove : null),
      result,
    );
  };

  const keyed = KEYED.map(([id, title, help, ph]) => {
    const p = v[id];
    const key = h('input', { type: 'password', autocomplete: 'off', placeholder: p.configured ? `Impostata (${p.keyHint}): lascia vuoto per non cambiarla` : ph });
    return section(id, title, help, [h('label', {}, 'Chiave', key)], () => (key.value.trim() ? { key: key.value.trim() } : {}), p.configured, p.enabled);
  });

  const w = v.wms;
  const url = h('input', { value: w.url, inputmode: 'url', autocomplete: 'off' });
  const layers = h('input', { value: w.layers, autocomplete: 'off' });
  const label = h('input', { value: w.label, maxlength: 60 });
  const attribution = h('input', { value: w.attribution, maxlength: 200 });
  const wms = section(
    'wms',
    'Ortofoto pubbliche (WMS)',
    'Servizio WMS senza chiave, in EPSG:3857: predefinite le ortofoto AGEA 2012 del Geoportale Nazionale. Si può mettere un altro WMS (per esempio le ortofoto regionali). Si vedono da zoom 9 in su.',
    [field('Indirizzo WMS', url), h('div', { class: 'row' }, field('Layer', layers), field('Nome sulla mappa', label)), field('Attribuzione', attribution)],
    () => ({ url: url.value.trim(), layers: layers.value.trim(), label: label.value.trim(), attribution: attribution.value.trim() }),
    w.configured,
    w.enabled,
  );

  return card(
    h('h2', {}, 'Immagini satellitari'),
    h(
      'p',
      { class: 'small muted' },
      'Foto aeree sulle mappe della console, solo per gli amministratori. Ogni fonte attiva compare nel selettore in alto a destra delle mappe (Satellite e Ibrida per fonte): attivane più di una per confrontarle sullo stesso punto, poi lascia accesa quella che preferisci. Le immagini passano dal server, le chiavi non arrivano mai ai browser e gli installatori vedono la mappa di sempre.',
    ),
    v.updatedAt ? h('p', { class: 'small muted' }, `Ultima modifica ${fmtDate(v.updatedAt)}${v.updatedBy ? ` da ${v.updatedBy}` : ''}`) : null,
    ...keyed,
    wms,
  );
}
