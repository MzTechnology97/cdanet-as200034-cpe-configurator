import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, table, toast } from '../dom.js';

export const KO_REASONS = {
  no_signal: 'Segnale insufficiente o nessun AP',
  no_link: 'La CPE non si aggancia',
  obstacles: 'Ostacoli, nessuna visibilità',
  cpe_fault: 'CPE guasta',
  no_access: 'Cliente assente o accesso impossibile',
  weather: 'Maltempo',
  material: 'Materiale mancante',
  other: 'Altro',
};
export const KO_STEPS = { config: 'Configurazione', write: 'Scrittura nella CPE', verify: 'Verifica della CPE', link: "Aggancio all'AP", aim: 'Puntamento', final: 'Verifica finale e collaudo' };
const KIND = { postponed: ['Rimandata', 'warn'], definitive: ['KO definitivo', 'bad'] };
const REVIEW = { pending: ['Da approvare (NOC)', 'warn'], approved: ['Approvata dal NOC', 'good'], rejected: ['Rifiutata dal NOC', 'bad'] };

export const koBadge = (ko) => (ko ? badge(`${KIND[ko.kind]?.[0] ?? ko.kind} · ${KO_REASONS[ko.reason] ?? ko.reason}`, KIND[ko.kind]?.[1] ?? '') : null);
export const reviewBadge = (state) => (state ? badge(REVIEW[state]?.[0] ?? state, REVIEW[state]?.[1] ?? '') : null);
const dmy = (d) => (d ? d.split('-').reverse().join('/') : '');

function resolveButton(k, onDone) {
  const b = h('button', { class: 'chip' }, 'Segna come risolto');
  b.onclick = (e) => {
    e.stopPropagation();
    const note = prompt('Come è stato risolto? (es. "Installata il 14/10 da Mario")');
    if (!note || note.trim().length < 3) return;
    busy(b, async () => {
      await api(`/api/admin/installs/ko/${k.id}/resolve`, { method: 'POST', body: { note: note.trim() } });
      toast('Segnalazione chiusa');
      await onDone();
    });
  };
  return b;
}

const koColumns = (admin, reload) =>
  [
    { label: 'Data', render: (k) => fmtDate(k.createdAt) },
    { label: 'Tipo', render: (k) => h('span', {}, badge(KIND[k.kind]?.[0] ?? k.kind, KIND[k.kind]?.[1] ?? ''), k.attempts > 1 ? h('div', { class: 'small muted' }, `tentativo ${k.attempts}`) : null) },
    {
      label: 'Cliente / CPE',
      render: (k) => h('div', {}, k.deviceName || k.pppoeUser || (k.mode === 'repoint' ? 'Ripuntamento' : '—'), h('div', { class: 'small muted mono' }, [k.mac, k.ssid].filter(Boolean).join(' · '))),
    },
    { label: 'Fase', render: (k) => KO_STEPS[k.step] ?? k.step },
    {
      label: 'Motivo',
      render: (k) =>
        h(
          'div',
          {},
          h('strong', {}, KO_REASONS[k.reason] ?? k.reason),
          h('div', { class: 'small' }, k.note),
          k.retryOn ? h('div', { class: 'small muted' }, `Da riprovare il ${dmy(k.retryOn)}`) : null,
          k.signal != null ? h('div', { class: 'small muted' }, `Segnale ${k.signal} dBm`) : null,
        ),
    },
    admin ? { label: 'Installatore', key: 'installer' } : null,
    {
      label: 'Stato',
      render: (k) =>
        k.resolvedAt
          ? h('div', { class: 'small' }, badge('Risolto', 'good'), h('div', { class: 'muted' }, `${k.resolution}${k.resolvedBy ? ` · ${k.resolvedBy}` : ''}`))
          : admin
            ? resolveButton(k, reload)
            : badge('Aperto', 'warn'),
    },
  ].filter(Boolean);

