import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * Firmware airOS (admins): the reference images the app keeps on the phone to bring a CPE to the
 * version required by the provisioning. Platform and version are read from the file itself.
 */

interface Item {
  id: number;
  platform: string;
  version: string;
  build: string;
  filename: string;
  size: number;
  sha256: string;
  target: boolean;
  present: boolean;
  createdAt: string;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
const date = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export function Firmware() {
  const q = useQuery({ queryKey: ['admin', 'firmware'], queryFn: () => api<{ target: string; items: Item[] }>('/api/admin/firmware') });
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const d = q.data;
  const platforms = d ? [...new Set(d.items.filter((i) => i.target).map((i) => i.platform))] : [];

  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) throw new Error('Scegli il file .bin');
    const bytes = new Uint8Array(await f.arrayBuffer());
    const r = await api<{ item: Item }>(`/api/admin/firmware?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/x-airos-firmware' } });
    toast(`Caricato ${r.item.build}`, 'good');
    if (file.current) file.current.value = '';
    setName('');
    await q.refetch();
  };
  const remove = async (i: Item) => {
    if (!confirm(`Eliminare ${i.build}?`)) return;
    await api(`/api/admin/firmware/${i.id}`, { method: 'DELETE' });
    toast('Firmware eliminato');
    await q.refetch();
  };

  return (
    <div className="ui-page">
      <PageHeader icon="system_update" title="Firmware airOS" subtitle="Immagini per l’aggiornamento delle CPE dall’app." />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={5} />}
      {d && (
        <>
          <Card title="Carica un firmware">
            <p className="ui-muted ui-small fw-p">
              Versione richiesta dal provisioning: <strong>{d.target}</strong>. Carica il file .bin ufficiale airOS di ogni piattaforma usata dalle CPE (es. XC, WA, 2XC): la piattaforma e la versione si leggono dal file. Nell’app compaiono solo i firmware della versione richiesta; l’installatore li scarica con Internet e li installa sulla CPE dalla sua Wi-Fi di management.
            </p>
            <div className="ui-row">
              <label className="ui-btn ui-btn-secondary fw-file">
                <input ref={file} type="file" accept=".bin,application/octet-stream" onChange={(e) => setName(e.target.files?.[0]?.name ?? '')} />
                {name || 'Scegli il file .bin'}
              </label>
              <AsyncButton variant="primary" icon="system_update" onClick={upload} onError={fail} disabled={!name}>
                Carica firmware
              </AsyncButton>
            </div>
            <div className="ui-row">
              <span className="ui-small">Piattaforme pronte per {d.target}:</span>
              {platforms.length ? (
                platforms.map((p) => (
                  <Badge key={p} tone="good">
                    {p}
                  </Badge>
                ))
              ) : (
                <Badge tone="warn">nessun firmware {d.target}</Badge>
              )}
            </div>
          </Card>
          <Card padded={false} title="Firmware caricati">
            <Table
              rows={d.items}
              rowKey={(i) => i.id}
              empty="Nessun firmware caricato."
              columns={[
                { label: 'Piattaforma', render: (i) => <strong>{i.platform}</strong> },
                {
                  label: 'Versione',
                  render: (i) => (
                    <span className="ui-row">
                      {i.version} {i.target ? <Badge tone="good">richiesta</Badge> : <Badge>altra</Badge>}
                    </span>
                  ),
                },
                { label: 'Build', render: (i) => <code className="ui-small">{i.build}</code> },
                {
                  label: 'File',
                  render: (i) => (
                    <div>
                      {i.filename}
                      <div className="ui-muted ui-small">
                        {mb(i.size)} · SHA-256 {i.sha256.slice(0, 12)}…
                      </div>
                      {!i.present && <Badge tone="bad">file mancante</Badge>}
                    </div>
                  ),
                },
                { label: 'Caricato', render: (i) => date(i.createdAt) },
                {
                  label: '',
                  end: true,
                  render: (i) => (
                    <AsyncButton variant="danger" onClick={() => remove(i)} onError={fail}>
                      Elimina
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
