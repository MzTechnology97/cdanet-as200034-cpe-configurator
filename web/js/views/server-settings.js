import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, toast } from '../dom.js';

const SOURCE = { web: ['impostato dal web', 'good'], env: ['da .env', ''], default: ['predefinito', ''] };

/**
 * Impostazioni server (admin): the .env parameters editable from the console, so that no SSH
 * access is needed. Secrets are write-only: the console shows only whether they are set.
 */
export async function serverSettingsView() {
  const out = h('div', {});
  const restartBox = h('div', {});

  function restartBanner(keys) {
    if (!keys?.length) return mount(restartBox);
    const b = h('button', { type: 'button', class: 'primary' }, 'Riavvia l’app ora');
    b.onclick = () =>
      busy(b, async () => {
        await api('/api/admin/server-settings/restart', { method: 'POST', body: {} });
        toast('Riavvio in corso: la console torna disponibile tra qualche secondo');
        setTimeout(() => location.reload(), 8000);
      });
    mount(restartBox, h('div', { class: 'notice warn' }, `Valgono dopo un riavvio dell’app: ${keys.join(', ')}. `, b));
  }

  function field(s, inputs) {
    let input;
    if (s.kind === 'bool') {
      input = h('input', { type: 'checkbox' });
      input.checked = !!s.value;
    } else if (s.kind === 'secret') {
      input = h('input', { type: 'password', autocomplete: 'new-password', placeholder: s.isSet ? 'impostata · scrivi per cambiarla' : 'non impostata' });
    } else {
      input = h('input', {
        type: s.kind === 'int' ? 'number' : 'text',
        value: s.value ?? '',
        ...(s.kind === 'int' ? { min: s.min, max: s.max, step: 1 } : {}),
        placeholder: s.envValue != null ? `.env: ${s.envValue}` : '',
      });
    }
    inputs.push({ s, input });
    const reset = h('button', { type: 'button', class: 'small' }, 'Ripristina .env');
    reset.onclick = () =>
      busy(reset, async () => {
        const r = await api('/api/admin/server-settings', { method: 'PUT', body: { values: { [s.key]: null } } });
        toast(`${s.label}: valore del .env ripristinato`);
        render(r);
        restartBanner(r.restartNeeded);
      });
    return h(
      'div',
      { class: 'setting' },
      h('label', { class: s.kind === 'bool' ? 'check' : '' }, s.kind === 'bool' ? input : null, s.label, s.kind === 'bool' ? null : input),
      h(
        'div',
        { class: 'small muted' },
        badge(SOURCE[s.source][0], SOURCE[s.source][1]),
        ` ${s.env}`,
        s.restart ? ' · richiede riavvio' : '',
        s.kind === 'secret' ? ` · ${s.isSet ? 'impostata' : 'non impostata'}` : '',
        s.help ? h('div', {}, s.help) : null,
      ),
      s.source === 'web' ? reset : null,
    );
  }

  function render(data) {
    const groups = [...new Set(data.settings.map((s) => s.group))];
    mount(
      out,
      data.updatedAt ? h('p', { class: 'small muted' }, `Ultima modifica ${fmtDate(data.updatedAt)}${data.updatedBy ? ` da ${data.updatedBy}` : ''}.`) : null,
      ...groups.map((g) => {
        const inputs = [];
        const fields = data.settings.filter((s) => s.group === g).map((s) => field(s, inputs));
        const save = h('button', { type: 'button', class: 'primary' }, 'Salva');
        save.onclick = () =>
          busy(save, async () => {
            const values = {};
            for (const { s, input } of inputs) {
              if (s.kind === 'bool') {
                if (input.checked !== !!s.value) values[s.key] = input.checked;
              } else if (s.kind === 'secret') {
                if (input.value) values[s.key] = input.value;
              } else if (s.kind === 'int') {
                const n = Number(input.value);
                if (input.value !== '' && n !== s.value) values[s.key] = n;
              } else if (input.value.trim() !== String(s.value ?? '')) {
                values[s.key] = input.value.trim();
              }
            }
            if (!Object.keys(values).length) throw new Error('Nessuna modifica');
            const r = await api('/api/admin/server-settings', { method: 'PUT', body: { values } });
            toast(`${g}: impostazioni salvate`);
            render(r);
            restartBanner(r.restartNeeded);
          });
        return card(h('h2', {}, g), ...fields, h('div', { class: 'btns' }, save));
      }),
      pointingBox,
      infraBox,
      card(
        h('h2', {}, 'Restano nel file .env'),
        h(
          'p',
          { class: 'small muted' },
          'Solo i segreti di base (JWT_SECRET, chiave master) e il geocoder OpenStreetMap: non si cambiano dal web per sicurezza.',
        ),
      ),
    );
  }

  const infraBox = h('div', {});
  // antenna heights for the tilt in the app (were in Copertura)
  const pointingBox = pointingSettings();
  try {
    render(await api('/api/admin/server-settings'));
    infraCard(infraBox);
  } catch (e) {
    mount(out, h('div', { class: 'notice bad' }, e.message));
  }
  return h(
    'div',
    {},
    pageHead('Impostazioni server', 'Parametri del server modificabili da qui senza accedere al server: hanno la precedenza sul file .env. Le password non vengono mai mostrate.'),
    restartBox,
    out,
  );
}