/** Open postponed/KO reports and acceptance tests waiting for the NOC (Storico, top). */
export async function followUpCard(user, onOpenJob) {
  const admin = user.role === 'admin';
  const el = h('div', {});
  async function load() {
    const [open, review] = await Promise.all([api('/api/installs/ko?open=1&limit=200'), api('/api/provisioning/jobs?status=review&limit=200')]);
    if (!open.length && !review.length) return mount(el);
    mount(
      el,
      card(
        h('h2', {}, 'Da seguire'),
        review.length
          ? [
              h('h3', {}, `Collaudi con segnale pessimo da approvare (${review.length})`),
              table(
                [
                  { label: 'Data', render: (j) => fmtDate(j.createdAt) },
                  { label: 'Cliente', render: (j) => h('div', {}, j.deviceName || '—', h('div', { class: 'small muted' }, j.pppoeUser)) },
                  { label: 'CPE', render: (j) => h('span', { class: 'mono small' }, `${j.mac} · ${j.ssid}`) },
                  admin ? { label: 'Installatore', key: 'installer' } : null,
                  { label: '', render: () => (admin ? h('span', { class: 'small' }, 'Apri per decidere →') : reviewBadge('pending')) },
                ].filter(Boolean),
                review,
                onOpenJob,
              ),
            ]
          : null,
        open.length ? [h('h3', {}, `Installazioni rimandate o KO aperte (${open.length})`), table(koColumns(admin, load), open)] : null,
      ),
    );
  }
  await load();
  return el;
}

/** Reports of one installation (job detail). */
export function jobKoPanel(job, admin) {
  const el = h('div', {}, h('p', { class: 'muted small' }, 'Caricamento…'));
  const load = async () => {
    const list = await api(`/api/installs/ko?jobId=${encodeURIComponent(job.id)}`);
    mount(el, list.length ? [h('h3', {}, 'Rimandi e KO'), table(koColumns(admin, load), list)] : null);
  };
  load().catch((e) => mount(el, h('div', { class: 'notice bad' }, e.message)));
  return el;
}

/** NOC approval of an acceptance test with poor radio. */
export function reviewPanel(job, admin, onChange) {
  const el = h('div', {});
  const load = async () => {
    const a = (await api(`/api/provisioning/jobs/${job.id}/acceptance`)).acceptance;
    const r = a?.review;
    if (!r) return mount(el);
    const info = [
      h('h3', {}, 'Approvazione NOC'),
      h('p', {}, reviewBadge(r.state), ' ', h('span', { class: 'small' }, r.reason)),
      r.state !== 'pending' ? h('p', { class: 'small muted' }, `${r.state === 'approved' ? 'Approvata' : 'Rifiutata'} da ${r.by ?? '—'} il ${fmtDate(r.at)}${r.note ? `: ${r.note}` : ''}`) : null,
    ];
    if (!admin || r.state !== 'pending') return mount(el, info);
    const note = h('input', { placeholder: 'Nota per l’installatore (obbligatoria se rifiuti)', maxlength: 500 });
    const ok = h('button', { class: 'primary' }, 'Approva');
    const no = h('button', { class: 'danger' }, 'Rifiuta');
    const decide = (decision, btn) =>
      busy(btn, async () => {
        if (decision === 'rejected' && note.value.trim().length < 3) throw new Error('Scrivi il motivo del rifiuto');
        await api(`/api/admin/provisioning/jobs/${job.id}/review`, { method: 'POST', body: { decision, note: note.value.trim() } });
        toast(decision === 'approved' ? 'Installazione approvata: l’installatore è stato avvisato' : 'Installazione rifiutata: l’installatore è stato avvisato');
        await load();
        onChange?.();
      });
    ok.onclick = () => decide('approved', ok);
    no.onclick = () => decide('rejected', no);
    mount(el, info, h('div', { class: 'row' }, field('Nota', note), h('div', { class: 'btns' }, ok, no)));
  };
  load().catch((e) => mount(el, h('div', { class: 'notice bad' }, e.message)));
  return el;
}
