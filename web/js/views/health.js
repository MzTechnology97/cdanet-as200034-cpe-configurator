import { api, download } from '../api.js';
import { isOn } from '../modules.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, table, toast } from '../dom.js';
import { nms } from '../terms.js';

const ISSUES = {
  offline: ['offline', 'bad'],
  not_in_uisp: ['non trovata in rete', 'bad'],
  weak_signal: ['segnale debole', 'bad'],
  signal_drop: ['segnale calato', 'warn'],
  ethernet: ['porta LAN', 'warn'],
  pending: ['da accettare', 'warn'],
  low_capacity: ['capacità bassa', 'warn'],
  firmware: ['firmware da aggiornare', ''],
};
/** Firmware against the reference version (newer is fine; the M series cannot run airOS 8). */
const FW_STATE = { ok: ['aggiornato', 'good'], old: ['da aggiornare', 'warn'], legacy: ['serie M, non aggiornabile', ''], unknown: ['versione non letta', ''] };
/** Customer state from the RADIUS account and the CRM (admins with ISP Billing). */
const ACCOUNT_STATE = {
  online: ['attivo, PPPoE online', 'good'],
  offline: ['attivo, PPPoE offline', 'bad'],
  services_suspended: ['servizi sospesi', 'warn'],
  suspended: ['sospeso', 'warn'],
  terminating: ['in cessazione', 'warn'],
  terminated: ['cessato', 'bad'],
  unknown: ['stato non letto', ''],
};
/** Plan of a PPPoE account: "30M/3M" from the speeds, else the profile name. */
const planOf = (r) => (r?.speed ? `${r.speed.down}M/${r.speed.up}M` : r?.profile || null);
/** Admins with the CRM connected: from the RADIUS state. */
const RADIUS_ISSUES = {
  pppoe_offline: ['PPPoE offline', 'bad'],
  account_suspended: ['account sospeso', 'warn'],
  account_terminated: ['cliente cessato', 'warn'],
};
const ALL_ISSUES = { ...ISSUES, ...RADIUS_ISSUES };

/** PPPoE session of a CPE: online, offline or suspended, with user, plan and customer. */
function pppoeCell(r) {
  if (!r) return h('span', { class: 'small muted' }, '—');
  const state =
    r.state === 'terminated' ? badge('cessato', '') : r.state === 'terminating' ? badge('in cessazione', 'warn') : r.suspended ? badge('sospeso', 'warn') : r.online === true ? badge('online', 'good') : r.online === false ? badge('offline', 'bad') : badge('?', '');
  return h(
    'div',
    {},
    state,
    h('div', { class: 'small mono' }, r.username),
    h('div', { class: 'small muted' }, [r.customerName, r.speed ? `${r.speed.down}/${r.speed.up} Mbit/s` : r.profile, r.clientIp].filter(Boolean).join(' · ')),
  );
}

