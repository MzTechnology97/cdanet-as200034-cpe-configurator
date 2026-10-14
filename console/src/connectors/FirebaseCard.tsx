import { type ChangeEvent, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Card, Field, Notice } from '../ui';

/**
 * Connettori → Firebase: the push notifications of the Android app (Firebase Cloud Messaging).
 * The two files of the Firebase project are pasted (or read from disk) as text; the service
 * account's private key is sealed on the server and never comes back. Without Firebase the app
 * stays connected to the server by itself while it runs.
 */

const ERRORS: Record<string, string> = {
  firebase_service_account_invalid: 'Il file del service account non è valido.',
  firebase_google_services_invalid: 'google-services.json non valido.',
  firebase_project_mismatch: 'I due file sono di progetti Firebase diversi.',
  firebase_incomplete: 'Per attivarlo servono entrambi i file.',
  firebase_not_configured: 'Firebase non è configurato.',
};
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const apiError = (e: unknown) => {
  const err = e as Error & { body?: { error?: string; issues?: Array<{ message: string }> } };
  return new Error(ERRORS[err.body?.error ?? ''] ?? err.body?.issues?.[0]?.message ?? err.message);
};
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export interface Firebase {
  configured: boolean;
  enabled: boolean;
  projectId: string;
  clientEmail: string;
  apps: string[];
  devices: number;
  updatedAt?: string | null;
}

/** A JSON file of the project: pasted, or read from a file chosen on this computer. */
function JsonField({ label, hint, value, onChange, placeholder }: { label: string; hint: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const read = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onChange(await file.text());
  };
  return (
    <Field label={label} hint={hint}>
      <textarea className="cn-json" aria-label={label} spellCheck={false} autoComplete="off" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <input type="file" accept=".json,application/json" aria-label={`${label}: scegli il file`} onChange={(e) => void read(e)} />
    </Field>
  );
}

export function FirebaseCard({ f, onSaved }: { f: Firebase; onSaved: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(f.configured ? f.enabled : true);
  const [serviceAccount, setServiceAccount] = useState('');
  const [googleServices, setGoogleServices] = useState('');
  const [result, setResult] = useState<{ sent: number } | null>(null);
  const on = f.configured && f.enabled;

  const save = async () => {
    try {
      await api('/api/admin/connectors/firebase', {
        method: 'PUT',
        body: { enabled, ...(serviceAccount.trim() ? { serviceAccount: serviceAccount.trim() } : {}), ...(googleServices.trim() ? { googleServices: googleServices.trim() } : {}) },
      });
    } catch (e) {
      throw apiError(e);
    }
    toast(enabled ? 'Firebase salvato e attivo' : 'Firebase salvato (disattivato)');
    await onSaved();
  };
  const test = async () => {
    try {
      setResult(await api<{ sent: number }>('/api/admin/connectors/firebase/test', { method: 'POST' }));
    } catch (e) {
      throw apiError(e);
    }
  };
  const remove = async () => {
    if (!confirm('Rimuovere Firebase? La chiave del service account viene cancellata dal server e l’app smette di ricevere le notifiche push (resta collegata da sola mentre è aperta).')) return;
    await api('/api/admin/connectors/firebase', { method: 'DELETE' });
    setResult(null);
    toast('Firebase rimosso');
    await onSaved();
  };

  return (
    <Card title="Firebase · notifiche push dell’app" actions={<Badge tone={on ? 'good' : f.configured ? 'neutral' : 'warn'}>{on ? 'attivo' : f.configured ? 'disattivato' : 'non configurato'}</Badge>}>
      <p className="ui-muted ui-small cn-p">
        Con Firebase Cloud Messaging le notifiche arrivano sul telefono anche con l’app chiusa. Senza, l’app le riceve solo mentre resta collegata al server. Nei messaggi mai nome, indirizzo o posizione del cliente.
      </p>
      {f.configured && (
        <p className="ui-muted ui-small cn-p">
          Progetto <span className="ui-mono">{f.projectId || '—'}</span>
          {f.clientEmail ? (
            <>
              {' '}
              · service account <span className="ui-mono">{f.clientEmail}</span>
            </>
          ) : null}
          {f.apps.length ? ` · app ${f.apps.join(', ')}` : ''} · {f.devices} {f.devices === 1 ? 'telefono registrato' : 'telefoni registrati'}
          {f.updatedAt ? ` · ultima modifica ${date(f.updatedAt)}` : ''}
        </p>
      )}
      <details className="ui-details">
        <summary>Come si configura</summary>
        <ol className="ui-list ui-small">
          <li>Nella console di Firebase crea un progetto (o usa quello esistente) e aggiungi un’app Android con il pacchetto dell’app CDA Net.</li>
          <li>Scarica google-services.json dalle impostazioni dell’app Android del progetto.</li>
          <li>In Impostazioni progetto → Account di servizio genera una nuova chiave privata: è il file JSON del service account.</li>
          <li>Incolla qui i due file (o sceglili dal computer), lascia «Attivo» e salva.</li>
          <li>Apri l’app sul tuo telefono, consenti le notifiche, poi premi «Invia notifica di prova».</li>
        </ol>
      </details>
      <label className="ui-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Attivo
      </label>
      <JsonField
        label="Service account (JSON)"
        hint={f.configured ? 'Già salvato e cifrato sul server: lascia vuoto per non cambiarlo.' : 'Contiene la chiave privata: resta cifrata sul server e non viene mai mostrata.'}
        value={serviceAccount}
        onChange={setServiceAccount}
        placeholder={'{ "type": "service_account", "project_id": "…", … }'}
      />
      <JsonField
        label="google-services.json"
        hint={f.apps.length ? `Salvato (app ${f.apps.join(', ')}): lascia vuoto per non cambiarlo.` : 'Il file dell’app Android del progetto Firebase.'}
        value={googleServices}
        onChange={setGoogleServices}
        placeholder={'{ "project_info": { "project_id": "…" }, "client": [ … ] }'}
      />
      <div className="ui-row">
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva
        </AsyncButton>
        {on && (
          <AsyncButton onClick={test} onError={fail}>
            Invia notifica di prova
          </AsyncButton>
        )}
        {f.configured && (
          <AsyncButton variant="danger" onClick={remove} onError={fail}>
            Rimuovi
          </AsyncButton>
        )}
      </div>
      {result &&
        (result.sent > 0 ? (
          <Notice tone="good">
            Notifica inviata a {result.sent} {result.sent === 1 ? 'telefono' : 'telefoni'}: controlla il tuo.
          </Notice>
        ) : (
          <Notice tone="warn">Nessun telefono a cui inviarla: apri l’app sul tuo telefono con il tuo account almeno una volta, consenti le notifiche e riprova.</Notice>
        ))}
    </Card>
  );
}
