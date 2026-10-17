import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { OperatorsCard } from '../coverage/Operators';
import { OpenedCheck, SaveCheckButton, SavedChecksCard, type SavedCheck } from '../coverage/SavedChecks';
import { type Ap, dec, EstimateCell, km, LoadCell, type Point, type Profile, RATING, type Result, type Tone } from '../coverage/parts';
import { toast } from '../lib/toast';
import { drawCoverage, MAP_COLORS as C } from '../map/leaflet';
import { DECLINATION_DEG, SignalBar } from '../coverage/link';
import { api } from '../lib/api';
import { MapView } from '../map/MapView';
import { CoverageAdmin, LinkCharts } from './CoverageAdmin';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, Field, Icon, Notice, PageHeader, Skeleton } from '../ui';

/**
 * Copertura. Installers: the APs advised for an address, coordinates or this device's position
 * (only their assigned APs, within the limits of Impostazioni server, as approximate areas), and the
 * link with one of them: pointing, tilt, expected signal and the terrain profile. A check is saved
 * with a name written (the customer, the job) and taken up again from «Verifiche salvate». Admins:
 * the full page with the map of every AP and the radio simulation (CoverageAdmin).
 */

export function Coverage({ user }: PageContext) {
  return user.role === 'admin' ? <CoverageAdmin /> : <InstallerCoverage />;
}