/** Sessions of the NOC: offline, suspended or with no CPE found, from /api/admin/crm/radius. */
function radiusPanel() {
  const out = h('div', {});
  const which = h(
    'select',
    {},
    h('option', { value: 'offline' }, 'PPPoE offline (account attivo)'),
    h('option', { value: 'suspended' }, 'Sospesi (account, cliente o servizio)'),
    h('option', { value: 'unmatched' }, 'Senza CPE in rete (router o ONT del cliente)'),
    h('option', { value: 'terminated' }, 'Cessati con la CPE ancora in rete'),
    h('option', { value: 'all' }, 'Tutti gli account'),
  );
  const q = h('input', { placeholder: 'Utente, cliente, IP, AP…' });
  let timer = null;
  async function load() {
    const r = await api(`/api/admin/crm/radius?filter=${which.value}&q=${encodeURIComponent(q.value.trim())}&limit=300`);
    mount(
      out,
      h('p', { class: 'small muted' }, `${r.total} account · RADIUS aggiornato ${r.at ? fmtDate(r.at) : 'mai'}${r.running ? ' · sincronizzazione in corso…' : ''}${r.error ? ` · ultimo errore: ${r.error}` : ''}`),
      r.rows.length
        ? table(
            [
              { label: 'Sessione', render: (x) => pppoeCell(x) },
              { label: 'Account', render: (x) => h('div', {}, x.accountStatus, x.customerStatus && x.customerStatus !== 'active' ? h('div', { class: 'small muted' }, `cliente ${x.customerStatus}`) : null, x.servicesSuspended ? h('div', { class: 'small' }, 'servizio sospeso') : null) },
              { label: 'CPE in rete', render: (x) => (x.cpe ? h('div', {}, x.cpe.name, h('div', { class: 'small muted' }, [x.cpe.apName, x.cpe.status].filter(Boolean).join(' · '))) : h('span', { class: 'small muted' }, 'non trovata')) },
              { label: 'MAC', render: (x) => h('span', { class: 'small mono' }, x.mac ?? '—') },
            ],
            r.rows,
          )
        : h('div', { class: 'notice good' }, 'Nessun account per questo filtro.'),
      r.total > r.rows.length ? h('p', { class: 'small muted' }, `Mostrati i primi ${r.rows.length}: usa la ricerca.`) : null,
    );
  }
  which.onchange = () => void load();
  q.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 300);
  };
  void load().catch((e) => mount(out, h('div', { class: 'notice bad' }, e.message)));
  return card(
    h('h2', {}, 'Account PPPoE'),
    h('p', { class: 'small muted' }, 'Lo stato delle sessioni RADIUS, anche dei clienti senza CPE in rete. Aggiornato ogni 10 minuti (Connettori → CRM per sincronizzare subito).'),
    h('div', { class: 'row' }, field('Mostra', which), field('Cerca', q)),
    out,
  );
}

/**
 * Salute CPE. Admins: every customer CPE in UISP (installed with the app or not), with the
 * assignment of CPEs to installers. Installers: the CPEs they installed with the app plus those
 * assigned to them. Current state vs the acceptance test; no PPPoE data, no configuration.
 */
