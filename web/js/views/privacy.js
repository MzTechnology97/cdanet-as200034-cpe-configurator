import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';

/** Saves a printable attestation as an .html file (the request needs the session, so through a blob). */
export async function openAttestation(id) {
  const r = await api(`/api/privacy/acceptances/${id}/document`, { raw: true });
  if (!r.ok) return toast('Attestazione non disponibile', 'bad');
  const url = URL.createObjectURL(new Blob([await r.text()], { type: 'text/html' }));
  const a = h('a', { href: url, download: `attestazione-privacy-${id}.html` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * "Informativa privacy": the controller's details that complete the notice of the app, who has
 * accepted the current text and the attestation of each acceptance.
 */
export async function privacyView() {
  const box = h('div', {});
  async function load() {
    const d = await api('/api/admin/privacy');
    const c = d.controller ?? {};
    const inputs = {
      name: h('input', { value: c.name ?? '', placeholder: 'Ragione sociale' }),
      address: h('input', { value: c.address ?? '', placeholder: 'Sede legale' }),
      vat: h('input', { value: c.vat ?? '', placeholder: 'Partita IVA' }),
      email: h('input', { value: c.email ?? '', placeholder: 'privacy@…' }),
      pec: h('input', { value: c.pec ?? '', placeholder: 'facoltativa' }),
      dpo: h('input', { value: c.dpo ?? '', placeholder: 'nome e contatto, se nominato' }),
      retentionMonths: h('input', { type: 'number', min: 1, max: 120, value: c.retentionMonths ?? 24 }),
    };
    const save = h('button', { class: 'primary' }, 'Salva');
    save.onclick = () =>
      busy(save, async () => {
        const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, k === 'retentionMonths' ? Number(el.value) || 24 : el.value]));
        const r = await api('/api/admin/privacy', { method: 'PUT', body });
        toast(r.complete ? 'Salvato: gli utenti accetteranno la nuova informativa al prossimo accesso' : 'Salvato: completa ragione sociale, sede ed email', r.complete ? 'good' : 'bad');
        await load();
      });
    const accepted = d.users.filter((u) => u.active && u.current).length;
    const active = d.users.filter((u) => u.active).length;
    mount(
      box,
      card(
        h('h2', {}, 'Titolare del trattamento'),
        h(
          'p',
          { class: 'small muted' },
          'Questi dati completano l’informativa che ogni utente dell’app legge e accetta al primo accesso. Ogni modifica crea un testo nuovo, che tutti dovranno accettare di nuovo; le attestazioni già firmate restano come erano.',
        ),
        h('div', { class: 'row' }, field('Ragione sociale', inputs.name), field('Sede', inputs.address)),
        h('div', { class: 'row' }, field('Partita IVA', inputs.vat), field('Email privacy', inputs.email), field('PEC', inputs.pec)),
        h('div', { class: 'row' }, field('DPO', inputs.dpo), field('Conservazione registro (mesi)', inputs.retentionMonths)),
        h('div', { class: 'btns' }, save),
        d.complete ? null : h('div', { class: 'notice warn' }, 'Informativa incompleta: finché non compili ragione sociale, sede ed email l’app non la chiede.'),
        h('div', { class: 'notice warn' }, 'Il testo è una base preparata sulla normativa italiana ed europea (GDPR, D.Lgs. 196/2003, art. 4 dello Statuto dei lavoratori): fallo verificare dal tuo consulente privacy o DPO prima di usarlo.'),
      ),
      d.notice
        ? card(
            h('h2', {}, `Testo in vigore (versione ${d.version})`),
            h('p', { class: 'small muted mono' }, `SHA-256 ${d.sha256}`),
            h('details', {}, h('summary', {}, 'Leggi l’informativa'), h('h3', {}, d.notice.title), d.notice.sections.map((s) => [h('h4', {}, s.title), s.paragraphs.map((p) => h('p', { class: 'small' }, p))])),
          )
        : null,
      card(
        h('h2', {}, 'Utenti'),
        d.notice ? h('p', { class: 'small' }, `${accepted} utenti attivi su ${active} hanno accettato il testo in vigore.`) : null,
        table(
          [
            { label: 'Utente', render: (u) => h('div', {}, h('b', {}, u.username), u.active ? null : h('span', { class: 'small muted' }, ' disattivato')) },
            { label: 'Ruolo', render: (u) => (u.role === 'admin' ? 'amministratore' : 'installatore') },
            { label: 'Informativa in vigore', render: (u) => (d.notice ? (u.current ? badge('accettata', 'good') : badge('da accettare', 'warn')) : '—') },
          ],
          d.users,
        ),
      ),
      card(
        h('h2', {}, 'Attestazioni'),
        table(
          [
            { label: 'N.', render: (a) => a.id },
            { label: 'Utente', render: (a) => a.username },
            { label: 'Data', render: (a) => fmtDate(a.acceptedAt) },
            { label: 'Dispositivo', render: (a) => h('div', {}, a.device || '—', h('div', { class: 'small muted' }, [a.appVersion ? `app ${a.appVersion}` : '', a.ip].filter(Boolean).join(' · '))) },
            { label: 'Testo', render: (a) => (a.current ? badge('in vigore', 'good') : badge('precedente', '')) },
            {
              label: '',
              render: (a) => {
                const b = h('button', { class: 'small' }, 'Scarica attestazione');
                b.onclick = () => openAttestation(a.id);
                return b;
              },
            },
          ],
          d.acceptances,
        ),
      ),
    );
  }
  await load();
  return h('div', {}, pageHead('Informativa privacy', 'Dati del titolare, accettazioni degli utenti e attestazioni stampabili.'), box);
}