const REGIONS = [
  ['sicilia', 'Sicilia'],
  ['isole', 'Sicilia e Sardegna'],
  ['sud', 'Sud'],
  ['centro', 'Centro'],
  ['nord-est', 'Nord-Est'],
  ['nord-ovest', 'Nord-Ovest'],
  ['italia', 'Tutta Italia (file grande)'],
  ['custom', 'Area personalizzata'],
];
const STATUS = { ok: 'good', error: 'bad', running: 'warn' };

/**
 * Infrastructure (address/HTTPS, auto-update, maps): applied by the updater agent of the
 * server, which receives the request, updates .env and restarts what is needed.
 */
async function infraCard(box) {
  let timer;
  async function load() {
    clearTimeout(timer);
    if (!box.isConnected && timer) return; // page left
    let d;
    try {
      d = await api('/api/admin/infra');
    } catch (e) {
      return mount(box, card(h('h2', {}, 'Infrastruttura'), h('div', { class: 'notice bad' }, e.message)));
    }
    draw(d);
    if (d.pending || d.status?.result === 'running') timer = setTimeout(load, 4000);
  }

  function draw(d) {
    const v = d.values;
    const txt = (key, attrs = {}) => h('input', { type: 'text', value: v[key] ?? '', ...attrs });
    const sel = (key, opts) => {
      const s = h('select', {}, opts.map(([val, label]) => h('option', { value: val }, label)));
      s.value = v[key] ?? opts[0][0];
      return s;
    };
    const i = {
      APP_LISTEN: txt('APP_LISTEN', { placeholder: ':80' }),
      HTTPS_SITES: txt('HTTPS_SITES', { placeholder: 'https://185.198.209.31 https://172.31.0.29' }),
      AUTOUPDATE: h('input', { type: 'checkbox' }),
      UPDATE_INTERVAL: h('input', { type: 'number', min: 60, max: 86400, step: 60, value: v.UPDATE_INTERVAL || 300 }),
      UPDATE_WINDOW: txt('UPDATE_WINDOW', { placeholder: 'sempre (es. 02-05 = dalle 2 alle 5)' }),
      CDANET_CHANNEL: txt('CDANET_CHANNEL', { placeholder: 'stable' }),
      MAP_MODE: sel('MAP_MODE', [
        ['local', 'Mappa locale (Protomaps)'],
        ['off', 'Mappe pubbliche OpenStreetMap'],
      ]),
      MAP_REGION: sel('MAP_REGION', REGIONS),
      MAP_BBOX: txt('MAP_BBOX', { placeholder: 'minLon,minLat,maxLon,maxLat' }),
      NOMINATIM_REGION: sel('NOMINATIM_REGION', REGIONS.filter(([r]) => r !== 'custom')),
    };
    const osmLocal = d.geocoderMode === 'local';
    i.AUTOUPDATE.checked = (v.AUTOUPDATE ?? '1') !== '0';
    const bboxRow = h('label', {}, 'Area (minLon,minLat,maxLon,maxLat)', i.MAP_BBOX);
    const syncMap = () => {
      bboxRow.hidden = i.MAP_REGION.value !== 'custom';
      i.MAP_REGION.disabled = i.MAP_MODE.value === 'off';
    };
    i.MAP_REGION.onchange = syncMap;
    i.MAP_MODE.onchange = syncMap;
    syncMap();

    async function send(button, values, action) {
      await busy(button, async () => {
        try {
          const r = await api('/api/admin/infra', { method: 'PUT', body: { values, ...(action ? { action } : {}) } });
          toast('Richiesta inviata al server: viene applicata entro pochi secondi');
          draw(r);
          timer = setTimeout(load, 4000);
        } catch (e) {
          throw e.body?.key ? new Error(`${e.message}: ${e.body.key}`) : e;
        }
      });
    }

    const groups = [
      ['Indirizzo e HTTPS', ['APP_LISTEN', 'HTTPS_SITES']],
      ['Aggiornamenti automatici', ['AUTOUPDATE', 'UPDATE_INTERVAL', 'UPDATE_WINDOW', 'CDANET_CHANNEL']],
      ['Mappe della console', ['MAP_MODE', 'MAP_REGION', 'MAP_BBOX']],
      ['OpenStreetMap locale (ricerca indirizzi)', osmLocal ? ['NOMINATIM_REGION'] : []],
    ];
    const value = (k) => (k === 'AUTOUPDATE' ? (i[k].checked ? '1' : '0') : String(i[k].value).trim().replace(/\s+/g, ' '));
    const save = h('button', { type: 'button', class: 'primary' }, 'Applica');
    save.onclick = () => {
      const values = {};
      for (const [, keys] of groups)
        for (const k of keys) {
          if (k === 'MAP_BBOX' && i.MAP_REGION.value !== 'custom') continue;
          const now = value(k);
          if (now !== (v[k] ?? (k === 'AUTOUPDATE' ? '1' : ''))) values[k] = now;
        }
      // the self-signed certificate is issued for the first address when the browser sends no name
      if (values.HTTPS_SITES) values.HTTPS_DEFAULT_SNI = values.HTTPS_SITES.split(' ')[0].replace(/^https:\/\//, '');
      if (values.APP_LISTEN && !values.APP_LISTEN.startsWith(':') && !confirm(`Con un nome (${values.APP_LISTEN}) la console sulla porta 80 risponde solo a quel nome, con certificato pubblico Let’s Encrypt: il nome deve puntare a questo server e le porte 80/443 devono essere raggiungibili da Internet. Gli indirizzi HTTPS autofirmati restano attivi. Continuare?`)) return;
      if (values.NOMINATIM_REGION && !confirm(`Cambiare la regione di OpenStreetMap in "${values.NOMINATIM_REGION}"? I dati attuali vengono cancellati e reimportati: da 20 minuti a qualche ora (tutta Italia anche di più). Nel frattempo la ricerca indirizzi usa il servizio pubblico.`)) return;
      if (!Object.keys(values).length) return toast('Nessuna modifica', 'bad');
      send(save, values);
    };
    const mapNow = h('button', { type: 'button' }, 'Aggiorna la mappa ora');
    mapNow.disabled = d.values.MAP_MODE === 'off';
    mapNow.onclick = () => send(mapNow, {}, 'map_update');
    const osmReimport = h('button', { type: 'button' }, 'Reimporta OpenStreetMap da zero');
    osmReimport.hidden = !osmLocal;
    osmReimport.onclick = () =>
      confirm('Cancellare i dati OpenStreetMap importati e rifare l’import da zero (da 20 minuti a qualche ora)? Nel frattempo la ricerca indirizzi usa il servizio pubblico.') &&
      send(osmReimport, {}, 'geocoder_reimport');

    const help = {
      APP_LISTEN: ':80 = HTTP sulla rete; un nome (es. cpe.cda-net.it) attiva HTTPS automatico con certificato pubblico.',
      HTTPS_SITES: 'HTTPS con certificato autofirmato su questi indirizzi, separati da spazio.',
      UPDATE_INTERVAL: 'Secondi tra un controllo e l’altro (minimo 60).',
      UPDATE_WINDOW: 'Ore in cui sono ammessi gli aggiornamenti; vuoto = sempre.',
      CDANET_CHANNEL: '“stable” segue le nuove versioni; un numero (es. 1.26.0) blocca quella versione.',
      MAP_REGION: 'Cambiando area la mappa viene riscaricata (qualche minuto).',
      NOMINATIM_REGION: 'Area degli indirizzi cercati sul server. Cambiandola i dati vengono reimportati da zero (RAM e disco: Sicilia ~3 GB / 15 GB, Italia ~8 GB / 90 GB).',
    };
    const labels = {
      APP_LISTEN: 'Indirizzo della console',
      HTTPS_SITES: 'Indirizzi HTTPS autofirmati',
      UPDATE_INTERVAL: 'Intervallo di controllo (s)',
      UPDATE_WINDOW: 'Finestra oraria',
      CDANET_CHANNEL: 'Canale / versione',
      MAP_MODE: 'Tipo di mappa',
      MAP_REGION: 'Regione',
      NOMINATIM_REGION: 'Regione OpenStreetMap',
    };
    const row = (k) =>
      k === 'MAP_BBOX'
        ? bboxRow
        : k === 'AUTOUPDATE'
          ? h('label', { class: 'check' }, i[k], 'Aggiornamenti automatici attivi')
          : h('div', { class: 'setting' }, h('label', {}, labels[k], i[k]), help[k] ? h('div', { class: 'small muted' }, help[k]) : null);

    const st = d.status;
    mount(
      box,
      card(
        h('h2', {}, 'Infrastruttura'),
        h('p', { class: 'small muted' }, 'Applicate dall’agente di aggiornamento del server (riavvia da solo i servizi interessati).'),
        !d.agent
          ? h('div', { class: 'notice warn' }, 'Agente di aggiornamento non ancora attivo su questo server: si attiva con il prossimo aggiornamento automatico, oppure rieseguendo una volta l’installer.')
          : null,
        d.stale ? h('div', { class: 'notice warn' }, 'La richiesta non è stata ancora raccolta: l’agente di aggiornamento potrebbe essere fermo (sudo cdanet-cpe ps).') : null,
        d.pending && !d.stale ? h('div', { class: 'notice' }, 'Richiesta in attesa di essere applicata…') : null,
        st
          ? h('p', { class: 'small' }, badge(st.result === 'running' ? 'in corso' : st.result === 'ok' ? 'applicato' : 'errore', STATUS[st.result] ?? ''), ` ${fmtDate(st.at)} · ${st.message}`)
          : null,
        ...groups.map(([title, keys]) =>
          h(
            'div',
            {},
            h('h3', {}, title),
            ...keys.map(row),
            keys.length ? null : h('p', { class: 'small muted' }, 'Non installato su questo server: la ricerca indirizzi usa il servizio pubblico. Si installa con l’installer (CDANET_GEOCODER=local).'),
          ),
        ),
        h('div', { class: 'btns' }, save, mapNow, osmReimport),
      ),
    );
    // one request at a time: the form is locked until the agent reports the outcome
    if (!d.agent || d.pending || st?.result === 'running') for (const el of [...Object.values(i), save, mapNow, osmReimport]) el.disabled = true;
  }

  await load();
}

/** Admin: antenna heights for the tilt shown in the app ("Trova l'AP"). */
function pointingSettings() {
  const box = h('div', {});
  api('/api/admin/pointing/config')
    .then((c) => {
      const ap = h('input', { type: 'number', min: 0, max: 200, step: 1, value: c.apHeightM });
      const cpe = h('input', { type: 'number', min: 0, max: 100, step: 0.5, value: c.cpeHeightM });
      const save = h('button', { type: 'button', class: 'primary' }, 'Salva');
      save.onclick = () =>
        busy(save, async () => {
          await api('/api/admin/pointing/config', { method: 'PUT', body: { apHeightM: Number(ap.value) || 0, cpeHeightM: Number(cpe.value) || 0 } });
          toast('Altezze salvate');
        });
      const src = c.apSources;
      // which APs really use the antenna height set here: only those without altitude in UISP
      const usage = !src
        ? h('p', { class: 'small muted' }, 'UISP non collegato: non si sa quanti AP usano questo valore.')
        : h(
            'div',
            { class: 'small' },
            h(
              'p',
              {},
              `Su ${src.total} AP: ${src.gps} con l’altitudine GPS in UISP, ${src.siteHeight} con l’altezza del sito in UISP, `,
              h('b', {}, `${src.fallback.length} senza nessuno dei due`),
              src.fallback.length ? ': per questi vale l’altezza impostata qui.' : ': l’altezza impostata qui oggi non viene usata.',
            ),
            src.fallback.length
              ? h('details', {}, h('summary', {}, `Vedi i ${src.fallback.length} AP senza altitudine (completala in UISP per non usare il valore qui)`), h('p', { class: 'muted' }, src.fallback.join(', ')))
              : null,
          );
      mount(
        box,
        card(
          h('h2', {}, 'Puntamento nell’app'),
          h('p', { class: 'small muted' }, 'Per tilt, visibilità e segnale verso un AP servono l’altitudine dell’AP e quella della CPE. Il terreno viene dal modello SRTM (scaricato dal server solo per le zone usate).'),
          h(
            'ul',
            { class: 'small plain' },
            h('li', {}, h('b', {}, 'AP: '), 'si usa prima l’altitudine GPS dell’AP registrata in UISP, poi l’altezza del suo sito in UISP sopra il terreno. Solo se UISP non ha nessuno dei due vale l’altezza antenne qui sotto: non si somma mai ai dati di UISP.'),
            h('li', {}, h('b', {}, 'CPE: '), 'terreno più l’altezza dal suolo. Quella qui sotto è solo il valore di partenza: il tecnico la cambia nell’app per ogni installazione.'),
          ),
          h('div', { class: 'row' }, field('Altezza antenne AP (m dal suolo), solo per AP senza altitudine in UISP', ap), field('Altezza CPE di partenza (m dal suolo)', cpe)),
          usage,
          c.dem ? null : h('div', { class: 'notice warn' }, 'Modello del terreno disattivato (DEM_URL vuoto): il tilt non viene calcolato.'),
          h('div', { class: 'btns' }, save),
        ),
      );
    })
    .catch(() => {});
  return box;
}