function InstallerCoverage() {
  const [addr, setAddr] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [choices, setChoices] = useState<Array<{ lat: number; lon: number; label: string }> | null>(null);
  const [cpe, setCpe] = useState('auto');
  const [height, setHeight] = useState('');
  const [models, setModels] = useState<NonNullable<Result['cpeModels']>>([]);
  const [point, setPoint] = useState<Point | null>(null);
  const [result, setResult] = useState<{ r?: Result; loading?: boolean; error?: string } | null>(null);
  const [link, setLink] = useState<{ a: Ap; p?: Profile; error?: string } | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  // the saved checks: the list reads itself again after a save; the one opened from it
  const [version, setVersion] = useState(0);
  const [opened, setOpened] = useState<SavedCheck | null>(null);
  const linkRef = useRef<HTMLDivElement>(null);
  // the latest choices, for a check started by a change (no waiting for a render)
  const cur = useRef({ cpe, height, link });
  cur.current = { cpe, height, link };

  async function check(la: number, lo: number, label: string, over: { cpe?: string; height?: string } = {}) {
    const o = { ...cur.current, ...over };
    setPoint({ la, lo, label });
    setResult({ loading: true });
    try {
      const hM = Number(o.height);
      const r = await api<Result>(`/api/coverage?lat=${la}&lon=${lo}&cpe=${encodeURIComponent(o.cpe)}${hM >= 1 ? `&height=${hM}` : ''}`);
      if (r.cpeModels?.length) setModels((m) => (m.length ? m : r.cpeModels!));
      setResult({ r });
      // the open link follows the check (another CPE or height), closed for a new place
      const again = o.link ? r.aps.find((x) => x.id === o.link!.a.id) : null;
      if (again) void openLink(again, { la, lo, label }, o.height);
      else setLink(null);
    } catch (e) {
      setResult({ error: (e as Error).message });
    }
  }

  /** The link with one AP, as in UISP Design: the figures, the CPE, the signal and the profile. */
  async function openLink(a: Ap, at: Point | null = point, h: string = cur.current.height) {
    if (!at) return;
    setLink({ a });
    requestAnimationFrame(() => linkRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    try {
      const hM = Number(h);
      const p = await api<Profile>(`/api/pointing/profile?lat=${at.la}&lon=${at.lo}&apId=${encodeURIComponent(a.id)}${hM >= 1 ? `&height=${hM}` : ''}`);
      setLink({ a, p });
    } catch (e) {
      setLink({ a, error: (e as Error).message });
    }
  }

  const findAddress = async () => {
    setOpened(null);
    const list = await api<Array<{ lat: number; lon: number; label: string }>>(`/api/geocode?q=${encodeURIComponent(addr)}`);
    setChoices(list);
    if (list.length === 1) await check(list[0]!.lat, list[0]!.lon, list[0]!.label);
  };
  const checkCoords = (e: FormEvent) => {
    e.preventDefault();
    setOpened(null);
    const la = Number(lat.replace(',', '.'));
    const lo = Number(lon.replace(',', '.'));
    if (!lat || !lon || !Number.isFinite(la) || !Number.isFinite(lo)) return void setResult({ error: 'Coordinate non valide' });
    void check(la, lo, 'Coordinate inserite');
  };
  const gps = () => {
    if (!('geolocation' in navigator) || !window.isSecureContext) return void setResult({ error: 'Il browser consente la posizione solo su HTTPS: usa l’indirizzo, le coordinate o l’app Android.' });
    setGpsBusy(true);
    setOpened(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGpsBusy(false);
        setLat(p.coords.latitude.toFixed(6));
        setLon(p.coords.longitude.toFixed(6));
        void check(p.coords.latitude, p.coords.longitude, `Posizione del dispositivo (±${Math.round(p.coords.accuracy)} m)`);
      },
      (err) => {
        setGpsBusy(false);
        setResult({ error: `Posizione non disponibile: ${err.message}` });
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  // another model or height: the same place checked again
  const recheck = (over: { cpe?: string; height?: string }) => point && void check(point.la, point.lo, point.label, over);

  const r = result?.r;
  return (
    <div className="ui-page">
      <PageHeader icon="explore" title="Copertura" subtitle="Gli AP consigliati per un indirizzo o una posizione: prima quelli con il segnale stimato migliore, con distanza e direzione di puntamento, entro il raggio configurato." />
      <div className="ui-grid-2">
        <Card title="Da indirizzo">
          <form
            className="cv-form"
            // Enter in the field presses the submit button, which runs the search
            onSubmit={(e) => e.preventDefault()}
          >
            <Field label="Indirizzo (via, civico, CAP, comune)">
              <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Via Roma 12, 94100 Enna" autoComplete="off" />
            </Field>
            <AsyncButton type="submit" variant="primary" icon="search" onClick={findAddress} onError={(e) => toast((e as Error).message, 'bad')}>
              Cerca indirizzo
            </AsyncButton>
          </form>
          {choices &&
            (choices.length ? (
              choices.length > 1 && (
                <div className="ui-row">
                  {choices.map((c) => (
                    <Button key={`${c.lat},${c.lon}`} onClick={() => (setLat(String(c.lat)), setLon(String(c.lon)), void check(c.lat, c.lon, c.label))}>
                      {c.label}
                    </Button>
                  ))}
                </div>
              )
            ) : (
              <Notice tone="warn">Indirizzo non trovato: prova ad aggiungere comune o CAP.</Notice>
            ))}
        </Card>
        <Card title="Da coordinate o GPS">
          <form className="cv-form" onSubmit={checkCoords}>
            <div className="ui-grid-form">
              <Field label="Latitudine">
                <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" placeholder="37.5671" />
              </Field>
              <Field label="Longitudine">
                <input value={lon} onChange={(e) => setLon(e.target.value)} inputMode="decimal" placeholder="14.2790" />
              </Field>
            </div>
            <div className="ui-row">
              <Button type="submit">Verifica coordinate</Button>
              <Button icon="my_location" busy={gpsBusy} onClick={gps}>
                Usa la posizione di questo dispositivo
              </Button>
            </div>
          </form>
        </Card>
      </div>
      <Card title="CPE da installare">
        <div className="ui-grid-form">
          <Field label="Modello">
            <select
              value={cpe}
              onChange={(e) => {
                setCpe(e.target.value);
                recheck({ cpe: e.target.value });
              }}
            >
              <option value="auto">Consigliata per ogni AP</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.gainDbi} dBi
                </option>
              ))}
            </select>
          </Field>
          <Field label="Altezza dal suolo (m)">
            <input type="number" min={1} max={60} step={1} inputMode="decimal" placeholder="predefinita" value={height} onChange={(e) => setHeight(e.target.value)} onBlur={(e) => recheck({ height: e.target.value })} />
          </Field>
        </div>
        <p className="ui-muted ui-small">Con «Consigliata» per ogni AP viene proposta la CPE più piccola che dà un buon segnale. Il modello e l’altezza cambiano il segnale atteso e la visibilità.</p>
      </Card>

      {result?.loading && (
        <Card>
          <Skeleton lines={4} />
        </Card>
      )}
      {result?.error && <Notice tone="bad">{result.error}</Notice>}
      {opened && point && opened.point.lat === point.la && opened.point.lon === point.lo && <OpenedCheck c={opened} onClose={() => setOpened(null)} />}
      {r && point && (
        <Results
          r={r}
          point={point}
          onLink={(a) => void openLink(a)}
          openId={link?.a.id ?? null}
          actions={
            <SaveCheckButton
              kind="coverage"
              point={{ lat: point.la, lon: point.lo, label: point.label }}
              params={{ cpe, ...(Number(height) >= 1 && Number(height) <= 100 ? { height: Number(height) } : {}) }}
              admin={false}
              onSaved={() => setVersion((v) => v + 1)}
            />
          }
        />
      )}
      {point && <OperatorsCard key={`${point.la},${point.lo}`} point={point} admin={false} />}
      <div ref={linkRef}>{link && point && <LinkCard link={link} onHeight={(v) => (setHeight(v), recheck({ height: v }))} />}</div>
      <SavedChecksCard
        kind="coverage"
        admin={false}
        version={version}
        onOpen={(c) => {
          // the same point with the same CPE and height, the other operators with it
          const o = { cpe: c.params.cpe ?? 'auto', height: c.params.height ? String(c.params.height) : '' };
          setCpe(o.cpe);
          setHeight(o.height);
          setOpened(c);
          window.scrollTo({ top: 0, behavior: 'smooth' });
          void check(c.point.lat, c.point.lon, c.point.label || c.name, o);
        }}
      />
    </div>
  );
}

