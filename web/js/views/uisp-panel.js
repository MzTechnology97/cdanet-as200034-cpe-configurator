import { api } from '../api.js';
import { badge, busy, fmtDate, h, mount, stat, table, toast } from '../dom.js';

const ERRORS = {
  uisp_not_configured: 'UISP non configurato: impostalo in Connettori.',
  uisp_tls_error: 'Certificato TLS di UISP non valido: valuta "Ignora verifica TLS" in Connettori.',
  uisp_unreachable: 'UISP non raggiungibile dal server.',
  uisp_auth_failed: 'Token UISP rifiutato: verifica UISP_API_TOKEN e i suoi permessi.',
  uisp_device_not_found: 'La CPE non è ancora comparsa in UISP: attendi che si colleghi dopo il riavvio e riprova.',
  uisp_already_authorized: 'La CPE è già stata accettata in UISP.',
  uisp_site_unknown: 'Non riesco a determinare il site dell’AP: sceglilo manualmente.',
};
const err = (e) => ERRORS[e.body?.error] ?? e.message;

async function download(url, fallbackName) {
  const r = await api(url, { raw: true });
  if (!r.ok) throw new Error(`Download non riuscito (HTTP ${r.status})`);
  const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const a = h('a', { href: URL.createObjectURL(await r.blob()), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** UISP section of a provisioning job: live status, acceptance and backups. */
export function uispPanel(job, isAdmin) {
  const box = h('div', {}, h('p', { class: 'muted small' }, 'Lettura stato da UISP…'));

  async function load() {
    let s;
    try {
      s = await api(`/api/provisioning/jobs/${job.id}/uisp`);
    } catch (e) {
      mount(box, h('div', { class: 'notice bad' }, err(e)));
      return;
    }
    if (!s.configured) {
      mount(box, h('p', { class: 'small muted' }, 'Integrazione UISP non configurata.'));
      return;
    }
    const d = s.device;
    if (!d) {
      const retry = h('button', {}, 'Ricontrolla');
      retry.onclick = () => busy(retry, load);
      mount(box, h('div', { class: 'notice warn' }, 'CPE non ancora presente in UISP (ricerca per MAC). Dopo il riavvio può servire qualche minuto.'), retry);
      return;
    }
    const pending = !d.authorized;
    const actions = h('div', { class: 'btns' });
    const refresh = h('button', {}, 'Aggiorna');
    refresh.onclick = () => busy(refresh, load);
    actions.append(refresh);

    if (isAdmin && pending) {
      const accept = h('button', { class: 'primary' }, 'Accetta in UISP');
      accept.onclick = () =>
        busy(accept, async () => {
          let siteId;
          if (s.proposedSite) {
            if (!confirm(`Accettare ${d.name || d.mac} in UISP nel site "${s.proposedSite.name}" (site dell’AP agganciato)?`)) return;
          } else {
            const sites = await api('/api/admin/uisp/sites');
            const choice = prompt(
              `Site dell’AP non determinabile. Scrivi il numero del site:\n\n${sites.map((x, i) => `${i + 1}. ${x.name}`).join('\n')}`,
            );
            const idx = Number(choice) - 1;
            if (!sites[idx]) return;
            siteId = sites[idx].id;
          }
          try {
            const r = await api(`/api/admin/provisioning/jobs/${job.id}/uisp/authorize`, { method: 'POST', body: siteId ? { siteId } : {} });
            toast(`CPE accettata nel site ${r.site}${r.backup === 'created' ? ' · backup avviato' : r.backup === 'failed' ? ' · backup non riuscito' : ''}`);
          } catch (e) {
            throw new Error(err(e));
          }
          await load();
        });
      actions.append(accept);
    }

    const backups = h('div', {});
    if (isAdmin && !pending) {
      const mk = h('button', {}, 'Backup ora');
      mk.onclick = () =>
        busy(mk, async () => {
          try {
            await api(`/api/admin/provisioning/jobs/${job.id}/uisp/backups`, { method: 'POST', body: {} });
          } catch (e) {
            throw new Error(err(e));
          }
          toast('Backup richiesto a UISP');
          setTimeout(loadBackups, 3000);
        });
      actions.append(mk);
      loadBackups();
    }

    async function loadBackups() {
      try {
        const list = await api(`/api/admin/provisioning/jobs/${job.id}/uisp/backups`);
        mount(
          backups,
          h('h3', {}, 'Backup in UISP'),
          list.length
            ? table(
                [
                  { label: 'Data', render: (b) => fmtDate(b.timestamp) },
                  {
                    label: '',
                    render: (b) => {
                      const dl = h('button', {}, 'Scarica');
                      dl.onclick = () => busy(dl, () => download(`/api/admin/provisioning/jobs/${job.id}/uisp/backups/${encodeURIComponent(b.id)}`, `backup-${b.id}.unms`));
                      return dl;
                    },
                  },
                ],
                list,
              )
            : h('p', { class: 'small muted' }, 'Nessun backup.'),
        );
      } catch (e) {
        mount(backups, h('p', { class: 'small muted' }, `Backup non disponibili: ${err(e)}`));
      }
    }

    mount(
      box,
      h(
        'div',
        { class: 'grid' },
        stat('UISP', pending ? 'In attesa di accettazione' : 'Accettata'),
        stat('Stato', d.status === 'active' ? 'online' : d.status),
        stat('Segnale', d.signal != null ? `${d.signal} dBm` : '—'),
        stat('AP', d.apName ?? '—'),
        stat('Site', s.site ?? (pending && s.proposedSite ? `${s.proposedSite.name} (proposto)` : '—')),
        stat('Firmware', d.firmware || '—'),
      ),
      pending ? null : s.authorizedAt ? h('p', { class: 'small muted' }, `Accettata il ${fmtDate(s.authorizedAt)}`) : null,
      actions,
      backups,
    );
  }

  load();
  return box;
}

/** Dashboard card: UISP connection test. */
export async function uispStatusCard() {
  const s = await api('/api/admin/uisp/status').catch((e) => ({ configured: true, ok: false, error: e.message }));
  if (!s.configured) return h('p', { class: 'small muted' }, 'Non configurata: impostala in ', h('a', { href: '#/connectors' }, 'Connettori'), ' per AP vicini, accettazione CPE e backup.');
  if (s.ok === false) return h('div', { class: 'notice bad' }, `Connessione UISP non riuscita: ${ERRORS[s.error] ?? s.error}${s.status ? ` (HTTP ${s.status})` : ''} · `, h('a', { href: '#/connectors' }, 'apri Connettori'));
  return h(
    'div',
    { class: 'grid' },
    stat('Dispositivi', s.devices),
    stat('AP', `${s.aps} (${s.apsWithLocation} con posizione)`),
    stat('In attesa', s.pending),
    stat('Site', s.sites),
    stat('Versione UISP', s.version ?? '—'),
    h('div', { class: 'stat' }, h('small', {}, 'Connessione'), badge('OK', 'good')),
  );
}
