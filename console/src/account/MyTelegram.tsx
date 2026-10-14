import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Card, Field, Notice, Skeleton } from '../ui';

/**
 * Personal Telegram of the account (every user): the admin's bot writes to the user's own chat.
 * When it is not available, admins are told where to turn it on, installers whom to ask.
 */

interface Tg {
  available: boolean;
  reason?: 'no_bot' | 'personal_off' | 'module_off' | string;
  canConfigure?: boolean;
  linked?: boolean;
  chatHint?: string;
  outages?: boolean;
  planned?: boolean;
}
const KEY = ['account', 'telegram'];
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export function MyTelegram({ title = 'Notifiche Telegram', appHint = false }: { title?: string; appHint?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api<Tg>('/api/account/telegram') });
  const [link, setLink] = useState<{ url: string; bot: string; expiresInMin: number } | null>(null);
  const [chatId, setChatId] = useState('');
  const reload = async () => {
    setLink(null);
    await qc.invalidateQueries({ queryKey: KEY });
  };
  const t = q.data;
  const app = appHint && <p className="ui-muted ui-small mt-p">Sul telefono: app CDA Net → Guasti Enel → «Avvisami dei guasti» (notifiche anche ad app chiusa).</p>;
  if (q.error)
    return (
      <Card title={title}>
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      </Card>
    );
  if (!t)
    return (
      <Card title={title}>
        <Skeleton lines={2} />
      </Card>
    );
  const what = t.outages ? 'i guasti Enel nelle tue zone e sui POP/AP assegnati' : 'le notifiche che ti riguardano';

  if (!t.available) {
    const why =
      t.reason === 'no_bot' ? (
        t.canConfigure ? (
          <>
            Manca il bot Telegram: crealo con @BotFather e incolla il token in <a href="#/connectors">Connettori → Telegram</a>. Basta il token: il gruppo del NOC è facoltativo.
          </>
        ) : (
          'Le notifiche Telegram personali non sono ancora attive: chiedi all’amministratore di configurare il bot.'
        )
      ) : t.reason === 'personal_off' ? (
        t.canConfigure ? (
          <>
            Le notifiche personali sono disattivate: riattivale in <a href="#/connectors">Connettori → Telegram</a>.
          </>
        ) : (
          'L’amministratore ha disattivato le notifiche Telegram personali.'
        )
      ) : t.reason === 'module_off' ? (
        t.canConfigure ? (
          <>
            Il modulo Notifiche Telegram è spento: accendilo in <a href="#/modules">Funzionalità</a>.
          </>
        ) : (
          'Le notifiche Telegram non sono attive su questo server.'
        )
      ) : (
        'Le notifiche Telegram personali non sono attive.'
      );
    return (
      <Card title={title}>
        <p className="ui-muted ui-small mt-p">{why}</p>
        {app}
      </Card>
    );
  }

  if (t.linked) {
    return (
      <Card title={title}>
        <Notice tone="good">
          Telegram collegato (chat {t.chatHint}): ricevi qui {what}.
        </Notice>
        {t.outages && (
          <label className="ui-check">
            <input
              type="checkbox"
              checked={!!t.planned}
              onChange={(e) =>
                void api('/api/account/telegram', { method: 'PUT', body: { planned: e.target.checked } }).then(
                  () => (toast('Preferenza salvata'), reload()),
                  fail,
                )
              }
            />
            Anche i lavori programmati sui POP/AP assegnati (le aree di interesse hanno le loro regole)
          </label>
        )}
        <div className="ui-row">
          <AsyncButton
            variant="danger"
            onClick={async () => {
              await api('/api/account/telegram', { method: 'DELETE' });
              await reload();
            }}
            onError={fail}
          >
            Scollega Telegram
          </AsyncButton>
        </div>
        {app}
      </Card>
    );
  }

  return (
    <Card title={title}>
      <p className="ui-muted ui-small mt-p">Ricevi su Telegram {what}, con il bot del server.</p>
      <div className="ui-row">
        <AsyncButton variant="primary" onClick={async () => setLink(await api('/api/account/telegram/link', { method: 'POST', body: {} }))} onError={fail}>
          Collega Telegram
        </AsyncButton>
      </div>
      {link && (
        <>
          <ol className="ui-list ui-small">
            <li>
              Apri{' '}
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                @{link.bot}
              </a>{' '}
              su Telegram e premi <strong>Avvia</strong>.
            </li>
            <li>Torna qui e premi Verifica (entro {link.expiresInMin} minuti).</li>
          </ol>
          <div className="ui-row">
            <AsyncButton
              variant="primary"
              onClick={async () => {
                try {
                  await api('/api/account/telegram/verify', { method: 'POST', body: {} });
                } catch (e) {
                  if ((e as { body?: { error?: string } }).body?.error === 'start_not_found') throw new Error('Non trovo ancora il tuo messaggio: apri il bot, premi Avvia e riprova');
                  throw e;
                }
                toast('Telegram collegato');
                await reload();
              }}
              onError={fail}
            >
              Verifica
            </AsyncButton>
          </div>
        </>
      )}
      <div className="mt-inline">
        <Field label="Oppure il tuo ID Telegram" hint="Prima di usare l’ID scrivi almeno un messaggio al bot, altrimenti Telegram non gli permette di scriverti.">
          <input inputMode="numeric" placeholder="es. 123456789" value={chatId} onChange={(e) => setChatId(e.target.value)} />
        </Field>
        <AsyncButton
          onClick={async () => {
            await api('/api/account/telegram', { method: 'PUT', body: { chatId: chatId.trim() } });
            toast('Telegram collegato: ti è arrivato un messaggio di prova');
            setChatId('');
            await reload();
          }}
          onError={fail}
        >
          Usa questo ID
        </AsyncButton>
      </div>
      {app}
    </Card>
  );
}
