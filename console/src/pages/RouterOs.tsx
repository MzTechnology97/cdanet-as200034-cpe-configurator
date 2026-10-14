import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { AsyncButton, Button, Card, Field, Notice, PageHeader, Skeleton, Stat } from '../ui';

/**
 * MikroTik · RouterOS: read-only queries over SSH from the server. The password stays in this page
 * only (memory), is sent with each request and never stored; "Dimentica password" clears it.
 */

interface Summary {
  identity?: string;
  version?: string;
  boardName?: string;
  uptime?: string;
  cpuLoad?: string;
  freeMemory?: string;
  currentFirmware?: string;
}
interface Answer {
  summary: Summary;
  note?: string;
  sections: Array<{ title: string; command: string; output: string }>;
}

export function RouterOs() {
  const catalog = useQuery({ queryKey: ['routeros', 'catalog'], queryFn: () => api<{ sections: Array<{ id: string; title: string }> }>('/api/routeros/catalog'), staleTime: Infinity });
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [command, setCommand] = useState('');
  const [answer, setAnswer] = useState<{ d?: Answer; error?: string; loading?: boolean } | null>(null);

  const run = async (action: string, cmd?: string) => {
    if (!host.trim() || !user.trim() || !pass) throw new Error('Host, username e password richiesti');
    setAnswer((a) => ({ ...a, loading: true, error: undefined }));
    try {
      const d = await api<Answer>('/api/routeros/action', { method: 'POST', body: { host: host.trim(), port: Number(port) || 22, username: user.trim(), password: pass, action, command: cmd } });
      setAnswer({ d });
    } catch (e) {
      setAnswer({ error: (e as Error).message });
    }
  };
  const fail = (e: unknown) => setAnswer({ error: (e as Error).message });
  const s = answer?.d?.summary;

  return (
    <div className="ui-page">
      <PageHeader icon="router" title="MikroTik · RouterOS" subtitle="Consultazione in sola lettura via SSH dal server. Le password restano solo in memoria per la singola richiesta." />
      <Card>
        <form className="ui-grid-form" onSubmit={(e) => e.preventDefault()} autoComplete="on">
          <Field label="Host / IP">
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.1" />
          </Field>
          <Field label="Porta SSH">
            <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
          <Field label="Username">
            <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" placeholder="admin" />
          </Field>
          <Field label="Password">
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
          </Field>
        </form>
        <div className="ui-row">
          <AsyncButton variant="primary" icon="router" onClick={() => run('dashboard')} onError={fail}>
            Connetti / Dashboard
          </AsyncButton>
          <AsyncButton onClick={async () => confirm('Generare cda-supout.rif sul router? Può contenere informazioni sensibili e resta nei Files del router.') && (await run('supout'))} onError={fail}>
            Genera supout.rif
          </AsyncButton>
          <Button
            variant="ghost"
            onClick={() => {
              setPass('');
              setAnswer(null);
            }}
          >
            Dimentica password
          </Button>
        </div>
      </Card>

      {s && (
        <section className="ui-stats" aria-label="Router">
          <Stat label="Identity" value={s.identity} />
          <Stat label="RouterOS" value={s.version} />
          <Stat label="Board" value={s.boardName} />
          <Stat label="Uptime" value={s.uptime} />
          <Stat label="CPU load" value={s.cpuLoad} />
          <Stat label="RAM libera" value={s.freeMemory} />
          <Stat label="Firmware" value={s.currentFirmware} />
        </section>
      )}

      <Card title="Sezioni">
        {catalog.error ? (
          <Notice tone="bad">{(catalog.error as Error).message}</Notice>
        ) : !catalog.data ? (
          <Skeleton lines={2} />
        ) : (
          <div className="ui-row">
            {catalog.data.sections.map((x) => (
              <AsyncButton key={x.id} onClick={() => run(x.id)} onError={fail}>
                {x.title}
              </AsyncButton>
            ))}
          </div>
        )}
        <form
          className="ro-term"
          onSubmit={(e) => {
            e.preventDefault();
            void run('terminal', command.trim()).catch(fail);
          }}
        >
          <Field label="Terminale (sola lettura)">
            <input className="ui-mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="/interface print detail without-paging" />
          </Field>
          <Button type="submit">Esegui</Button>
        </form>
      </Card>

      {answer?.loading && (
        <Card>
          <p className="ui-muted">Interrogazione RouterOS in corso…</p>
        </Card>
      )}
      {answer?.error && <Notice tone="bad">{answer.error}</Notice>}
      {answer?.d?.note && <Notice tone="warn">{answer.d.note}</Notice>}
      {answer?.d?.sections.map((x, i) => (
        <Card key={`${x.title}-${i}`} title={x.title}>
          <p className="ui-mono ui-small ui-muted ro-cmd">{x.command}</p>
          <pre className="ro-out">{x.output || 'Nessun dato'}</pre>
        </Card>
      ))}
    </div>
  );
}
