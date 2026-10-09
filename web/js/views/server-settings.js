import { api } from '../api.js';
import { badge, busy, card, fmtDate, h, mount, pageHead, toast } from '../dom.js';

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
      card(
        h('h2', {}, 'Restano nel file .env (per ora)'),
        h(
          'p',
          { class: 'small muted' },
          'Parametri dell’infrastruttura gestiti da altri container: indirizzo e HTTPS (APP_LISTEN, HTTPS_SITES), aggiornamenti automatici (AUTOUPDATE, UPDATE_INTERVAL, UPDATE_WINDOW, CDANET_CHANNEL), regione di mappe e geocoder; e i segreti di base (JWT_SECRET, chiave master), che non vanno mai cambiati dal web.',
        ),
      ),
    );
  }

  try {
    render(await api('/api/admin/server-settings'));
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
