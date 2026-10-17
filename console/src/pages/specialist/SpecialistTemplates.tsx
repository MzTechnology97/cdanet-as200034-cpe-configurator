import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { downloadText, type Facts, type FieldDef, FormField, modeText, type Section, SECTIONS, type Value } from '../../templates/form';
import { AsyncButton, Badge, Button, Card, Drawer, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton, Tabs } from '../../ui';
import { date, FROM_TEXT, type SpecPlaceholder, type SpecTemplate } from './types';

/**
 * I miei template: the specialist's airOS templates for the companies he works for, apart from
 * CDA Net's (which stay as they are). The same form as the CPE's web interface; the text is the
 * whole truth (no value forced by the server, VLANs allowed) and besides CDA Net's placeholders he
 * may write his own (${VLAN_ID}…), typed in the app for each CPE like the Wi-Fi key. Made here or
 * in the app; used by the Specialist flow of the app.
 */

const fail = (e: unknown) => toast((e as Error).message, 'bad');

interface FormData {
  fields: FieldDef[];
  placeholders: SpecPlaceholder[];
  models: string[];
  boardMatch: Record<string, string>;
  targetFirmware: string;
}
interface Report {
  ok: boolean;
  errors: string[];
  warnings: string[];
  placeholders: string[];
  own: string[];
  lines: number;
}
interface FormState {
  template: string;
  values: Record<string, Value>;
  missing: string[];
  facts: Facts;
  report: Report;
}
interface EditorOpts {
  model: string;
  id?: number;
  name?: string;
  notes?: string;
  template?: string;
  boardMatch?: string;
  snmpSet?: boolean;
  updatedAt?: string;
  sha256?: string;
  /** Made from a backup: what was replaced with placeholders. */
  fromBackup?: { warnings: string[]; replacements: Array<{ line: number; key: string; original: string; placeholder: string }> };
}
type Tab = Section | 'values' | 'advanced';

const ERRORS: Record<string, string> = {
  template_size: 'Dimensione non valida (minimo 64 caratteri)',
  profile_not_system_cfg: 'Non sembra una configurazione airOS (mancano radio./wireless./netconf./users.)',
  profile_contains_nul: 'Contiene byte NUL',
  invalid_placeholders: 'Segnaposto non validi: ${NOME} con lettere maiuscole, cifre e _ (inizia con una lettera)',
  too_many_placeholders: 'Troppi segnaposto (al massimo 40)',
  users_password_requires_hash_placeholder: 'users.N.password deve usare ${CPE_PASSWORD_HASH}, non ${CPE_PASSWORD}',
  non_key_value_lines: 'Alcune righe non sono nel formato chiave=valore',
};
const errText = (c: string) => ERRORS[c] ?? c;