/** The APs advised for the point: the map, then one row each (a tap opens the link). */
function Results({ r, point, onLink, openId, actions }: { r: Result; point: Point; onLink: (a: Ap) => void; openId: string | null; actions?: ReactNode }) {
  const restricted = r.aps.some((a) => a.approx);
  return (
    <Card title="AP consigliati" padded={!r.aps.length} actions={actions}>
      <div className={r.aps.length ? 'cv-pad' : undefined}>
        <p className="ui-muted ui-small">
          {point.label} · {point.la.toFixed(5)}, {point.lo.toFixed(5)}
        </p>
        {!r.aps.length && (
          <Notice tone="warn">
            {r.restricted && !r.assignedCount
              ? 'Nessun POP/AP assegnato al tuo account: chiedi all’amministratore.'
              : r.hiddenWeak
                ? `Nessun AP con segnale stimato migliore di ${r.hideBelowDbm} dBm: ${r.hiddenWeak === 1 ? 'l’unico AP utile è più debole' : `${r.hiddenWeak} AP sono più deboli`} e non ${r.hiddenWeak === 1 ? 'viene mostrato' : 'vengono mostrati'}.`
                : r.discarded
                  ? `Nessun AP utilizzabile: ${r.discarded === 1 ? 'l’unico AP' : `tutti i ${r.discarded} AP`} entro ${r.maxKm} km ${r.discarded === 1 ? 'ha' : 'hanno'} un segnale stimato insufficiente o non ${r.discarded === 1 ? 'è attivo' : 'sono attivi'}.`
                  : `Nessun AP${r.restricted ? ' tra quelli assegnati' : ''} entro ${r.maxKm} km da questo punto.`}
          </Notice>
        )}
      </div>
      {r.aps.length > 0 && (
        <>
          <div className="cv-pad">
            <MapView
              zoom={13}
              center={[point.la, point.lo]}
              deps={[r, point]}
              draw={(target) => drawCoverage(target, point.la, point.lo, r.aps)}
              legendItems={[
                [C.point, 'Punto verificato'],
                [C.ap, restricted ? 'AP online' : 'AP online (tratteggio: area già servita dai clienti)'],
                [C.impacted, 'AP non attivo'],
              ]}
            />
            {restricted && <p className="ui-muted ui-small">Gli AP sono mostrati come area approssimativa; la linea indica la direzione di puntamento.</p>}
          </div>
          <ul className="hl-list cv-aps">
            {r.aps.map((a) => (
              <li key={a.id} className={`hl-row cv-ap${openId === a.id ? ' selected' : ''}`} role="button" tabIndex={0} onClick={() => onLink(a)} onKeyDown={(e) => e.key === 'Enter' && onLink(a)}>
                <div className="hl-main">
                  <div className="hl-name">
                    {a.rating && <Badge tone={RATING[a.rating]?.[1] ?? 'neutral'}>{RATING[a.rating]?.[0] ?? a.rating}</Badge>}
                    <strong>{a.name || a.id}</strong>
                    {a.ssid && <span className="ui-muted ui-small ui-mono">{a.ssid}</span>}
                    <Badge tone={a.status === 'active' ? 'good' : 'bad'}>{a.status === 'active' ? 'online' : a.status}</Badge>
                  </div>
                  <div className="cv-facts">
                    <span>
                      <span className="cv-arrow" style={{ transform: `rotate(${a.bearing}deg)` }} aria-hidden="true">
                        ↑
                      </span>{' '}
                      {a.bearing}° {a.direction} · {km(a.distanceM)}
                    </span>
                    {a.stations != null && <span>{a.stations} client</span>}
                    {a.cpe && (
                      <span>
                        CPE {a.cpe.name} · {a.cpe.gainDbi} dBi{a.cpe.auto && a.cpe.proposed ? ' · consigliata' : ''}
                      </span>
                    )}
                    {a.siteName && <span className="ui-muted">{a.siteName}</span>}
                  </div>
                  <div className="cv-cells">
                    <EstimateCell e={a.estimate} />
                    <LoadCell l={a.load} />
                  </div>
                  {!!a.failures && (
                    <div className="ui-small">
                      {a.failures} {a.failures === 1 ? 'installazione fallita' : 'installazioni fallite'} qui vicino verso questo AP
                    </div>
                  )}
                </div>
                <Icon name="chevron_right" />
              </li>
            ))}
          </ul>
          <div className="cv-pad">
            <p className="ui-muted ui-small">
              Tocca un AP per il collegamento: puntamento, inclinazione, CPE consigliata, segnale atteso e profilo. Ordinati dal segnale stimato migliore (minimo per il collaudo: {r.minSignalDbm} dBm); a parità, il più vicino. {r.inRange} AP valutati entro {r.maxKm} km
              {r.discarded ? `, ${r.discarded} scartati perché non attivi o con segnale stimato insufficiente` : ''}
              {r.hiddenWeak ? `, ${r.hiddenWeak} non mostrati perché più deboli di ${r.hideBelowDbm} dBm` : ''}
              {r.aps.length < r.inRange - (r.discarded ?? 0) - (r.hiddenWeak ?? 0) ? `, mostrati i primi ${r.aps.length}` : ''}.
            </p>
            <p className="ui-muted ui-small">Il puntamento è l’azimut dalla posizione della CPE verso l’AP (0° = nord, senso orario). La copertura effettiva dipende da visibilità ottica, ostacoli e allineamento.</p>
          </div>
        </>
      )}
    </Card>
  );
}

