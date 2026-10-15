import { useState } from 'react';
import { StickerChip } from '../coverage/Operators';
import { api, download } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, Icon, Notice, PageHeader, Skeleton } from '../ui';

/**
 * Fattibilità (admins, for sales): one address, one answer. Our coverage (the same check as
 * Copertura: available, to verify with a survey, not covered), the speed a new customer gets in the
 * evening, the other operators with their AGCOM sticker, and the PDF for internal use.
 */

type Verdict = 'yes' | 'maybe' | 'no';
type Sticker = 'F' | 'FWA' | 'FR' | 'R';
interface Answer {
  address: string;
  point: { lat: number; lon: number; label: string };
  ours: {
    verdict: Verdict;
    title: string;
    eveningMbps: number | null;
    sticker: Sticker | null;
    stickerInfo: { label: string; color: string } | null;
    aps: Array<{ name: string; distanceM: number; bearing: number; rating: string; estimate: { signalDbm: number | null } | null; cpe?: { name: string } | null }>;
  };
  operators: { best: Sticker | null; groups: Array<{ sticker: Sticker; label: string; color: string; rows: Array<{ operator?: string; technologyLabel: string; state: string; maxMbps: number | null }> }> } | null;
  operatorsError: string | null;
}
const TONE: Record<Verdict, 'good' | 'warn' | 'bad'> = { yes: 'good', maybe: 'warn', no: 'bad' };
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${m} m`);
const speed = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} Gbit/s` : `${Math.round(m)} Mbit/s`);

export function Feasibility() {
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<Array<{ lat: number; lon: number; label: string }> | null>(null);
  const [point, setPoint] = useState<{ lat: number; lon: number; label: string } | null>(null);
  const [a, setA] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const query = (p: { lat: number; lon: number; label: string }) => new URLSearchParams({ lat: String(p.lat), lon: String(p.lon), label: p.label }).toString();

  const check = async (p: { lat: number; lon: number; label: string }) => {
    setPoint(p);
    setChoices(null);
    setA(null);
    setError(null);
    setLoading(true);
    try {
      setA(await api<Answer>(`/api/admin/feasibility?${query(p)}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const search = async () => {
    const t = text.trim();
    const coords = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(t);
    if (coords) return void check({ lat: Number(coords[1]!.replace(',', '.')), lon: Number(coords[2]!.replace(',', '.')), label: 'Coordinate inserite' });
    if (t.length < 3) throw new Error('Scrivi via, civico e comune');
    const list = await api<Array<{ lat: number; lon: number; label: string }>>(`/api/geocode?q=${encodeURIComponent(t)}`);
    if (!list.length) throw new Error('Indirizzo non trovato: aggiungi comune o CAP');
    if (list.length === 1) await check(list[0]!);
    else setChoices(list);
  };

  return (
    <div className="ui-page">
      <PageHeader icon="my_location" title="Fattibilità" subtitle="Un indirizzo, una risposta: se lo copriamo, con che velocità, e chi altro lo copre con quale bollino AGCOM." />
      <Card>
        <form className="cva-search" onSubmit={(e) => e.preventDefault()}>
          <label className="hl-search">
            <Icon name="search" />
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Via Roma 12, 94100 Enna · oppure coordinate 37.56, 14.28" aria-label="Indirizzo" autoComplete="off" />
          </label>
          <AsyncButton type="submit" variant="primary" onClick={search} onError={(e) => setError((e as Error).message)}>
            Verifica
          </AsyncButton>
        </form>
        {choices && (
          <div className="ui-row">
            {choices.map((c) => (
              <Button key={`${c.lat},${c.lon}`} onClick={() => void check(c)}>
                {c.label}
              </Button>
            ))}
          </div>
        )}
      </Card>
      {error && <Notice tone="bad">{error}</Notice>}
      {loading && <Skeleton lines={5} />}
      {a && point && (
        <>
          <Card
            title={a.address || point.label}
            actions={
              <AsyncButton onClick={() => download(`/api/admin/feasibility.pdf?${query(point)}`, 'fattibilita.pdf')} onError={(e) => toast((e as Error).message, 'bad')}>
                Scarica PDF
              </AsyncButton>
            }
          >
            <div className={`fz-verdict ui-tone-${TONE[a.ours.verdict]}`}>
              {a.ours.sticker && a.ours.stickerInfo ? <StickerChip s={a.ours.sticker} color={a.ours.stickerInfo.color} big /> : <span className="op-sticker big none">—</span>}
              <div>
                <strong>{a.ours.title}</strong>
                <div className="ui-small">
                  {[a.ours.eveningMbps != null ? `capacità stimata la sera circa ${a.ours.eveningMbps} Mbit/s` : null, a.ours.sticker ? `bollino ${a.ours.sticker} stimato` : null].filter(Boolean).join(' · ') || 'Nessun AP utile entro il raggio di copertura.'}
                </div>
              </div>
            </div>
            {a.ours.aps.length > 0 && (
              <ul className="hl-list">
                {a.ours.aps.map((x) => (
                  <li key={x.name} className="hl-row">
                    <div className="hl-main">
                      <div className="hl-name">
                        <strong>{x.name}</strong>
                        <Badge tone={x.rating === 'buono' ? 'good' : x.rating === 'possibile' ? 'warn' : x.rating === 'senza stima' ? 'neutral' : 'bad'}>{x.rating}</Badge>
                      </div>
                      <div className="hl-sub ui-small">
                        {[km(x.distanceM), `${x.bearing}°`, x.estimate?.signalDbm != null ? `${x.estimate.signalDbm} dBm stimati` : null, x.cpe?.name].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Altri operatori">
            {!a.operators ? (
              <p className="ui-muted ui-small">{a.operatorsError === 'operators_not_configured' ? 'La verifica degli altri operatori non è configurata (Connettori → MyWic).' : 'Verifica degli altri operatori non riuscita.'}</p>
            ) : (
              a.operators.groups
                .map((g) => ({ ...g, rows: g.rows.filter((r) => r.state !== 'none') }))
                .filter((g) => g.rows.length)
                .map((g) => (
                  <section key={g.sticker} className="op-group">
                    <h4 className="op-title">
                      <StickerChip s={g.sticker} color={g.color} /> {g.label}
                    </h4>
                    <ul className="hl-list">
                      {g.rows.map((r, i) => (
                        <li key={i} className="hl-row">
                          <div className="hl-main">
                            <div className="hl-name">
                              {r.operator && <strong>{r.operator}</strong>}
                              <span>{r.technologyLabel}</span>
                              <Badge tone={r.state === 'available' ? 'good' : 'warn'}>{r.state === 'available' ? 'attivabile' : 'in studio'}</Badge>
                            </div>
                            {r.maxMbps ? <div className="hl-sub ui-small">fino a {speed(r.maxMbps)}</div> : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
            )}
          </Card>
          <p className="ui-muted ui-small">Stime del modello di copertura e dati degli operatori: prima di promettere il servizio, la verifica sul posto resta necessaria quando l’esito è «da verificare».</p>
        </>
      )}
    </div>
  );
}
