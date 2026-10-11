import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton, Stat } from '../ui';

/** Every component of the console in one page (admins, #/ui): switch theme to check both. */
export function UiShowcase() {
  const [view, setView] = useState<'all' | 'online' | 'offline'>('all');
  const [stat, setStat] = useState('all');
  return (
    <div className="ui-page">
      <PageHeader icon="handyman" title="Componenti" subtitle="I componenti della console nei due temi: cambia tema dalla barra in alto." actions={<Button variant="primary" icon="add_circle">Azione principale</Button>} />
      <div className="ui-stats">
        <Stat label="Tutte" value={631} active={stat === 'all'} onClick={() => setStat('all')} />
        <Stat label="Online" value={590} tone="good" active={stat === 'on'} onClick={() => setStat('on')} />
        <Stat label="Offline" value={33} tone="bad" active={stat === 'off'} onClick={() => setStat('off')} />
        <Stat label="Problemi" value={57} tone="warn" hint="5 critici" active={stat === 'pb'} onClick={() => setStat('pb')} />
      </div>
      <div className="ui-grid-2">
        <Card title="Pulsanti" actions={<Button variant="ghost" icon="refresh">Aggiorna</Button>}>
          <div className="ui-row">
            <Button variant="primary">Primario</Button>
            <Button>Secondario</Button>
            <Button variant="ghost">Leggero</Button>
            <Button variant="danger">Elimina</Button>
            <Button busy>In corso</Button>
            <Button disabled>Disattivato</Button>
          </div>
        </Card>
        <Card title="Stati">
          <div className="ui-row">
            <Badge tone="good">online</Badge>
            <Badge tone="warn">da guardare</Badge>
            <Badge tone="bad">critico</Badge>
            <Badge tone="info">informazione</Badge>
            <Badge tone="brand">nuovo</Badge>
            <Badge>neutro</Badge>
          </div>
          <Segmented label="Vista" value={view} onChange={setView} options={[{ value: 'all', label: 'Tutte' }, { value: 'online', label: 'Online' }, { value: 'offline', label: 'Offline' }]} />
        </Card>
        <Card title="Moduli">
          <Field label="Nome della zona" hint="Come la vedranno gli installatori">
            <input placeholder="es. Centro Enna" />
          </Field>
          <Field label="Raggio" error="Tra 0,2 e 50 km">
            <input defaultValue="80" inputMode="decimal" />
          </Field>
          <Field label="Tipo">
            <select defaultValue="mt">
              <option value="mt">Guasto media tensione</option>
              <option value="bt">Guasto bassa tensione</option>
            </select>
          </Field>
        </Card>
        <Card title="Avvisi">
          <Notice tone="good" title="Salvato">Le impostazioni valgono da subito.</Notice>
          <Notice tone="warn" title="Da controllare">3 AP senza azimut in UISP.</Notice>
          <Notice tone="bad" title="Errore">UISP non raggiungibile.</Notice>
          <Notice tone="info">L’analisi riparte ogni ora.</Notice>
        </Card>
        <Card title="Caricamento">
          <Skeleton lines={4} />
        </Card>
        <Card title="Vuoto">
          <EmptyState title="Nessun problema aperto">Gli avvisi nuovi compaiono qui.</EmptyState>
        </Card>
      </div>
    </div>
  );
}
