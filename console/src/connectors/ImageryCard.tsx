import { useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Field, Notice } from '../ui';

/**
 * Connettori → Immagini satellitari: one or more providers of aerial imagery for the admins' maps.
 * Each one switched on appears in the layer switch of the maps, to compare them on the same place;
 * keys are sealed on the server and the tiles go through it.
 */

const ERRORS: Record<string, string> = {
  imagery_incomplete: 'Manca la chiave (o l’indirizzo del servizio).',
  imagery_unreachable: 'Servizio non raggiungibile dal server (DNS o firewall).',
  imagery_key_rejected: 'Chiave rifiutata: controlla che sia attiva, con il servizio abilitato e senza restrizioni di indirizzo.',
  imagery_region_unavailable: 'La chiave è valida, ma Google non fornisce le immagini satellitari della Map Tiles API agli account europei: usa Esri, Mapbox o l’ortofoto WMS.',
  imagery_error: 'Il servizio ha risposto con un errore.',
  imagery_empty: 'Nessuna immagine in quel punto (Sicilia centrale): controlla i layer.',
  imagery_not_configured: 'Non configurato.',
};
/** Providers with a key: name, where to get the key, what to enable. */
const KEYED: Array<['mapbox' | 'esri' | 'google', string, string, string]> = [
  ['mapbox', 'Mapbox', 'Token da account.mapbox.com → Tokens (il token pubblico predefinito va bene). Piano gratuito con un limite mensile di immagini.', 'pk.…'],
  ['esri', 'Esri (ArcGIS)', 'Chiave API da location.arcgis.com (ArcGIS Location Platform) → Developer credentials, con il privilegio «Basemaps». Piano gratuito con un limite mensile.', 'AAPK… / AAPT…'],
  ['google', 'Google', 'Chiave API da Google Cloud con la «Map Tiles API» attiva e un account di fatturazione. Attenzione: Google non fornisce le immagini satellitari di questa API agli account dello Spazio economico europeo (anche se la stessa chiave funziona in UISP, che usa un’altra API). Le condizioni di Google chiedono di mostrare il logo e l’attribuzione.', 'AIza…'],
];
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const apiError = (e: unknown) => {
  const err = e as Error & { body?: { error?: string; issues?: Array<{ message: string }> } };
  return new Error(ERRORS[err.body?.error ?? ''] ?? err.body?.issues?.[0]?.message ?? err.message);
};
const fail = (e: unknown) => toast((e as Error).message, 'bad');

