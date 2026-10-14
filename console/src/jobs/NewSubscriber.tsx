import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { Button, Field, Notice, Skeleton } from '../ui';

/**
 * «Nuovo subscriber» (admins, UISP CRM app key set): the CPE of a job accepted as a new customer.
 * The server creates the CRM client and the service of the chosen plan, then authorizes the CPE in
 * the endpoint site UISP makes for that service. The form starts from the server's draft (name
 * from the PPPoE user, address of the work order, the plan of the PPPoE profile in ISP Billing).
 */

export interface SubscriberDraft {
  firstName: string;
  lastName: string;
  street: string;
  crm: boolean;
  /** The plan matching the job's PPPoE profile in ISP Billing (null: the NOC chooses). */
  planPeriodId?: number | null;
  planName?: string | null;
}
interface Plan {
  id: number;
  name: string;
  periodId: number;
}
interface Created {
  ok: boolean;
  site: string;
  /** null when the CRM client was already made by an earlier attempt. */
  clientId: number | null;
  serviceId: number;
  backup?: 'created' | 'failed' | 'disabled';
}
type ApiErr = Error & { body?: { error?: string; detail?: string; status?: number; clientId?: number; serviceId?: number; site?: string } };

const ERRORS: Record<string, string> = {
  uisp_crm_not_configured: 'Chiave del CRM di UISP non configurata (Connettori → UISP).',
  uisp_crm_unauthorized: 'UISP ha rifiutato la chiave del CRM.',
  uisp_crm_error: 'Errore del CRM di UISP',
  uisp_subscriber_site_pending: 'Subscriber creato, ma UISP non ha ancora preparato il suo sito: riprova tra un minuto.',
  uisp_device_not_found: 'La CPE non è ancora comparsa in UISP: attendi che si colleghi dopo il riavvio e riprova.',
  uisp_already_authorized: 'La CPE è già stata accettata in UISP.',
  uisp_unreachable: 'UISP non raggiungibile dal server.',
};
const message = (e: unknown) => {
  const err = e as ApiErr;
  const code = err.body?.error ?? '';
  const text = ERRORS[code] ?? err.message;
  return code === 'uisp_crm_error' && err.body?.detail ? `${text}: ${err.body.detail}` : text;
};

export function NewSubscriber({ jobId, draft, onDone, onCancel }: { jobId: string; draft: SubscriberDraft; onDone: () => Promise<unknown>; onCancel: () => void }) {
  const plans = useQuery({ queryKey: ['admin', 'uisp', 'service-plans'], queryFn: () => api<Plan[]>('/api/admin/uisp/service-plans'), staleTime: 5 * 60_000, retry: false });
  const suggested = draft.planPeriodId != null ? String(draft.planPeriodId) : '';
  const [f, setF] = useState({ firstName: draft.firstName, lastName: draft.lastName, street: draft.street, period: suggested });
  // the suggested plan only when UISP has it among the plans of the default organization
  useEffect(() => {
    if (plans.data && f.period && !plans.data.some((p) => String(p.periodId) === f.period)) setF((x) => ({ ...x, period: '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans.data]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // created in the CRM but not yet authorized (UISP had not made its site yet): retried without creating it again
  const [waiting, setWaiting] = useState<{ clientId?: number; serviceId: number } | null>(null);

  const finish = async (r: Created) => {
    toast(`Subscriber creato e CPE accettata nel sito ${r.site}${r.backup === 'created' ? ' · backup avviato' : r.backup === 'failed' ? ' · backup non riuscito' : ''}`);
    await onDone();
  };
  const send = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      await finish(await api<Created>(`/api/admin/provisioning/jobs/${jobId}/uisp/subscriber`, { method: 'POST', body }));
    } catch (e) {
      const err = e as ApiErr;
      if (err.body?.error === 'uisp_subscriber_site_pending' && err.body.serviceId) setWaiting({ clientId: err.body.clientId, serviceId: err.body.serviceId });
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.lastName.trim()) return setError('Il cognome (o la ragione sociale) è obbligatorio.');
    if (!f.period) return setError('Scegli il piano di servizio.');
    void send({ firstName: f.firstName.trim(), lastName: f.lastName.trim(), street: f.street.trim(), servicePlanPeriodId: Number(f.period) });
  };

  if (waiting) {
    return (
      <section className="jb-sub" aria-label="Nuovo subscriber">
        <h4>Nuovo subscriber</h4>
        <Notice tone="warn">
          Subscriber creato nel CRM{waiting.clientId ? ` (cliente ${waiting.clientId}` : ' ('}, servizio {waiting.serviceId}), ma UISP non ha ancora preparato il suo sito: la CPE non è ancora accettata. Riprova tra un minuto, senza crearlo di nuovo.
        </Notice>
        {error && !error.startsWith('Subscriber creato') && <Notice tone="bad">{error}</Notice>}
        <div className="ui-row">
          <Button variant="primary" busy={busy} onClick={() => void send({ serviceId: waiting.serviceId })}>
            Riprova ad accettare
          </Button>
        </div>
      </section>
    );
  }

  return (
    <form className="jb-sub" aria-label="Nuovo subscriber" onSubmit={submit}>
      <h4>Nuovo subscriber</h4>
      <p className="ui-muted ui-small jb-p">Crea il cliente e il servizio nel CRM di UISP e accetta la CPE nel sito del nuovo servizio.</p>
      <div className="ui-grid-form">
        <Field label="Nome">
          <input value={f.firstName} autoComplete="off" maxLength={100} onChange={(e) => setF({ ...f, firstName: e.target.value })} />
        </Field>
        <Field label="Cognome o ragione sociale">
          <input value={f.lastName} autoComplete="off" required maxLength={100} onChange={(e) => setF({ ...f, lastName: e.target.value })} />
        </Field>
      </div>
      <Field label="Indirizzo">
        <input value={f.street} autoComplete="off" maxLength={200} onChange={(e) => setF({ ...f, street: e.target.value })} />
      </Field>
      <Field label="Piano di servizio" hint={suggested && f.period === suggested && plans.data ? `Dal profilo ISPBilling${draft.planName ? ` (${draft.planName})` : ''}: cambialo se serve.` : undefined}>
        {plans.error ? (
          <Notice tone="bad">{message(plans.error)}</Notice>
        ) : !plans.data ? (
          <Skeleton lines={1} />
        ) : (
          <select value={f.period} required onChange={(e) => setF({ ...f, period: e.target.value })}>
            <option value="">— scegli —</option>
            {plans.data.map((p) => (
              <option key={`${p.id}-${p.periodId}`} value={p.periodId}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="ui-row">
        <Button type="submit" variant="primary" busy={busy} disabled={!plans.data?.length}>
          Crea subscriber e autorizza
        </Button>
        <Button type="button" onClick={onCancel}>
          Annulla
        </Button>
      </div>
    </form>
  );
}