export async function healthView({ user }) {
  const admin = user.role === 'admin';
  const out = h('div', {});
  const filter = h(
    'select',
    {},
    h('option', { value: 'issues' }, 'Solo con problemi'),
    h('option', { value: 'all' }, 'Tutte'),
    ...Object.entries(admin ? ALL_ISSUES : ISSUES).map(([k, [label]]) => h('option', { value: k }, `Solo: ${label}`)),
  );
  const origin = h(
    'select',
    {},
    h('option', { value: '' }, 'Tutte le CPE'),
    h('option', { value: 'app' }, 'Installate con l’app'),
    h('option', { value: 'uisp' }, nms('Solo in UISP (installate prima o senza app)', 'Assegnate a me')),
    ...(admin ? [h('option', { value: 'assigned' }, 'Assegnate a un installatore'), h('option', { value: 'unassigned' }, 'Non assegnate')] : []),
  );
  const q = h('input', { placeholder: 'Cliente, MAC, AP, installatore…' });
  // firmware (state or exact version), customer state and plan from ISP Billing: filled after loading
  const fw = h('select', {});
  const account = h('select', {});
  const plan = h('select', {});
  const fill = (sel, options) => {
    const keep = sel.value;
    mount(sel, ...options.map(([v, label]) => h('option', { value: v }, label)));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  };
  const selected = new Set();
  let data = null;
  /** The PPPoE account panel, built once (it keeps its own filter). */
  let radius = null;

  const visible = () => {
    const term = q.value.trim().toLowerCase();
    return data.cpes
      .filter((c) => (filter.value === 'all' ? true : filter.value === 'issues' ? c.issues.length > 0 : c.issues.includes(filter.value)))
      .filter((c) => (origin.value === 'app' ? c.source === 'app' : origin.value === 'uisp' ? c.source === 'uisp' : origin.value === 'assigned' ? !!c.assignedTo : origin.value === 'unassigned' ? !c.assignedTo : true))
      .filter((c) => !fw.value || (fw.value.startsWith('v:') ? c.firmware?.version === fw.value.slice(2) : c.firmware?.state === fw.value))
      .filter((c) => !account.value || (account.value === 'none' ? 'radius' in c && !c.radius : c.radius?.state === account.value))
      .filter((c) => !plan.value || planOf(c.radius) === plan.value)
      .filter((c) => !term || [c.deviceName, c.mac, c.now?.apName, c.installer, c.ssid, c.assignedTo?.username, c.radius?.username, c.radius?.customerName, planOf(c.radius)].some((x) => (x ?? '').toLowerCase().includes(term)));
  };

  /** Admin: assign the selected CPEs to an installer (or remove the assignment). */
  function assignBar(rows) {
    const who = h('select', {}, h('option', { value: '' }, '— scegli installatore —'), ...(data.installers ?? []).map((u) => h('option', { value: u.id }, u.username)));
    const count = h('span', { class: 'small' }, `${selected.size} selezionate`);
    const selAll = h('button', { type: 'button' }, `Seleziona tutte le filtrate (${rows.length})`);
    selAll.onclick = () => {
      for (const c of rows) selected.add(c.mac);
      render();
    };
    const none = h('button', { type: 'button' }, 'Deseleziona');
    none.onclick = () => {
      selected.clear();
      render();
    };
    const send = async (userId) => {
      if (!selected.size) throw new Error('Seleziona almeno una CPE');
      await api('/api/admin/cpe-assignments', { method: 'PUT', body: { macs: [...selected], userId } });
      toast(userId ? `${selected.size} CPE assegnate` : `Assegnazione rimossa da ${selected.size} CPE`);
      selected.clear();
      await load();
    };
    const go = h('button', { type: 'button', class: 'primary' }, 'Assegna');
    go.onclick = () =>
      busy(go, () => {
        if (!who.value) throw new Error('Scegli l’installatore');
        return send(Number(who.value));
      });
    const remove = h('button', { type: 'button' }, 'Rimuovi assegnazione');
    remove.onclick = () => busy(remove, () => send(null));
    return card(
      h('h2', {}, 'Assegna CPE agli installatori'),
      h('p', { class: 'small muted' }, 'Le CPE assegnate compaiono in "Le mie CPE" dell’installatore (sito e app), come quelle che ha installato con l’app. Suggerimento: filtra per AP o cliente e usa "Seleziona tutte le filtrate".'),
      h('div', { class: 'btns' }, selAll, none, count),
      h('div', { class: 'row' }, field('Installatore', who)),
      h('div', { class: 'btns' }, go, remove),
    );
  }

  /** Options of the firmware, customer-state and plan filters, from the data just loaded. */
  function fillFilters() {
    const versions = data.firmwareVersions ?? [];
    fill(fw, [
      ['', 'Tutti i firmware'],
      ...Object.entries(FW_STATE).map(([k, [label]]) => [k, `Firmware ${label}`]),
      ...versions.map((v) => [`v:${v.version}`, `Versione ${v.version} (${v.count})`]),
    ]);
    if (!data.cpes.some((c) => 'radius' in c)) return;
    const count = (pred) => data.cpes.filter(pred).length;
    fill(account, [
      ['', 'Tutti gli stati'],
      ...Object.entries(ACCOUNT_STATE).map(([k, [label]]) => [k, `${label} (${count((c) => c.radius?.state === k)})`]),
      ['none', `senza account PPPoE (${count((c) => 'radius' in c && !c.radius)})`],
    ]);
    const plans = new Map();
    for (const c of data.cpes) {
      const p = planOf(c.radius);
      if (p) plans.set(p, (plans.get(p) ?? 0) + 1);
    }
    fill(plan, [['', 'Tutti i profili'], ...[...plans.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => [p, `${p} (${n})`])]);
  }

  /** CPEs per firmware version: a click filters the list on that version. */
  function firmwareSummary() {
    const versions = data.firmwareVersions ?? [];
    if (!versions.length) return null;
    return card(
      h('h2', {}, 'Firmware delle CPE'),
      h(
        'div',
        { class: 'fw-chips' },
        versions.map((v) =>
          h(
            'button',
            {
              type: 'button',
              class: `fw-chip${fw.value === `v:${v.version}` ? ' on' : ''}`,
              title: FW_STATE[v.state]?.[0] ?? '',
              onclick: () => ((fw.value = fw.value === `v:${v.version}` ? '' : `v:${v.version}`), render()),
            },
            badge(v.version, FW_STATE[v.state]?.[1] ?? ''),
            h('span', { class: 'count' }, String(v.count)),
          ),
        ),
      ),
      h(
        'p',
        { class: 'small muted' },
        `Riferimento ${data.targetFirmware}: uguale o più recente è a posto, più vecchio è "da aggiornare". La serie M (airOS 6) non può passare all’8.x: è solo un’informazione, non un problema. Clic su una versione per vedere quelle CPE.`,
      ),
    );
  }

  function render() {
    const t = data.totals;
    const rows = visible();
    const withRadius = admin && data.cpes.some((c) => 'radius' in c);
    const check = (c) => {
      const i = h('input', { type: 'checkbox' });
      i.checked = selected.has(c.mac);
      i.onchange = () => {
        if (i.checked) selected.add(c.mac);
        else selected.delete(c.mac);
        render();
      };
      return i;
    };
    mount(
      out,
      card(
        h(
          'div',
          { class: 'grid' },
          stat(admin ? 'CPE clienti' : 'Le mie CPE', t.cpes),
          admin ? stat('Installate con l’app', t.fromApp) : null,
          admin ? stat(nms('Solo in UISP', 'Assegnate'), t.fromUisp) : t.fromUisp ? stat('Assegnate a me', t.fromUisp) : null,
          stat('Senza problemi', `${t.ok} (${t.cpes ? Math.round((t.ok / t.cpes) * 100) : 0}%)`),
          stat('Offline', t.offline),
          stat('Segnale debole', t.weak_signal),
          stat('Segnale calato dal collaudo', t.signal_drop),
          stat('Porta LAN lenta / half', t.ethernet),
          stat(nms('Non trovate in UISP', 'Non trovate in rete'), t.not_in_uisp),
          // admins with the CRM: RADIUS sessions
          'pppoe_offline' in t ? stat('PPPoE offline con CPE online', t.pppoe_offline) : null,
          'account_suspended' in t ? stat('Account sospesi', t.account_suspended) : null,
          'account_terminated' in t ? stat('CPE di clienti cessati', t.account_terminated) : null,
        ),
        h('p', { class: 'small muted' }, `${nms('Stato UISP', 'Stato')} del ${fmtDate(data.generatedAt)}. "Segnale calato": almeno ${data.thresholds.signalDropDb} dB in meno rispetto al collaudo (solo CPE installate con l’app).`),
        admin && data.stale?.count
          ? h(
              'p',
              { class: 'small' },
              showStale
                ? `Mostrate anche ${data.stale.count} CPE offline da più di ${data.stale.months} mesi. `
                : `${data.stale.count} CPE offline da più di ${data.stale.months} mesi non sono mostrate (probabilmente clienti dismessi ancora presenti in UISP). `,
              h('button', { type: 'button', class: 'small-btn', onclick: (e) => busy(e.currentTarget, async () => ((showStale = !showStale), await load())) }, showStale ? 'Nascondile' : 'Mostrale'),
              admin ? h('span', { class: 'muted' }, ' · il limite si cambia in Impostazioni server') : null,
            )
          : null,
        data.uisp ? null : h('div', { class: 'notice warn' }, nms('UISP non raggiungibile: stato attuale non disponibile.', 'Stato attuale non disponibile, riprova più tardi.')),
      ),
      firmwareSummary(),
      admin ? assignBar(rows) : null,
      card(
        h('h2', {}, `CPE (${rows.length})`),
        rows.length
          ? table(
              [
                ...(admin ? [{ label: '', render: check }] : []),
                { label: 'Cliente', render: (c) => h('div', {}, c.deviceName || '—', h('div', { class: 'small muted mono' }, c.mac)) },
                { label: 'Problemi', render: (c) => (c.issues.length ? h('div', { class: 'btns' }, c.issues.map((i) => badge(ALL_ISSUES[i]?.[0] ?? i, ALL_ISSUES[i]?.[1] ?? ''))) : badge('ok', 'good')) },
                ...(withRadius
                  ? [
                      { label: 'PPPoE', render: (c) => pppoeCell(c.radius) },
                      { label: 'Profilo', render: (c) => (planOf(c.radius) ? h('span', { class: 'plan' }, planOf(c.radius)) : h('span', { class: 'small muted' }, '—')) },
                    ]
                  : []),
                { label: 'Segnale collaudo → ora', render: (c) => `${c.acceptanceSignal ?? '—'} → ${c.now?.signal ?? '—'} dBm${c.signalDelta != null ? ` (${c.signalDelta > 0 ? '+' : ''}${c.signalDelta})` : ''}` },
                { label: 'LAN', render: (c) => (c.now?.ethMbps ? `${c.now.ethMbps}${c.now.ethHalfDuplex ? ' half' : ''}` : '—') },
                {
                  label: 'Firmware',
                  render: (c) =>
                    c.firmware
                      ? h('div', {}, c.firmware.version, c.firmware.state !== 'ok' ? h('div', {}, badge(FW_STATE[c.firmware.state]?.[0] ?? c.firmware.state, FW_STATE[c.firmware.state]?.[1] ?? '')) : null)
                      : h('span', { class: 'small muted' }, '—'),
                },
                { label: 'AP', render: (c) => c.now?.apName ?? c.ssid ?? '—' },
                {
                  label: 'Origine',
                  render: (c) =>
                    h(
                      'div',
                      {},
                      c.source === 'app' ? `app · ${fmtDate(c.createdAt)}` : nms('UISP', 'assegnata'),
                      admin && c.source === 'app' ? h('div', { class: 'small muted' }, `installata da ${c.installer}`) : null,
                      admin && c.assignedTo ? h('div', { class: 'small' }, `assegnata a ${c.assignedTo.username}`) : null,
                    ),
                },
                {
                  label: '',
                  render: (c) =>
                    h(
                      'div',
                      { class: 'btns ap-actions' },
                      // admins: the CPE as in the UISP app (detail, restart, firmware, backups…)
                      admin && c.deviceId ? h('a', { class: 'button-link small-btn', href: `#/cpe?id=${encodeURIComponent(c.deviceId)}` }, 'Gestisci') : null,
                      c.jobId ? h('a', { href: `#/jobs?q=${encodeURIComponent(c.mac)}` }, 'storico') : null,
                    ),
                },
              ],
              rows.slice(0, 500),
            )
          : h('div', { class: 'notice good' }, 'Nessuna CPE per questo filtro.'),
        rows.length > 500 ? h('p', { class: 'small muted' }, `Mostrate le prime 500 di ${rows.length}: usa i filtri o la ricerca.`) : null,
      ),
      withRadius ? (radius ??= radiusPanel()) : null,
    );
  }

  // CPEs offline for longer than the setting (Impostazioni server): hidden unless asked for
  let showStale = false;
  async function load() {
    data = await api(`/api/cpe-health${showStale ? '?stale=1' : ''}`);
    fillFilters();
    render();
  }
  filter.onchange = render;
  origin.onchange = render;
  fw.onchange = render;
  account.onchange = render;
  plan.onchange = render;
  q.oninput = render;
  const reload = h('button', { type: 'button' }, 'Aggiorna');
  reload.onclick = () => busy(reload, load);
  const csv = isOn('csv_export') ? h('button', { type: 'button' }, 'Esporta CSV') : null;
  if (csv) csv.onclick = () => busy(csv, () => download('/api/cpe-health.csv', 'salute-cpe.csv'));

  try {
    await load();
  } catch (e) {
    mount(out, h('div', { class: 'notice bad' }, e.body?.error === 'uisp_not_configured' ? nms('UISP non configurato: impostalo in Connettori.', 'Servizio non disponibile: contatta l’amministratore.') : e.message));
  }
  return h(
    'div',
    {},
    pageHead(
      admin ? 'Salute CPE' : 'Le mie CPE',
      admin ? 'Tutte le CPE dei clienti presenti in UISP: stato attuale, confronto con il collaudo per quelle installate con l’app, assegnazione agli installatori.' : 'Le CPE che hai installato con l’app e quelle che ti sono state assegnate.',
      reload,
      csv,
    ),
    card(
      h('div', { class: 'row' }, field('Mostra', filter), field('Origine', origin), field('Firmware', fw), field('Cerca', q)),
      // customer state and plan: admins with ISP Billing connected (the selects stay empty otherwise)
      admin ? h('div', { class: 'row crm-filters' }, field('Stato cliente (ISP Billing)', account), field('Profilo RADIUS', plan)) : null,
    ),
    out,
  );
}
