import { useState } from 'react';
import { toast } from '../../../web/js/dom.js';
import { api } from '../lib/api';
import { AsyncButton, Badge, Button, Card, Field, Notice } from '../ui';

/** Connettori → Telegram: one bot for the NOC group and for every user's personal notifications. */

const EVENTS: Array<[string, string, string]> = [
  ['provisioning_failed', 'Installazioni da seguire', 'provisioning fallito, installazione KO o rimandata (con motivo), collaudo con segnale pessimo da approvare'],
  ['uisp_pending', 'CPE da accettare in UISP', 'con il link allo storico per premere «Accetta in UISP»'],
  ['uisp_status', 'UISP giù / di nuovo su', 'solo al cambio di stato, controllo ogni 5 minuti'],
  ['security', 'Sicurezza', 'account bloccato per tentativi, admin da un indirizzo nuovo, password admin cambiate'],
  ['power_outage', 'Guasti Enel', 'guasti e lavori e-distribuzione nelle zone di interesse e vicino agli AP, e i ripristini'],
  ['daily_summary', 'Riepilogo serale', 'installazioni riuscite/fallite, collaudi, CPE ancora da accettare'],
];
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export interface Telegram {
  configured: boolean;
  enabled: boolean;
  personal?: boolean;
  personalLinked?: number;
  tokenSet: boolean;
  tokenHint?: string;
  chatId: string;
  events: string[];
  summaryHour: number;
  publicUrl?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export function TelegramCard({ t, onSaved }: { t: Telegram; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ enabled: t.configured ? t.enabled : !!t.chatId, personal: t.personal !== false, token: '', chatId: t.chatId, hour: String(t.summaryHour), events: new Set(t.events) });
  const [out, setOut] = useState<React.ReactNode>(null);
  const personalOn = t.tokenSet && t.personal !== false;
  const nocOn = t.configured && t.enabled;

  const findChats = async () => {
    const chats = await api<Array<{ id: string; title?: string; type: string }>>('/api/admin/connectors/telegram/chats', { method: 'POST', body: { token: f.token.trim() } });
    setOut(
      chats.length ? (
        <>
          <p className="ui-small cn-p">Chat che hanno scritto al bot (clic per usarla):</p>
          <div className="ui-row">
            {chats.map((c) => (
              <Button key={c.id} onClick={() => setF((x) => ({ ...x, chatId: c.id }))}>
                {c.title || c.id} ({c.type})
              </Button>
            ))}
          </div>
        </>
      ) : (
        <Notice tone="warn">Nessuna chat: aggiungi il bot al gruppo del NOC, scrivi un messaggio nel gruppo e riprova.</Notice>
      ),
    );
  };
  const sendTest = async () => {
    const r = await api<{ bot?: string }>('/api/admin/connectors/telegram/test', { method: 'POST', body: { token: f.token.trim(), chatId: f.chatId.trim() } });
    setOut(<Notice tone="good">Messaggio inviato dal bot @{r.bot ?? '?'}: controlla il gruppo.</Notice>);
  };
  const preview = async () => {
    const r = await api<{ text: string }>('/api/admin/connectors/telegram/summary');
    setOut(<pre className="ro-out">{r.text.replace(/<[^>]+>/g, '')}</pre>);
  };
  const save = async () => {
    await api('/api/admin/connectors/telegram', {
      method: 'PUT',
      body: { enabled: f.enabled, token: f.token.trim(), chatId: f.chatId.trim(), events: EVENTS.map(([id]) => id).filter((id) => f.events.has(id)), summaryHour: Number(f.hour) || 19, personal: f.personal },
    });
    toast('Notifiche Telegram salvate');
    await onSaved();
  };
  const remove = async () => {
    if (!confirm('Rimuovere la configurazione Telegram?')) return;
    await api('/api/admin/connectors/telegram', { method: 'DELETE' });
    toast('Configurazione Telegram rimossa');
    await onSaved();
  };

  return (
    <Card
      title="Telegram"
      actions={
        <>
          <Badge tone={personalOn ? 'good' : 'neutral'}>{personalOn ? 'personali attive' : 'personali non attive'}</Badge>
          <Badge tone={nocOn ? 'good' : 'neutral'}>{nocOn ? 'NOC attivo' : 'NOC non attivo'}</Badge>
        </>
      }
    >
      <p className="ui-muted ui-small cn-p">Un solo bot: messaggi al gruppo del NOC e notifiche personali di ogni utente. Nei messaggi mai nome, indirizzo o posizione del cliente.</p>
      {t.updatedAt && (
        <p className="ui-muted ui-small cn-p">
          Ultima modifica {date(t.updatedAt)}
          {t.updatedBy ? ` · ${t.updatedBy}` : ''}
        </p>
      )}
      <details className="ui-details">
        <summary>Come si configura</summary>
        <ol className="ui-list ui-small">
          <li>Su Telegram apri @BotFather, comando /newbot: ottieni il token del bot.</li>
          <li>Incolla il token qui e salva: basta questo per le notifiche personali (ogni utente collega il proprio Telegram da Il mio account o dall’app).</li>
          <li>Facoltativo, per il NOC: aggiungi il bot al gruppo e scrivi un messaggio qualsiasi nel gruppo.</li>
          <li>Incolla il token qui, premi «Trova chat ID» e scegli il gruppo.</li>
          <li>Premi «Invia messaggio di prova», scegli gli eventi e salva.</li>
        </ol>
      </details>
      <Field label="Token del bot">
        <input type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} placeholder={t.tokenSet ? `Impostato (${t.tokenHint}): lascia vuoto per non cambiarlo` : '123456789:AA…'} />
      </Field>

      <section className="cn-sec">
        <h3>Notifiche personali degli utenti</h3>
        <label className="ui-check">
          <input type="checkbox" checked={f.personal} onChange={(e) => setF({ ...f, personal: e.target.checked })} />
          Ogni utente (amministratori e installatori) può collegare il proprio Telegram
        </label>
        <p className="ui-muted ui-small cn-p">Ricevono i guasti Enel delle proprie zone e dei POP/AP assegnati. Collegati ora: {t.personalLinked ?? 0}.</p>
      </section>

      <section className="cn-sec">
        <h3>Gruppo del NOC (facoltativo)</h3>
        <label className="ui-check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          Messaggi al gruppo del NOC attivi
        </label>
        <div className="ui-grid-form">
          <Field label="Chat ID del gruppo">
            <input inputMode="numeric" value={f.chatId} onChange={(e) => setF({ ...f, chatId: e.target.value })} placeholder="-1001234567890" />
          </Field>
          <Field label="Ora del riepilogo serale (0-23, ora italiana)">
            <input type="number" min={0} max={23} value={f.hour} onChange={(e) => setF({ ...f, hour: e.target.value })} />
          </Field>
        </div>
        <h4 className="cn-h4">Eventi del gruppo</h4>
        {EVENTS.map(([id, label, hint]) => (
          <label key={id} className="ui-check cn-event">
            <input
              type="checkbox"
              checked={f.events.has(id)}
              onChange={(e) => {
                const n = new Set(f.events);
                if (e.target.checked) n.add(id);
                else n.delete(id);
                setF({ ...f, events: n });
              }}
            />
            <span>
              <strong>{label}</strong>
              <span className="ui-muted ui-small"> · {hint}</span>
            </span>
          </label>
        ))}
        {t.publicUrl ? (
          <p className="ui-muted ui-small cn-p">I messaggi includono il link alla console: {t.publicUrl}</p>
        ) : (
          <p className="ui-muted ui-small cn-p">
            Per avere nei messaggi il link allo storico imposta l’indirizzo pubblico della console in <a href="#/server">Impostazioni server</a> (es. https://cpe.esempio.it).
          </p>
        )}
      </section>
      <div className="ui-row">
        <AsyncButton onClick={findChats} onError={fail}>
          Trova chat ID
        </AsyncButton>
        <AsyncButton onClick={sendTest} onError={fail}>
          Invia messaggio di prova
        </AsyncButton>
        <AsyncButton onClick={preview} onError={fail}>
          Anteprima riepilogo
        </AsyncButton>
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva
        </AsyncButton>
        {(t.configured || t.tokenSet) && (
          <AsyncButton variant="danger" onClick={remove} onError={fail}>
            Rimuovi
          </AsyncButton>
        )}
      </div>
      {out}
    </Card>
  );
}
