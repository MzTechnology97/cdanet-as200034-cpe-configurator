import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '../../../web/js/dom.js';
import { setModules } from '../../../web/js/modules.js';
import { api } from '../lib/api';
import { Badge, Card, Notice, PageHeader, Skeleton } from '../ui';

/**
 * Funzionalità (admins): optional modules on or off for everyone. Off, a module disappears from the
 * console and the app and the server refuses its requests. Per-user exceptions are in Account.
 */

interface Module {
  key: string;
  label: string;
  area: string;
  description: string;
  enabled: boolean;
  default: boolean;
  usersOn?: number;
  usersOff?: number;
}

export function Modules() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'modules'], queryFn: () => api<Module[]>('/api/admin/modules') });
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (m: Module, on: boolean) => {
    setBusy(m.key);
    try {
      const next = await api<Module[]>('/api/admin/modules', { method: 'PUT', body: { [m.key]: on } });
      qc.setQueryData(['admin', 'modules'], next);
      setModules(Object.fromEntries(next.map((x) => [x.key, x.enabled])));
      toast(`${m.label}: ${on ? 'attivata' : 'disattivata'}`);
      // the menu follows (a module off hides its pages)
      window.dispatchEvent(new Event('cda:modules'));
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ui-page">
      <PageHeader icon="handyman" title="Funzionalità" subtitle="Moduli facoltativi. Se disattivati spariscono dalla console e dall’app e il server rifiuta le relative richieste." />
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !q.data ? (
        <Skeleton lines={8} />
      ) : (
        <Card padded={false}>
          <ul className="hl-list">
            {q.data.map((m) => (
              <li key={m.key} className="hl-row md-row">
                <div className="hl-main">
                  <div className="hl-name">
                    <strong>{m.label}</strong>
                    <Badge>{m.area}</Badge>
                    {!m.default && <span className="ui-muted ui-small">spento di default</span>}
                  </div>
                  <p className="ui-muted ui-small md-desc">{m.description}</p>
                  {!!(m.usersOn || m.usersOff) && (
                    <p className="ui-small md-desc">
                      Eccezioni per utente: {[m.usersOn ? `attivo per ${m.usersOn}` : '', m.usersOff ? `spento per ${m.usersOff}` : ''].filter(Boolean).join(', ')}
                    </p>
                  )}
                </div>
                <label className="ui-switch" title={m.enabled ? 'Disattiva' : 'Attiva'}>
                  <input type="checkbox" role="switch" checked={m.enabled} disabled={busy === m.key} onChange={(e) => void toggle(m, e.target.checked)} aria-label={`${m.label}: ${m.enabled ? 'attiva' : 'spenta'}`} />
                  <span aria-hidden="true" />
                </label>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Sempre attivi">
        <p className="ui-muted ui-small md-desc">Provisioning, storico, profili airOS, reti Wi-Fi, account, connettori e registro attività fanno parte del nucleo e non si disattivano.</p>
        <p className="ui-muted ui-small md-desc">L’app Android aggiorna i moduli all’accesso: le modifiche valgono dal login successivo.</p>
        <p className="ui-muted ui-small md-desc">
          Per attivare o disattivare un modulo solo per alcuni utenti: <a href="#/users">Account</a> → scegli l’utente → «Funzionalità per questo utente». Le notifiche Telegram valgono per tutti.
        </p>
      </Card>
    </div>
  );
}