interface Keyed {
  enabled: boolean;
  configured: boolean;
  keyHint?: string;
}
export interface Imagery {
  mapbox: Keyed;
  esri: Keyed;
  google: Keyed;
  wms: { enabled: boolean; configured: boolean; url: string; layers: string; label: string; attribution: string };
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** One provider: switched on or off, its settings, a test on central Sicily, save and remove. */
function Provider({ id, title, help, configured, on, body, children, onSaved }: { id: string; title: string; help: string; configured: boolean; on: boolean; body: () => object; children: React.ReactNode; onSaved: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(configured ? on : true);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  return (
    <section className="cn-provider">
      <h3>
        {title} {configured ? <Badge tone={on ? 'good' : 'neutral'}>{on ? 'attivo' : 'disattivato'}</Badge> : <Badge>non configurato</Badge>}
      </h3>
      <p className="ui-muted ui-small cn-p">{help}</p>
      <label className="ui-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Attivo
      </label>
      {children}
      <div className="ui-row">
        <AsyncButton
          onClick={async () => {
            try {
              setResult(await api(`/api/admin/connectors/imagery/${id}/test`, { method: 'POST', body: body() }));
            } catch (e) {
              throw apiError(e);
            }
          }}
          onError={fail}
        >
          Prova
        </AsyncButton>
        <AsyncButton
          variant="primary"
          onClick={async () => {
            try {
              await api(`/api/admin/connectors/imagery/${id}`, { method: 'PUT', body: { enabled, ...body() } });
            } catch (e) {
              throw apiError(e);
            }
            toast(enabled ? `${title}: attivo sulle mappe degli admin` : `${title}: salvato, disattivato`);
            await onSaved();
          }}
          onError={fail}
        >
          Salva
        </AsyncButton>
        {configured && (
          <AsyncButton
            variant="danger"
            onClick={async () => {
              if (!confirm(`Rimuovere ${title}? La chiave salvata viene cancellata dal server.`)) return;
              await api(`/api/admin/connectors/imagery/${id}`, { method: 'DELETE' });
              toast(`${title} rimosso`);
              await onSaved();
            }}
            onError={fail}
          >
            Rimuovi
          </AsyncButton>
        )}
      </div>
      {result && <Notice tone={result.ok ? 'good' : 'bad'}>{result.ok ? 'Immagini disponibili.' : (ERRORS[result.error ?? ''] ?? result.error)}</Notice>}
    </section>
  );
}

function KeyedProvider({ id, title, help, ph, p, onSaved }: { id: string; title: string; help: string; ph: string; p: Keyed; onSaved: () => Promise<void> }) {
  const [key, setKey] = useState('');
  return (
    <Provider id={id} title={title} help={help} configured={p.configured} on={p.enabled} body={() => (key.trim() ? { key: key.trim() } : {})} onSaved={onSaved}>
      <Field label="Chiave">
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.configured ? `Impostata (${p.keyHint}): lascia vuoto per non cambiarla` : ph} />
      </Field>
    </Provider>
  );
}

export function ImageryCard({ v, onSaved }: { v: Imagery; onSaved: () => Promise<void> }) {
  const w = v.wms;
  const [f, setF] = useState({ url: w.url, layers: w.layers, label: w.label, attribution: w.attribution });
  return (
    <Card title="Immagini satellitari">
      <p className="ui-muted ui-small cn-p">
        Foto aeree sulle mappe della console, solo per gli amministratori. Ogni fonte attiva compare nel selettore in alto a destra delle mappe (Satellite e Ibrida per fonte): attivane più di una per confrontarle sullo stesso punto, poi lascia accesa quella che preferisci. Le immagini passano dal server, le chiavi non arrivano mai ai browser e gli installatori vedono la mappa di sempre.
      </p>
      {v.updatedAt && (
        <p className="ui-muted ui-small cn-p">
          Ultima modifica {date(v.updatedAt)}
          {v.updatedBy ? ` da ${v.updatedBy}` : ''}
        </p>
      )}
      {KEYED.map(([id, title, help, ph]) => (
        <KeyedProvider key={id} id={id} title={title} help={help} ph={ph} p={v[id]} onSaved={onSaved} />
      ))}
      <Provider
        id="wms"
        title="Ortofoto pubbliche (WMS)"
        help="Servizio WMS senza chiave, in EPSG:3857: predefinite le ortofoto AGEA 2012 del Geoportale Nazionale. Si può mettere un altro WMS (per esempio le ortofoto regionali). Le foto compaiono da zoom 12; più lontano, e dove il servizio non ha la foto, si vede la mappa di base. Il server scarica in anticipo le foto attorno agli AP (ogni notte, solo quelle che mancano)."
        configured={w.configured}
        on={w.enabled}
        body={() => ({ url: f.url.trim(), layers: f.layers.trim(), label: f.label.trim(), attribution: f.attribution.trim() })}
        onSaved={onSaved}
      >
        <Field label="Indirizzo WMS">
          <input value={f.url} inputMode="url" autoComplete="off" onChange={(e) => setF({ ...f, url: e.target.value })} />
        </Field>
        <div className="ui-grid-form">
          <Field label="Layer">
            <input value={f.layers} autoComplete="off" onChange={(e) => setF({ ...f, layers: e.target.value })} />
          </Field>
          <Field label="Nome sulla mappa">
            <input value={f.label} maxLength={60} onChange={(e) => setF({ ...f, label: e.target.value })} />
          </Field>
        </div>
        <Field label="Attribuzione">
          <input value={f.attribution} maxLength={200} onChange={(e) => setF({ ...f, attribution: e.target.value })} />
        </Field>
      </Provider>
    </Card>
  );
}
