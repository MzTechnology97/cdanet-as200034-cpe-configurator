import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Field, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * Informativa privacy (admins): the controller's details that complete the notice of the app, who
 * has accepted the current text and the printable attestation of each acceptance.
 */

interface Controller {
  name?: string;
  address?: string;
  vat?: string;
  email?: string;
  pec?: string;
  dpo?: string;
  retentionMonths?: number;
}
interface Data {
  controller: Controller | null;
  complete: boolean;
  version?: number;
  sha256?: string;
  notice?: { title: string; sections: Array<{ title: string; paragraphs: string[] }> } | null;
  users: Array<{ id: number; username: string; role: string; active: boolean; current: boolean }>;
  acceptances: Array<{ id: number; username: string; acceptedAt: string; device?: string; appVersion?: string; ip?: string; current: boolean }>;
}

const date = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
const fail = (e: unknown) => toast((e as Error).message, 'bad');

/** Saves a printable attestation as an .html file (the request needs the session, so through a blob). */
export async function openAttestation(id: number) {
  const r = await api<Response>(`/api/privacy/acceptances/${id}/document`, { raw: true });
  if (!r.ok) return void toast('Attestazione non disponibile', 'bad');
  const url = URL.createObjectURL(new Blob([await r.text()], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `attestazione-privacy-${id}.html`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const FIELDS: Array<[keyof Controller, string, string, string?]> = [
  ['name', 'Ragione sociale', 'Ragione sociale'],
  ['address', 'Sede', 'Sede legale'],
  ['vat', 'Partita IVA', 'Partita IVA'],
  ['email', 'Email privacy', 'privacy@…', 'email'],
  ['pec', 'PEC', 'facoltativa', 'email'],
  ['dpo', 'DPO', 'nome e contatto, se nominato'],
];

export function Privacy() {
  const q = useQuery({ queryKey: ['admin', 'privacy'], queryFn: () => api<Data>('/api/admin/privacy') });
  const [edit, setEdit] = useState<Controller | null>(null);
  const d = q.data;
  const c: Controller = edit ?? { retentionMonths: 24, ...(d?.controller ?? {}) };
  const set = (k: keyof Controller, v: string) => setEdit({ ...c, [k]: k === 'retentionMonths' ? Number(v) : v });

  const save = async () => {
    const body = { ...Object.fromEntries(FIELDS.map(([k]) => [k, String(c[k] ?? '')])), retentionMonths: Number(c.retentionMonths) || 24 };
    const r = await api<{ complete: boolean }>('/api/admin/privacy', { method: 'PUT', body });
    toast(r.complete ? 'Salvato: gli utenti accetteranno la nuova informativa al prossimo accesso' : 'Salvato: completa ragione sociale, sede ed email', r.complete ? 'good' : 'bad');
    setEdit(null);
    await q.refetch();
  };

  const accepted = d ? d.users.filter((u) => u.active && u.current).length : 0;
  const active = d ? d.users.filter((u) => u.active).length : 0;

  return (
    <div className="ui-page">
      <PageHeader icon="lock" title="Informativa privacy" subtitle="Dati del titolare, accettazioni degli utenti e attestazioni stampabili." />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={8} />}
      {d && (
        <>
          <Card title="Titolare del trattamento">
            <p className="ui-muted ui-small pv-p">Questi dati completano l’informativa che ogni utente dell’app legge e accetta al primo accesso. Ogni modifica crea un testo nuovo, che tutti dovranno accettare di nuovo; le attestazioni già firmate restano come erano.</p>
            <div className="ui-grid-form">
              {FIELDS.map(([k, label, ph, type]) => (
                <Field key={k} label={label}>
                  <input type={type ?? 'text'} value={String(c[k] ?? '')} placeholder={ph} onChange={(e) => set(k, e.target.value)} />
                </Field>
              ))}
              <Field label="Conservazione registro (mesi)">
                <input type="number" min={1} max={120} value={c.retentionMonths ?? 24} onChange={(e) => set('retentionMonths', e.target.value)} />
              </Field>
            </div>
            <div className="ui-row">
              <AsyncButton variant="primary" onClick={save} onError={fail} disabled={!edit}>
                Salva
              </AsyncButton>
            </div>
            {!d.complete && <Notice tone="warn">Informativa incompleta: finché non compili ragione sociale, sede ed email l’app non la chiede.</Notice>}
            <Notice tone="warn">Il testo è una base preparata sulla normativa italiana ed europea (GDPR, D.Lgs. 196/2003, art. 4 dello Statuto dei lavoratori): fallo verificare dal tuo consulente privacy o DPO prima di usarlo.</Notice>
          </Card>
          {d.notice && (
            <Card title={`Testo in vigore (versione ${d.version})`}>
              <p className="ui-muted ui-small ui-mono pv-p">SHA-256 {d.sha256}</p>
              <details className="ui-details pv-text">
                <summary>Leggi l’informativa</summary>
                <h3>{d.notice.title}</h3>
                {d.notice.sections.map((s) => (
                  <section key={s.title}>
                    <h4>{s.title}</h4>
                    {s.paragraphs.map((p, i) => (
                      <p key={i} className="ui-small">
                        {p}
                      </p>
                    ))}
                  </section>
                ))}
              </details>
            </Card>
          )}
          <Card title="Utenti" padded={false}>
            {d.notice && (
              <p className="ui-small pv-note">
                {accepted} utenti attivi su {active} hanno accettato il testo in vigore.
              </p>
            )}
            <Table
              rows={d.users}
              rowKey={(u) => u.id ?? u.username}
              columns={[
                {
                  label: 'Utente',
                  render: (u) => (
                    <span>
                      <strong>{u.username}</strong>
                      {!u.active && <span className="ui-muted ui-small"> disattivato</span>}
                    </span>
                  ),
                },
                { label: 'Ruolo', render: (u) => (u.role === 'admin' ? 'amministratore' : 'installatore') },
                { label: 'Informativa in vigore', render: (u) => (d.notice ? u.current ? <Badge tone="good">accettata</Badge> : <Badge tone="warn">da accettare</Badge> : '—') },
              ]}
            />
          </Card>
          <Card title="Attestazioni" padded={false}>
            <Table
              rows={d.acceptances}
              rowKey={(a) => a.id}
              empty="Nessuna accettazione ancora."
              columns={[
                { label: 'N.', render: (a) => a.id },
                { label: 'Utente', render: (a) => a.username },
                { label: 'Data', render: (a) => date(a.acceptedAt) },
                {
                  label: 'Dispositivo',
                  render: (a) => (
                    <div>
                      {a.device || '—'}
                      <div className="ui-muted ui-small">{[a.appVersion ? `app ${a.appVersion}` : '', a.ip].filter(Boolean).join(' · ')}</div>
                    </div>
                  ),
                },
                { label: 'Testo', render: (a) => (a.current ? <Badge tone="good">in vigore</Badge> : <Badge>precedente</Badge>) },
                {
                  label: '',
                  end: true,
                  render: (a) => (
                    <AsyncButton onClick={() => openAttestation(a.id)} onError={fail}>
                      Attestazione
                    </AsyncButton>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