/** The link with one AP: verdict, figures, CPE height, expected modulation and the profile. */
function LinkCard({ link, onHeight }: { link: { a: Ap; p?: Profile; error?: string }; onHeight: (v: string) => void }) {
  const { a, p } = link;
  const title = `Collegamento con ${a.name || a.id}`;
  if (link.error)
    return (
      <Card title={title}>
        <Notice tone="bad">{link.error}</Notice>
      </Card>
    );
  if (!p)
    return (
      <Card title={title}>
        <Skeleton lines={4} />
      </Card>
    );
  const first = p.chart[0]!;
  const end = p.chart[p.chart.length - 1]!;
  const tilt = (Math.atan2(end.los - first.los, p.distanceM) * 180) / Math.PI;
  // over 100%: the line clears the zone with room to spare, still 100% free
  const free = p.worst ? Math.min(100, Math.max(0, Math.round((100 * p.worst.clearanceM) / (p.worst.fresnel60M / 0.6 || 1)))) : 100;
  const verdict: [string, Tone] = p.verdict === 'clear' ? ['Linea libera', 'good'] : p.verdict === 'fresnel' ? ['Fresnel invasa', 'warn'] : [p.buildings ? 'Ostruita da edifici' : 'Ostruita dal terreno', 'bad'];
  const hM = Math.round(first.los - first.ground);
  const fact = (label: string, value: ReactNode, sub?: ReactNode) => (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {sub && <span className="cv-sub">{sub}</span>}
      </dd>
    </div>
  );
  return (
    <Card title={title} actions={<Badge tone={verdict[1]}>{verdict[0]}</Badge>}>
      <dl className="ui-facts">
        {fact('Distanza', km(a.distanceM))}
        {fact('Puntamento', `${a.bearing}° ${a.direction}`, `magnetico ${Math.round((a.bearing - DECLINATION_DEG + 360) % 360)}° · inclinazione ${tilt >= 0 ? '+' : ''}${Math.round(tilt * 10) / 10}°`)}
        {fact('Fresnel libera', `${free}%`, p.worst ? `punto critico a ${km(Math.round(p.worst.d / 50) * 50)}` : 'su tutto il collegamento')}
        {a.estimate?.capacityMbps != null && fact('Capacità stimata', `${a.estimate.capacityMbps} Mbit/s`, a.estimate.eveningMbps != null ? `la sera ~${a.estimate.eveningMbps} Mbit/s` : undefined)}
        {a.cpe && fact('CPE', a.cpe.name, `${a.cpe.gainDbi} dBi${a.cpe.auto && a.cpe.proposed ? ' · consigliata' : ''}`)}
        <div>
          <dt>Altezza CPE</dt>
          <dd className="cv-stepper">
            <button type="button" aria-label="Più bassa" onClick={() => onHeight(String(Math.max(1, hM - 1)))}>
              −
            </button>
            <strong>{hM} m</strong>
            <button type="button" aria-label="Più alta" onClick={() => onHeight(String(Math.min(60, hM + 1)))}>
              +
            </button>
          </dd>
        </div>
      </dl>
      {!!p.roofM && (
        <p className="ui-muted ui-small">
          Sul tetto: edificio di circa {p.roofM} m, antenna a {dec(p.mountedM ?? 0)} m dal suolo.
        </p>
      )}
      <SignalBar e={a.estimate} />
      <LinkCharts p={p} />
      <p className="ui-muted ui-small">
        {p.verdict === 'clear'
          ? 'Profilo del terreno con edifici e alberi; verifica sempre a vista sul posto.'
          : (p.raiseCpeM ?? 0) > 0 && (p.raiseCpeM ?? 0) <= 15
            ? `Alzando la CPE di ${Math.round((p.raiseCpeM ?? 0) * 10) / 10} m si libera la linea.`
            : 'Con questo AP la linea non si libera alzando la CPE: valuta un altro AP o un altro punto della casa.'}
      </p>
    </Card>
  );
}

