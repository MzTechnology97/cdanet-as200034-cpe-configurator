import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, EmptyState, Notice, PageHeader, Segmented, Skeleton, Table } from '../ui';

/**
 * «Connetti il tuo Claude» (admins): the address of the read-only MCP server of the platform, how to
 * add it to Claude (Desktop with mcp-remote while the server has no public certificate, the
 * connectors of Claude with a domain, Claude Code), what Claude can read, and every connection of
 * the admins with its use and the revoke. The consent itself is given on the platform's own page
 * (user, password and second step), never here.
 */

interface Mcp {
  url: string;
  tools: Array<{ name: string; title: string }>;
  connections: Array<{ id: number; username: string; client: string; createdAt: string; lastUsedAt: string | null; calls: number; revokedAt: string | null; active: boolean }>;
}
type Conn = Mcp['connections'][number];
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copiato`);
  } catch {
    toast('Copia non riuscita: seleziona il testo e copialo a mano', 'bad');
  }
}

export function Claude() {
  const q = useQuery({ queryKey: ['admin', 'mcp'], queryFn: () => api<Mcp>('/api/admin/mcp') });
  const me = useQuery({ queryKey: ['auth', 'account'], queryFn: () => api<{ username: string; totpEnabled: boolean }>('/api/auth/account') });
  const [show, setShow] = useState<'active' | 'all'>('active');
  const d = q.data;
  const revoke = async (c: Conn) => {
    if (!confirm(`Revocare la connessione di ${c.username} (${c.client})? Claude non potrà più leggere la piattaforma finché non si ricollega.`)) return;
    await api(`/api/admin/mcp/connections/${c.id}`, { method: 'DELETE' });
    toast('Connessione revocata');
    await q.refetch();
  };
  const rows = d ? d.connections.filter((c) => show === 'all' || c.active) : [];
  const desktop = d
    ? JSON.stringify({ mcpServers: { cdanet: { command: 'npx', args: ['-y', 'mcp-remote', d.url], env: { NODE_EXTRA_CA_CERTS: 'C:\\cdanet\\cdanet-ca.crt' } } } }, null, 2)
    : '';
  const code = d ? `claude mcp add --transport http cdanet ${d.url}` : '';
  return (
    <div className="ui-page">
      <PageHeader icon="monitor_heart" title="Connetti il tuo Claude" subtitle="Claude legge la piattaforma in sola lettura, per il monitoraggio: stato rete, interruzioni, batterie dei POP, avvisi, interventi, magazzino, diagnosi." />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={8} />}
      {me.data && !me.data.totpEnabled && (
        <Notice tone="bad">
          Per collegare Claude serve la verifica in due passaggi sul tuo account: attivala in <a href="#/account">Il mio account</a>.
        </Notice>
      )}
      {d && (
        <>
          <Card title="Indirizzo del connettore">
            <div className="mcp-url">
              <code className="ui-mono">{d.url}</code>
              <Button onClick={() => void copy(d.url, 'Indirizzo')}>Copia</Button>
            </div>
            <p className="ui-muted ui-small cn-p">
              Al primo uso Claude apre la pagina di consenso della piattaforma: utente, password e codice di verifica, poi «Consenti». La pagina dice dove tornerai (claude.ai o questo computer): se non è il posto da cui sei partito, annulla.
            </p>
          </Card>

          <Card title="Come collegarlo">
            <section className="cn-provider">
              <h3>Claude Desktop sul PC (server senza dominio pubblico)</h3>
              <p className="ui-muted ui-small cn-p">
                Il PC deve raggiungere il server (ufficio o VPN) e avere Node.js. Salva il certificato della piattaforma (sul server: <code>sudo cdanet-cpe https-ca</code>) per esempio in <code>C:\cdanet\cdanet-ca.crt</code>, poi in Claude Desktop → Impostazioni → Sviluppatore → «Modifica configurazione» aggiungi:
              </p>
              <pre className="mcp-pre">{desktop}</pre>
              <div className="ui-row">
                <Button onClick={() => void copy(desktop, 'Configurazione')}>Copia configurazione</Button>
              </div>
              <p className="ui-muted ui-small cn-p">Riavvia Claude Desktop. mcp-remote è un ponte open source di terze parti; funziona solo sul PC.</p>
            </section>
            <section className="cn-provider">
              <h3>Claude (web, Desktop e telefono) con un dominio e un certificato valido</h3>
              <p className="ui-muted ui-small cn-p">Impostazioni → Connettori → «Aggiungi connettore personalizzato» → incolla l’indirizzo qui sopra. Il connettore resta legato al tuo account Claude, anche nell’app del telefono.</p>
            </section>
            <section className="cn-provider">
              <h3>Claude Code</h3>
              <pre className="mcp-pre">{code}</pre>
              <div className="ui-row">
                <Button onClick={() => void copy(code, 'Comando')}>Copia comando</Button>
              </div>
            </section>
          </Card>

          <Card title="Cosa può leggere">
            <ul className="mcp-tools">
              {d.tools.map((t) => (
                <li key={t.name}>{t.title}</li>
              ))}
            </ul>
            <p className="ui-muted ui-small cn-p">
              Mai password, chiavi, token o segreti; mai telefoni, email o codici fiscali dei clienti; elenchi fino a 200 elementi. Ogni richiesta finisce nel Registro con il nome dello strumento. Quello che Claude legge passa da Anthropic: per i dati dei clienti serve l’accordo sul trattamento dei dati (DPA).
            </p>
          </Card>

          <Card
            title="Connessioni"
            actions={
              <Segmented
                label="Mostra"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'active', label: `Attive (${d.connections.filter((c) => c.active).length})` },
                  { value: 'all', label: 'Tutte' },
                ]}
              />
            }
          >
            {rows.length ? (
              <Table
                rows={rows}
                rowKey={(c) => c.id}
                columns={[
                  { label: 'Admin', render: (c) => <strong>{c.username}</strong> },
                  { label: 'Claude', render: (c) => c.client },
                  { label: 'Collegato', render: (c) => <span className="ui-small">{date(c.createdAt)}</span> },
                  { label: 'Ultimo uso', render: (c) => <span className="ui-small">{date(c.lastUsedAt)}</span> },
                  { label: 'Richieste', render: (c) => c.calls },
                  {
                    label: 'Stato',
                    render: (c) => (c.active ? <Badge tone="good">attiva</Badge> : c.revokedAt ? <Badge tone="neutral">{`revocata ${date(c.revokedAt)}`}</Badge> : <Badge tone="neutral">scaduta</Badge>),
                  },
                  {
                    label: '',
                    render: (c) =>
                      c.active ? (
                        <AsyncButton variant="danger" onClick={() => revoke(c)} onError={fail}>
                          Revoca
                        </AsyncButton>
                      ) : null,
                  },
                ]}
              />
            ) : (
              <EmptyState icon="link" title={show === 'active' ? 'Nessun Claude collegato' : 'Nessuna connessione'}>
                Le connessioni compaiono qui dopo il consenso. Una connessione cade da sola se l’admin viene disattivato, perde il ruolo, cambia password o toglie la verifica in due passaggi.
              </EmptyState>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