export function SpecialistTemplates() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['specialist', 'templates'], queryFn: () => api<SpecTemplate[]>('/api/specialist/templates') });
  const form = useQuery({ queryKey: ['specialist', 'template-form'], queryFn: () => api<FormData>('/api/specialist/template-form'), staleTime: 10 * 60_000 });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EditorOpts | null>(null);
  const [dirty, setDirty] = useState(false);
  const reload = () => qc.invalidateQueries({ queryKey: ['specialist'] });
  const open = async (t: SpecTemplate) => {
    const full = await api<SpecTemplate>(`/api/specialist/templates/${t.id}`);
    setEditing({ model: full.model, id: full.id, name: full.name, notes: full.notes, template: full.template, boardMatch: full.boardMatch, snmpSet: full.secretsSet.snmpCommunity, updatedAt: full.updatedAt, sha256: full.sha256 });
  };
  const remove = async (t: SpecTemplate) => {
    if (!confirm(`Eliminare il template «${t.name}» (${t.model})? Le installazioni fatte con esso restano nello storico.`)) return;
    await api(`/api/specialist/templates/${t.id}`, { method: 'DELETE' });
    toast('Template eliminato');
    await reload();
  };
  const close = () => {
    if (dirty && !confirm('Uscire senza salvare le modifiche?')) return;
    setDirty(false);
    setEditing(null);
  };

  if (form.error) return <Notice tone="bad">{(form.error as Error).message}</Notice>;
  if (editing && form.data) {
    return (
      <div className="ui-page">
        <PageHeader
          icon="memory"
          title="I miei template"
          actions={
            <Button icon="chevron_left" onClick={close}>
              Torna all’elenco
            </Button>
          }
        />
        <TemplateEditor
          key={`${editing.id ?? 'new'}-${editing.model}`}
          opts={editing}
          data={form.data}
          onDirty={setDirty}
          onClose={close}
          onSaved={async (t) => {
            setDirty(false);
            await reload();
            setEditing({ model: t.model, id: t.id, name: t.name, notes: t.notes, template: t.template, boardMatch: t.boardMatch, snmpSet: t.secretsSet.snmpCommunity, updatedAt: t.updatedAt, sha256: t.sha256 });
          }}
        />
      </div>
    );
  }

  const models = form.data?.models ?? [];
  const rows = list.data ?? [];
  return (
    <div className="ui-page">
      <PageHeader
        icon="memory"
        title="I miei template"
        subtitle="I template airOS delle aziende per cui lavori, tuoi e separati da quelli di CDA Net (che restano come sono). Li usi nel flusso Specialist dell’app; li crei e modifichi qui o dall’app."
        actions={
          <Button variant="primary" icon="add_circle" onClick={() => setCreating(true)} disabled={!form.data}>
            Nuovo template
          </Button>
        }
      />
      {list.error ? (
        <Notice tone="bad">{(list.error as Error).message}</Notice>
      ) : !list.data ? (
        <Skeleton lines={5} />
      ) : !rows.length ? (
        <Card>
          <EmptyState icon="memory" title="Nessun template">
            Crea il primo: dal modulo (come l’interfaccia della CPE), dal backup di una CPE configurata (.cfg) o partendo da un template CDA Net. Dall’app puoi anche crearlo dalla CPE collegata.
          </EmptyState>
        </Card>
      ) : (
        <div className="ui-grid-2">
          {[...new Set([...models, ...rows.map((t) => t.model)])]
            .filter((m) => rows.some((t) => t.model === m))
            .map((m) => (
              <Card key={m} title={m} padded={false}>
                <ul className="hl-list">
                  {rows
                    .filter((t) => t.model === m)
                    .map((t) => (
                      <li key={t.id} className="hl-row">
                        <div className="hl-main">
                          <div className="hl-name">
                            <strong>{t.name}</strong>
                            {t.own.map((p) => (
                              <Badge key={p} tone="info">{`\${${p}}`}</Badge>
                            ))}
                          </div>
                          <span className="ui-muted ui-small">
                            {modeText(t.facts)} · LAN {t.facts.lanIp ?? '—'} · {t.jobs} {t.jobs === 1 ? 'installazione' : 'installazioni'} · modificato {date(t.updatedAt)}
                          </span>
                          {t.notes && <span className="ui-small">{t.notes}</span>}
                        </div>
                        <div className="hl-actions">
                          <AsyncButton onClick={() => open(t)} onError={fail}>
                            Modifica
                          </AsyncButton>
                          <AsyncButton variant="ghost" icon="delete" onClick={() => remove(t)} onError={fail}>
                            Elimina
                          </AsyncButton>
                        </div>
                      </li>
                    ))}
                </ul>
              </Card>
            ))}
        </div>
      )}
      {creating && form.data && (
        <NewTemplate
          models={models}
          onClose={() => setCreating(false)}
          onStart={async (o) => {
            setCreating(false);
            if (o.id) await reload();
            setEditing(o);
          }}
        />
      )}
    </div>
  );
}

