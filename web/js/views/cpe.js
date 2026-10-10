import { api, download } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, table, toast } from '../dom.js';
import { signalChart } from './uisp-panel.js';

/**
 * Admin "Stato CPE": one customer CPE as in the UISP app, through the UISP API — overview, radio,
 * interfaces, firmware, backups, signal history — and the actions: refresh, restart, firmware
 * upgrade, backup and restore, alias/note/maintenance. Every action asks for confirmation and is in
 * the activity log. Wi-Fi keys never reach the browser.
 */
const STATUS = { active: ['online', 'good'], disconnected: ['offline', 'bad'], inactive: ['inattiva', 'bad'], unauthorized: ['da accettare', 'warn'] };
const dur = (s) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h_ = Math.floor((s % 86400) / 3600);
  return d ? `${d} g ${h_} h` : `${h_} h ${Math.floor((s % 3600) / 60)} min`;
};
const v = (x, unit = '') => (x == null || x === '' ? '—' : `${x}${unit}`);

export async function cpeView({ params }) {
  const id = params.get('id') ?? '';
  const out = h('div', {}, h('p', { class: 'muted' }, 'Caricamento dalla rete…'));
  const back = h('a', { href: '#/health', class: 'button-link' }, '← Salute CPE');
  const title = h('div', {});
  let d = null;

  /** An action on the CPE: confirmation, call, message, reload. */
  async function act(btn, question, path, done, opts = {}) {
    if (question && !confirm(question)) return;
    await busy(btn, async () => {
      const r = await api(`/api/admin/cpe/${encodeURIComponent(id)}${path}`, { method: opts.method ?? 'POST', body: opts.body });
      toast(typeof done === 'function' ? done(r) : done);
      if (opts.reload !== false) setTimeout(load, opts.delay ?? 1500);
    });
  }

  function render() {
    const c = d.cpe;
    const st = STATUS[c.status] ?? [c.status, ''];
    mount(title, pageHead(`CPE · ${c.alias || c.name || c.mac || c.id}`, [c.modelName || c.model, c.mac, c.ip].filter(Boolean).join(' · '), back));

    const refresh = h('button', { type: 'button' }, 'Aggiorna stato');
    refresh.onclick = () => act(refresh, null, '/refresh', 'Stato richiesto a UISP', { delay: 3000 });
    const restart = h('button', { type: 'button', class: 'danger' }, 'Riavvia la CPE');
    restart.onclick = () =>
      act(
        restart,
        c.online ? `Riavviare ${c.name}? Il cliente resta senza Internet per circa un minuto.` : `${c.name} è offline: il riavvio arriva solo se torna raggiungibile. Inviarlo comunque?`,
        '/restart',
        c.online ? 'Riavvio inviato: la CPE torna online in circa un minuto' : 'Comando inviato a UISP (CPE offline)',
        { delay: 5000 },
      );

    // firmware: to the latest version UISP has for this model, only online
    const fw = c.firmware;
    const upgrade = h('button', { type: 'button', class: 'primary', disabled: !c.online || !fw.canUpgrade || !fw.upgradeTo }, fw.upgradeTo ? `Aggiorna a ${fw.upgradeTo}` : 'Nessun aggiornamento');
    upgrade.onclick = () =>
      act(
        upgrade,
        `Aggiornare il firmware di ${c.name} da ${fw.current} a ${fw.upgradeTo}? La CPE si riavvia: il cliente resta senza Internet per qualche minuto. Non spegnerla durante l’aggiornamento.`,
        '/upgrade',
        (r) => `Aggiornamento avviato: ${r.from ?? '?'} → ${r.to ?? 'ultima versione'}`,
        { delay: 8000 },
      );

    const mkBackup = h('button', { type: 'button' }, 'Crea backup ora');
    mkBackup.onclick = () => act(mkBackup, null, '/backups', 'Backup richiesto: compare nell’elenco tra poco', { delay: 6000 });

    // UISP settings of the device
    const alias = h('input', { value: c.alias ?? '', maxlength: 100, placeholder: c.name });
    const note = h('textarea', { rows: 2, maxlength: 1000 }, c.note ?? '');
    const maint = h('input', { type: 'checkbox' });
    maint.checked = c.maintenance;
    const saveMeta = h('button', { type: 'button', class: 'primary' }, 'Salva');
    saveMeta.onclick = () => act(saveMeta, null, '/meta', 'Salvato in UISP', { method: 'PUT', body: { alias: alias.value.trim() || null, note: note.value.trim() || null, maintenance: maint.checked } });

    const r = c.radio;
    const chart = h('div', {});
    const range = h('select', {}, ...[['day', 'Ultime 24 ore'], ['week', 'Ultima settimana'], ['month', 'Ultimo mese']].map(([k, l]) => h('option', { value: k, selected: k === 'week' }, l)));
    const loadChart = () => {
      mount(chart, h('p', { class: 'small muted' }, 'Caricamento…'));
      api(`/api/admin/cpe/${encodeURIComponent(id)}/statistics?range=${range.value}`)
        .then((s) => mount(chart, signalChart(s)))
        .catch((e) => mount(chart, h('p', { class: 'small muted' }, `Storico non disponibile: ${e.message}`)));
    };
    range.onchange = loadChart;
    loadChart();

    mount(
      out,
      c.online
        ? null
        : h('div', { class: 'notice warn' }, `CPE offline${c.lastSeen ? ` dal ${fmtDate(c.lastSeen)}` : ''}: UISP accetta i comandi ma arrivano solo se torna raggiungibile. Aggiornamento firmware e ripristino del backup sono disponibili solo online.`),
      c.maintenance ? h('div', { class: 'notice' }, 'In manutenzione su UISP: gli avvisi di questa CPE sono sospesi.') : null,
      card(
        h('h2', {}, 'Panoramica'),
        h(
          'div',
          { class: 'grid' },
          stat('Stato', badge(st[0], st[1])),
          stat('Ultimo contatto', c.lastSeen ? fmtDate(c.lastSeen) : '—'),
          stat('Acceso da', dur(c.uptimeSec)),
          stat('CPU / RAM', `${v(c.cpu, '%')} / ${v(c.ram, '%')}`),
          stat('Temperatura', v(c.temperature, ' °C')),
          stat('AP', v(c.ap)),
          stat('Site', v(c.site)),
          stat('Firmware', v(fw.current)),
          stat('Seriale', v(c.serial)),
        ),
        h('div', { class: 'btns' }, refresh, restart),
        d.job ? h('p', { class: 'small' }, 'Installata con l’app: ', h('a', { href: `#/jobs?q=${encodeURIComponent(c.mac ?? '')}` }, `storico del ${fmtDate(d.job.createdAt)}`)) : null,
      ),
      card(
        h('h2', {}, 'Radio'),
        h(
          'div',
          { class: 'grid' },
          stat('Modalità', v(r.mode)),
          stat('Frequenza', v(r.frequency, ' MHz')),
          stat('Larghezza canale', r.autoChannelWidth ? 'automatica' : v(r.channelWidth, ' MHz')),
          stat('Segnale', v(r.signal, ' dBm')),
          stat('Segnale lato AP', v(r.remoteSignal, ' dBm')),
          stat('Distanza dall’AP', r.distanceM != null ? (r.distanceM >= 1000 ? `${(r.distanceM / 1000).toFixed(2).replace('.', ',')} km` : `${r.distanceM} m`) : '—'),
          stat('Potenza TX', v(r.txPower, ' dBm')),
          stat('Guadagno antenna', v(r.antennaGain, ' dBi')),
          stat('Capacità ↓ / ↑', r.downlinkMbps != null ? `${r.downlinkMbps} / ${v(r.uplinkMbps)} Mbit/s` : '—'),
          stat('SSID', v(r.ssid)),
          stat('Sicurezza', v(r.security)),
          stat('Distanza ACK', v(r.ackDistanceM, ' m')),
        ),
        c.online ? null : h('p', { class: 'small muted' }, 'Configurazione wireless disponibile solo con la CPE online.'),
      ),
      card(h('h2', {}, 'Storico segnale'), h('div', { class: 'row' }, field('Periodo', range)), chart),
      card(
        h('h2', {}, 'Interfacce'),
        table(
          [
            { label: 'Nome', render: (i) => h('b', {}, i.name) },
            { label: 'Tipo', key: 'type' },
            { label: 'Stato', render: (i) => (i.enabled === false ? badge('disattivata', '') : i.plugged ? badge('collegata', 'good') : badge('scollegata', 'warn')) },
            { label: 'Velocità', render: (i) => v(i.speed) },
            { label: 'Indirizzi', render: (i) => (i.addresses.length ? i.addresses.join(', ') : '—') },
          ],
          c.interfaces,
        ),
      ),
      card(
        h('h2', {}, 'Firmware'),
        h(
          'p',
          {},
          `Installato ${v(fw.current)}`,
          fw.upgradeTo ? ` · disponibile in UISP ${fw.upgradeTo}` : '',
          fw.compatible === false ? ' · ' : '',
          fw.compatible === false ? badge('non compatibile', 'bad') : null,
          fw.upgradeStatus ? ` · ultimo aggiornamento: ${fw.upgradeStatus}${fw.upgradeProgress ? ` (${fw.upgradeProgress}%)` : ''}` : '',
        ),
        h('div', { class: 'btns' }, upgrade),
        h('p', { class: 'small muted' }, 'Porta la CPE all’ultima versione che UISP ha per questo modello. Solo con la CPE online; durante l’aggiornamento la CPE si riavvia.'),
      ),
      card(
        h('h2', {}, 'Backup della configurazione'),
        d.backups.length
          ? table(
              [
                { label: 'Data', render: (b) => fmtDate(b.timestamp) },
                { label: 'Tipo', render: (b) => v(b.type) },
                {
                  label: '',
                  render: (b) => {
                    const get = h('button', { type: 'button', class: 'small-btn' }, 'Scarica');
                    get.onclick = () => busy(get, () => download(`/api/admin/cpe/${encodeURIComponent(id)}/backups/${encodeURIComponent(b.id)}`, `backup-${b.id}.cfg`));
                    const apply = h('button', { type: 'button', class: 'small-btn danger', disabled: !c.online }, 'Ripristina');
                    apply.onclick = () =>
                      act(apply, `Ripristinare su ${c.name} la configurazione del ${fmtDate(b.timestamp)}? La CPE si riavvia con quella configurazione: se è sbagliata il cliente può restare senza Internet.`, `/backups/${encodeURIComponent(b.id)}/apply`, 'Ripristino inviato', { delay: 8000 });
                    return h('div', { class: 'btns ap-actions' }, get, apply);
                  },
                },
              ],
              d.backups,
            )
          : h('p', { class: 'small muted' }, 'Nessun backup in UISP.'),
        h('div', { class: 'btns' }, mkBackup),
      ),
      card(
        h('h2', {}, 'Gestione in UISP'),
        h('div', { class: 'row' }, field('Alias (nome mostrato in UISP)', alias)),
        field('Note', note),
        h('label', { class: 'check' }, maint, 'In manutenzione (sospende gli avvisi di UISP per questa CPE)'),
        h('div', { class: 'btns' }, saveMeta),
      ),
      h('p', { class: 'small muted' }, 'Ogni azione è registrata nel Registro attività. Le chiavi Wi-Fi della CPE restano sul server.'),
    );
  }

  async function load() {
    try {
      d = await api(`/api/admin/cpe/${encodeURIComponent(id)}`);
      render();
    } catch (e) {
      mount(out, h('div', { class: 'notice bad' }, e.message));
    }
  }
  await load();
  return h('div', {}, title, out);
}