/** Where a new template starts from: the form alone, a CPE backup, or a copy of a CDA Net template. */
function NewTemplate({ models, onClose, onStart }: { models: string[]; onClose: () => void; onStart: (o: EditorOpts) => Promise<void> }) {
  const [model, setModel] = useState(models[0] ?? '');
  const [from, setFrom] = useState<'form' | 'backup' | 'cda'>('form');
  const [file, setFile] = useState<File | null>(null);
  const [cdaId, setCdaId] = useState('');
  const [name, setName] = useState('');
  const cda = useQuery({ queryKey: ['admin', 'profiles'], queryFn: () => api<Array<{ model: string; templates: Array<{ id: number; name: string }> }>>('/api/admin/profiles'), enabled: from === 'cda', retry: false });
  const cdaOfModel = cda.data?.find((m) => m.model === model)?.templates ?? [];
  const start = async () => {
    if (!model) throw new Error('Scegli il modello');
    if (from === 'form') return onStart({ model, name: name.trim() });
    if (from === 'backup') {
      if (!file) throw new Error('Scegli il file di backup (.cfg)');
      const r = await api<{ template: string; suggestedBoardMatch: string; warnings: string[]; replacements: Array<{ line: number; key: string; original: string; placeholder: string }> }>(`/api/specialist/form/${encodeURIComponent(model)}/autotemplate`, {
        method: 'POST',
        body: { backup: await file.text() },
      });
      return onStart({ model, name: name.trim() || file.name.replace(/\.[^.]+$/, '').slice(0, 60), template: r.template, boardMatch: r.suggestedBoardMatch, fromBackup: { warnings: r.warnings, replacements: r.replacements } });
    }
    if (!cdaId) throw new Error('Scegli il template CDA Net da cui partire');
    if (!name.trim()) throw new Error('Scrivi il nome del tuo template');
    const t = await api<SpecTemplate>('/api/specialist/templates/copy', { method: 'POST', body: { fromId: Number(cdaId), name: name.trim() } });
    toast(`Copia «${t.name}» creata: il template CDA Net resta com’è`);
    const full = await api<SpecTemplate>(`/api/specialist/templates/${t.id}`);
    return onStart({ model: full.model, id: full.id, name: full.name, notes: full.notes, template: full.template, boardMatch: full.boardMatch, snmpSet: false, updatedAt: full.updatedAt, sha256: full.sha256 });
  };
  return (
    <Drawer
      title="Nuovo template"
      onClose={onClose}
      footer={
        <>
          <AsyncButton variant="primary" onClick={start} onError={fail}>
            {from === 'cda' ? 'Crea la copia' : 'Continua'}
          </AsyncButton>
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
        </>
      }
    >
      <Field label="Modello della CPE">
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>
      <Segmented
        label="Parti da"
        value={from}
        onChange={setFrom}
        options={[
          { value: 'form', label: 'Modulo' },
          { value: 'backup', label: 'Backup della CPE' },
          { value: 'cda', label: 'Template CDA Net' },
        ]}
      />
      {from === 'form' && <p className="ui-muted ui-small">Una configurazione airOS 8.7.4 completa (Station, Router, PPPoE): la modifichi dal modulo come l’interfaccia della CPE.</p>}
      {from === 'backup' && (
        <>
          <label className="ui-btn ui-btn-secondary fw-file">
            <input type="file" accept=".cfg,.txt,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file ? file.name : 'Scegli il backup (.cfg) di una CPE configurata'}
          </label>
          <p className="ui-muted ui-small">SSID, chiave Wi-Fi, PPPoE, credenziali, community SNMP, nome e chiave UISP diventano segnaposto; il resto resta com’è nel backup.</p>
        </>
      )}
      {from === 'cda' &&
        (cda.error ? (
          <Notice tone="bad">{(cda.error as Error).message}</Notice>
        ) : !cda.data ? (
          <Skeleton lines={2} />
        ) : cdaOfModel.length ? (
          <Field label="Template CDA Net" hint="Ne fai una copia tua: quello di CDA Net resta com’è. La community SNMP e la chiave UISP di CDA Net non vengono copiate.">
            <select value={cdaId} onChange={(e) => setCdaId(e.target.value)}>
              <option value="">—</option>
              {cdaOfModel.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="ui-muted ui-small">Nessun template CDA Net per questo modello.</p>
        ))}
      <Field label="Nome" hint="Unico per modello, es. il nome dell’azienda e l’uso.">
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="es. Wireless Sud · Station" />
      </Field>
    </Drawer>
  );
}

function TemplateEditor({ opts, data, onDirty, onClose, onSaved }: { opts: EditorOpts; data: FormData; onDirty: (d: boolean) => void; onClose: () => void; onSaved: (t: SpecTemplate) => Promise<void> }) {
  const isNew = !opts.id;
  const base = `/api/specialist/form/${encodeURIComponent(opts.model)}`;
  const fields = data.fields;
  const [name, setName] = useState(opts.name ?? '');
  const [notes, setNotes] = useState(opts.notes ?? '');
  const [boardMatch, setBoardMatch] = useState(opts.boardMatch ?? data.boardMatch[opts.model] ?? '');
  const [snmp, setSnmp] = useState('');
  const [removeSnmp, setRemoveSnmp] = useState(false);
  const [form, setFormState] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('wireless');
  const [dirty, setDirtyState] = useState(false);
  // the latest form, the values typed but not yet written into the text, the writes one after the other
  const formRef = useRef<FormState | null>(null);
  const pending = useRef<Record<string, Value>>({});
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const setForm = (f: FormState) => {
    formRef.current = f;
    setFormState(f);
  };
  const mark = () => {
    setDirtyState(true);
    onDirty(true);
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const read = async (template: string | undefined) => {
    const r = await api<FormState>(`${base}/read`, { method: 'POST', body: template ? { template } : {} });
    setForm(r);
    pending.current = {};
    setFieldErrors({});
    return r;
  };
  useEffect(() => {
    read(opts.template).catch((e) => setLoadError((e as Error).message));
    if (opts.fromBackup) mark();
  }, []);

  const flush = (): Promise<FormState | null> => {
    const run = queue.current.catch(() => undefined).then(() => write());
    queue.current = run;
    return run;
  };
  const write = async (): Promise<FormState | null> => {
    const cur = formRef.current;
    if (!cur) return null;
    const changes = { ...pending.current };
    if (!Object.keys(changes).length) return cur;
    try {
      const r = await api<FormState>(`${base}/apply`, { method: 'POST', body: { template: cur.template, changes } });
      const typed = Object.fromEntries(Object.entries(pending.current).filter(([k, v]) => changes[k] !== v));
      pending.current = typed;
      setForm({ ...r, values: { ...r.values, ...typed } });
      setFieldErrors({});
      return r;
    } catch (e) {
      const code = (e as Error & { body?: { error?: string } }).body?.error ?? '';
      const id = code.startsWith('form_invalid_') ? code.slice(13) : null;
      if (id) {
        setFieldErrors({ [id]: 'Valore non valido' });
        throw new Error(`${fields.find((f) => f.id === id)?.label ?? id}: valore non valido`);
      }
      throw e;
    }
  };
  const change = (f: FieldDef, v: Value) => {
    mark();
    const cur = formRef.current;
    if (cur) setForm({ ...cur, values: { ...cur.values, [f.id]: v } });
    pending.current = { ...pending.current, [f.id]: v };
    if (f.type === 'bool' || f.type === 'select') void flush().catch(fail);
  };
  const goTo = async (next: Tab) => {
    const cur = formRef.current;
    if (tab === 'advanced' && text !== null && cur && text !== cur.template) await read(text);
    else if (next !== tab) await flush();
    if (next === 'advanced') setText((await flush())?.template ?? formRef.current?.template ?? '');
    setTab(next);
  };

  const save = async () => {
    if (!name.trim()) throw new Error('Scrivi il nome del template');
    const last = formRef.current;
    const cur = tab === 'advanced' && text !== null && last && text !== last.template ? await read(text) : await flush();
    if (!cur) throw new Error('Configurazione non ancora caricata');
    if (!cur.report.ok) {
      setTab('advanced');
      setText(cur.template);
      throw new Error('La configurazione non è valida: vedi i dettagli');
    }
    const body = {
      name: name.trim(),
      template: cur.template,
      boardMatch: boardMatch.trim(),
      notes: notes.trim(),
      ...(snmp ? { snmpCommunity: snmp } : removeSnmp ? { snmpCommunity: null } : {}),
    };
    const t = isNew ? await api<SpecTemplate>('/api/specialist/templates', { method: 'POST', body: { model: opts.model, ...body } }) : await api<SpecTemplate>(`/api/specialist/templates/${opts.id}`, { method: 'PATCH', body });
    toast(`Template «${t.name}» salvato · ${t.sha256.slice(0, 12)}…`);
    setDirtyState(false);
    setSnmp('');
    setRemoveSnmp(false);
    await onSaved(t);
  };

  if (loadError) return <Notice tone="bad">{loadError}</Notice>;
  if (!form) return <Skeleton lines={6} />;
  const values = form.values;
  const shown = (f: FieldDef) =>
    (!f.only?.wirelessMode || values.wirelessMode === f.only.wirelessMode) &&
    (!f.only?.netMode || values.netMode === f.only.netMode) &&
    !(f.id.startsWith('scan') && f.id !== 'scanLimit' && !values.scanLimit) &&
    !(f.id === 'ackDistance' && values.ackAuto) &&
    !(f.id.startsWith('syslog') && f.id !== 'syslogRemote' && !values.syslogRemote) &&
    !(f.id.startsWith('watchdog') && f.id !== 'watchdog' && values.watchdog === false);
  const known = new Map(data.placeholders.map((p) => [p.name, p]));
  const usesCommunity = form.report.placeholders.includes('SNMP_COMMUNITY');

  return (
    <Card title={isNew ? `Nuovo template · ${opts.model}` : `Modifica · ${opts.model} · ${opts.name}`}>
      {!isNew && opts.updatedAt && (
        <p className="ui-muted ui-small pf-p">
          Ultima modifica {date(opts.updatedAt)} · SHA-256 {opts.sha256?.slice(0, 16)}…
        </p>
      )}
      <div className="ui-grid-form">
        <Field label="Nome" hint="Unico per modello.">
          <input value={name} maxLength={60} onChange={(e) => (setName(e.target.value), mark())} placeholder="es. Wireless Sud · Station" />
        </Field>
        <Field label="Board match (regex su /etc/board.info)" hint="L’app scrive solo su una CPE di questo modello.">
          <input className="ui-mono" value={boardMatch} onChange={(e) => (setBoardMatch(e.target.value), mark())} />
        </Field>
      </div>
      <Field label="Note" hint="Per chi è, a cosa serve (le vedi anche nell’app).">
        <input value={notes} maxLength={500} onChange={(e) => (setNotes(e.target.value), mark())} placeholder="es. Station PPPoE con VLAN 87 per Wireless Sud" />
      </Field>
      {opts.fromBackup && (
        <Notice tone="info" title="Dal backup della CPE">
          {opts.fromBackup.replacements.length} valori diventati segnaposto ({[...new Set(opts.fromBackup.replacements.map((r) => r.placeholder))].join(', ')}).
          {opts.fromBackup.warnings.length > 0 && (
            <ul className="ui-list">
              {opts.fromBackup.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}
      <div className="tp-summary" aria-live="polite">
        <span className="tp-mode">{modeText(form.facts)}</span>
        <span className="ui-mono">LAN {form.facts.lanIp ?? '—'}</span>
        {form.report.own.length > 0 && <Badge tone="info">{form.report.own.length} segnaposto tuoi</Badge>}
        {!form.report.ok && <Badge tone="bad">configurazione non valida</Badge>}
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={(t) => void goTo(t).catch(fail)}
        tabs={[
          ...SECTIONS.map((s) => ({ value: s.value as Tab, label: s.label })),
          { value: 'values', label: 'Valori per ogni CPE', badge: <Badge>{form.report.placeholders.length}</Badge> },
          { value: 'advanced', label: 'Avanzate', badge: form.report.ok ? undefined : <Badge tone="bad">!</Badge> },
        ]}
      />
      {SECTIONS.some((s) => s.value === tab) && (
        <section className="tp-grid">
          {fields
            .filter((f) => f.section === tab && shown(f))
            .map((f) => (
              <FormField
                key={f.id}
                f={f}
                value={values[f.id] ?? ''}
                missing={form.missing.includes(f.id)}
                {...(fieldErrors[f.id] ? { error: fieldErrors[f.id] } : {})}
                onChange={(v) => change(f, v)}
                onCommit={() => void flush().catch(fail)}
              />
            ))}
          {tab === 'services' && (
            <div>
              <Field
                label="SNMP: community"
                hint={opts.snmpSet ? 'Impostata: lascia vuoto per non cambiarla. Cifrata, mai mostrata.' : usesCommunity ? 'Facoltativa: senza, la scrivi nell’app per ogni CPE. Cifrata, mai mostrata.' : 'Il template non usa ${SNMP_COMMUNITY}.'}
              >
                <input type="password" autoComplete="new-password" value={snmp} disabled={removeSnmp} onChange={(e) => (setSnmp(e.target.value), mark())} />
              </Field>
              {opts.snmpSet && (
                <label className="ui-check ui-small">
                  <input type="checkbox" checked={removeSnmp} onChange={(e) => (setRemoveSnmp(e.target.checked), setSnmp(''), mark())} />
                  Rimuovi la community da questo template
                </label>
              )}
            </div>
          )}
        </section>
      )}
      {tab === 'values' && (
        <section>
          <p className="ui-small">
            Ogni segnaposto del testo prende il suo valore al momento, per ogni CPE: la chiave Wi-Fi e le password si scrivono nell’app e non vengono mai salvate. Per aggiungerne uno tuo scrivi <span className="ui-mono">{'${NOME}'}</span> nel testo (scheda Avanzate), es. <span className="ui-mono">{'vlan.1.id=${VLAN_ID}'}</span>.
          </p>
          {form.report.placeholders.length ? (
            <ul className="hl-list">
              {form.report.placeholders.map((p) => {
                const k = known.get(p);
                return (
                  <li key={p} className="hl-row">
                    <div className="hl-main">
                      <div className="hl-name">
                        <span className="ui-mono">{`\${${p}}`}</span>
                        <strong>{k?.label ?? 'Tuo'}</strong>
                        {k?.secret && <Badge tone="warn">segreto</Badge>}
                      </div>
                      <span className="ui-muted ui-small">{k ? FROM_TEXT[k.from] : 'scritto nell’app per ogni CPE'}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ui-muted ui-small">Nessun segnaposto: ogni CPE riceve lo stesso file.</p>
          )}
        </section>
      )}
      {tab === 'advanced' && (
        <section>
          <Field label="Testo del template (system.cfg)" hint="Modificalo a mano se serve: il modulo lo rilegge quando torni a una scheda.">
            <textarea className="pf-code" rows={22} wrap="off" spellCheck={false} value={text ?? form.template} onChange={(e) => (setText(e.target.value), mark())} />
          </Field>
          <ReportView r={form.report} />
          <Button onClick={() => downloadText(`${(name || opts.model).replace(/[^\w.-]+/g, '_')}.cfg`, text ?? form.template)}>Scarica il testo</Button>
        </section>
      )}
      <div className="ui-row pf-actions">
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva template
        </AsyncButton>
        <Button variant="ghost" onClick={onClose}>
          Chiudi
        </Button>
      </div>
    </Card>
  );
}

function ReportView({ r }: { r: Report }) {
  if (r.ok && !r.warnings.length) return <p className="ui-muted ui-small">Configurazione valida · {r.lines} righe.</p>;
  return (
    <>
      {!r.ok && (
        <Notice tone="bad" title="Configurazione non valida">
          <ul className="ui-list">
            {r.errors.map((e) => (
              <li key={e}>{errText(e)}</li>
            ))}
          </ul>
        </Notice>
      )}
      {r.warnings.length > 0 && (
        <Notice tone="warn">
          <ul className="ui-list">
            {r.warnings.map((w) => (
              <li key={w}>{errText(w)}</li>
            ))}
          </ul>
        </Notice>
      )}
    </>
  );
}
