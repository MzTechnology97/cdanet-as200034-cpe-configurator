import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, Field, Notice, PageHeader, Segmented, Skeleton, Table, Tabs } from '../ui';
import { downloadText, type Facts, type FieldDef, FormField, modeText, type Section, SECTIONS, type Value } from '../templates/form';

/**
 * Profili airOS (admins): several templates per CPE model, each with all its own values (Wireless,
 * Rete, Servizi, Sistema), set from a form like the CPE's web interface; the full text stays
 * editable in «Avanzate». Each template is visible to every installer or only to the chosen ones
 * (personal or team templates). #/profiles?user=N (from Account) opens a personal template.
 */

const MESSAGES: Record<string, string> = {
  template_size: 'Dimensione non valida (minimo 64 caratteri)',
  profile_not_system_cfg: 'Non sembra una configurazione airOS (mancano radio./wireless./netconf./users.)',
  profile_contains_vlan: 'Contiene una VLAN (vlan.* o ppp.N.devname=ath0.X): la policy CDA Net non la prevede.',
  profile_contains_nul: 'Contiene byte NUL',
  unknown_placeholders: 'Placeholder non riconosciuti',
  retired_placeholders: 'Contiene valori che erano del server (es. ${LAN_IP}): ora ogni template ha i suoi, scrivi il valore o usa il modulo',
  users_password_requires_hash_placeholder: 'users.N.password deve usare ${CPE_PASSWORD_HASH}, non ${CPE_PASSWORD}',
  non_key_value_lines: 'Alcune righe non sono nel formato chiave=valore',
  template_name_exists: 'Esiste già un template con questo nome per il modello',
  template_audience_empty: 'Seleziona almeno un installatore',
  default_must_be_public: 'Il predefinito generale deve essere visibile a tutti: rendi predefinito un altro template prima di riservare questo.',
  board_match_invalid_regex: 'Board match: espressione regolare non valida',
  template_snmp_community_required: 'Serve la community SNMP del template',
};
const msg = (c: string) => MESSAGES[c] ?? (c.startsWith('missing_placeholder_') ? `Placeholder ${c.slice(20)} non presente` : c);
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');

interface Params {
  watchdogHost: string;
  snmpContact: string;
}
interface FormState {
  template: string;
  params: Params;
  values: Record<string, Value>;
  missing: string[];
  warnings: Array<{ field: string; message: string }>;
  facts: Facts;
  report: Report;
}
interface TemplateRow {
  id: number;
  model: string;
  name: string;
  isDefault: boolean;
  audience: 'all' | 'users';
  users: Array<{ id: number; username: string }>;
  defaultForAssigned?: boolean;
  boardMatch: string;
  facts: Facts;
  secretsSet: { snmpCommunity: boolean; uispKey: boolean };
  updatedAt: string;
  updatedBy?: string | null;
}
interface Model {
  model: string;
  firmware: string;
  templates: TemplateRow[];
}
interface Report {
  ok: boolean;
  lines: number;
  placeholders: string[];
  errors: string[];
  warnings: string[];
  unknownPlaceholders?: string[];
  retiredPlaceholders?: string[];
}
interface EditorOpts {
  model: string;
  id?: number;
  name?: string;
  template?: string;
  params?: Params;
  boardMatch?: string;
  suggestedBoardMatch?: string;
  isDefault?: boolean;
  audience?: 'all' | 'users';
  users?: Array<{ id: number }>;
  userIds?: number[];
  defaultForAssigned?: boolean;
  secretsSet?: { snmpCommunity: boolean; uispKey: boolean };
  /** A copy: the secrets of this template go with it (the console never sees them). */
  secretsFrom?: number;
  updatedAt?: string;
  updatedBy?: string | null;
  sha256?: string;
}

type Tab = Section | 'access' | 'advanced';



function ReportView({ r }: { r: Report }) {
  if (r.ok && !r.warnings.length) return null;
  return (
    <>
      {!r.ok && (
        <Notice tone="bad" title="Configurazione non valida">
          <ul className="ui-list">
            {r.errors.map((e) => (
              <li key={e}>{msg(e)}</li>
            ))}
          </ul>
          {!!r.unknownPlaceholders?.length && <p className="ui-mono ui-small pf-p">{r.unknownPlaceholders.join(', ')}</p>}
          {!!r.retiredPlaceholders?.length && <p className="ui-mono ui-small pf-p">{r.retiredPlaceholders.map((p) => `\${${p}}`).join(', ')}</p>}
        </Notice>
      )}
      {r.warnings.length > 0 && (
        <Notice tone="warn">
          <ul className="ui-list">
            {r.warnings.map((w) => (
              <li key={w}>{msg(w)}</li>
            ))}
          </ul>
        </Notice>
      )}
    </>
  );
}

export function Profiles({ params }: PageContext) {
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ['admin', 'profiles'], queryFn: () => api<Model[]>('/api/admin/profiles') });
  const fields = useQuery({ queryKey: ['admin', 'template-form'], queryFn: () => api<{ fields: FieldDef[] }>('/api/admin/template-form').then((r) => r.fields), staleTime: Infinity });
  const placeholders = useQuery({ queryKey: ['admin', 'placeholders'], queryFn: () => api<Array<{ name: string; description: string }>>('/api/admin/placeholders'), staleTime: Infinity });
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<Array<{ id: number; username: string; role: string; active: boolean }>>('/api/admin/users') });
  const [editor, setEditor] = useState<EditorOpts | null>(null);
  const dirty = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ['admin', 'profiles'] });
  const open = (opts: EditorOpts) => {
    if (dirty.current && !confirm('Ci sono modifiche non salvate nell’editor. Continuare?')) return;
    dirty.current = false;
    setEditor(opts);
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const full = (t: TemplateRow) => api<EditorOpts>(`/api/admin/templates/${t.id}`);
  const forUser = Number(params.get('user')) || null;

  return (
    <div className="ui-page">
      <PageHeader
        icon="settings_input_antenna"
        title="Profili airOS"
        subtitle="Ogni template ha la sua configurazione completa (wireless, rete, servizi, sistema), impostata come dall’interfaccia web della CPE. Il predefinito viene proposto nell’app; un installatore vede e usa solo i template a cui ha accesso."
      />
      {models.error && <Notice tone="bad">{(models.error as Error).message}</Notice>}
      {!models.data && !models.error && <Skeleton lines={8} />}
      {forUser && models.data && users.data && <PersonalShortcut userId={forUser} models={models.data} users={users.data} onOpen={open} />}
      <div ref={editorRef}>
        {editor && fields.data && placeholders.data && users.data && (
          <TemplateEditor
            key={`${editor.model}-${editor.id ?? 'new'}-${editor.name ?? ''}`}
            opts={editor}
            fields={fields.data}
            placeholders={placeholders.data}
            users={users.data.filter((u) => u.active)}
            onDirty={(d) => (dirty.current = d)}
            onClose={() => {
              dirty.current = false;
              setEditor(null);
            }}
            onSaved={async () => {
              dirty.current = false;
              setEditor(null);
              if (forUser) location.hash = '#/profiles';
              await reload();
            }}
          />
        )}
      </div>
      {models.data?.map((m) => (
        <Card
          key={m.model}
          title={m.model}
          padded={!m.templates.length}
          actions={
            <Button variant="primary" icon="add_circle" onClick={() => open({ model: m.model, isDefault: m.templates.length === 0, name: m.templates.length === 0 ? 'Standard' : '' })}>
              Nuovo template
            </Button>
          }
        >
          <p className={`ui-muted ui-small pf-p${m.templates.length ? ' pf-pad' : ''}`}>
            airOS {m.firmware} · {m.templates.length ? `${m.templates.length} template` : 'nessun template: provisioning bloccato'}
          </p>
          {m.templates.length > 0 && (
            <Table
              rows={m.templates}
              rowKey={(t) => t.id}
              columns={[
                {
                  label: 'Nome',
                  render: (t) => (
                    <span className="ui-row">
                      <strong>{t.name}</strong>
                      {t.isDefault && <Badge tone="good">predefinito</Badge>}
                    </span>
                  ),
                },
                {
                  label: 'Configurazione',
                  render: (t) => (
                    <div className="ui-small">
                      <div>{modeText(t.facts)}</div>
                      <div className="ui-muted ui-mono">LAN {t.facts.lanIp ?? '—'}</div>
                      {!t.secretsSet.uispKey && <Badge tone="warn">senza chiave UISP</Badge>}
                    </div>
                  ),
                },
                {
                  label: 'Chi può usarlo',
                  render: (t) =>
                    t.audience === 'users' ? (
                      <div>
                        <Badge tone="warn">{t.users.length === 1 ? 'personale' : `${t.users.length} installatori`}</Badge> <span className="ui-small">{t.users.map((u) => u.username).join(', ')}</span>
                        {t.defaultForAssigned && <div className="ui-muted ui-small">predefinito per loro</div>}
                      </div>
                    ) : (
                      <Badge>tutti</Badge>
                    ),
                },
                {
                  label: 'Aggiornato',
                  render: (t) => (
                    <span className="ui-small">
                      {date(t.updatedAt)}
                      {t.updatedBy ? ` · ${t.updatedBy}` : ''}
                    </span>
                  ),
                },
                {
                  label: 'Azioni',
                  end: true,
                  render: (t) => (
                    <div className="pf-actions">
                      <AsyncButton variant="ghost" onClick={async () => open({ ...(await full(t)), model: t.model })} onError={fail}>
                        Modifica
                      </AsyncButton>
                      <AsyncButton
                        variant="ghost"
                        onClick={async () => {
                          const f = await full(t);
                          open({ model: t.model, name: `${t.name} (copia)`.slice(0, 60), template: f.template, params: f.params, boardMatch: f.boardMatch, audience: f.audience, users: f.users, defaultForAssigned: f.defaultForAssigned, secretsFrom: t.id, secretsSet: f.secretsSet });
                        }}
                        onError={fail}
                      >
                        Duplica
                      </AsyncButton>
                      {!t.isDefault && (
                        <AsyncButton
                          variant="ghost"
                          onClick={async () => {
                            await api(`/api/admin/templates/${t.id}`, { method: 'PATCH', body: { isDefault: true } });
                            toast(`«${t.name}» è ora il predefinito per ${t.model}`);
                            await reload();
                          }}
                          onError={fail}
                        >
                          Rendi predefinito
                        </AsyncButton>
                      )}
                      <AsyncButton
                        variant="danger"
                        onClick={async () => {
                          const last = m.templates.length === 1;
                          if (!confirm(`Eliminare il template «${t.name}» di ${t.model}?${last ? '\n\nÈ l’unico template del modello: il provisioning di questo modello verrà bloccato.' : t.isDefault ? '\n\nÈ il predefinito: diventerà predefinito il template modificato più di recente.' : ''}`)) return;
                          await api(`/api/admin/templates/${t.id}`, { method: 'DELETE' });
                          toast('Template eliminato');
                          await reload();
                        }}
                        onError={fail}
                      >
                        Elimina
                      </AsyncButton>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </Card>
      ))}
    </div>
  );
}

/** From Account: a personal template for one installer, from the form or copied from an existing one. */
function PersonalShortcut({ userId, models, users, onOpen }: { userId: number; models: Model[]; users: Array<{ id: number; username: string }>; onOpen: (o: EditorOpts) => void }) {
  const u = users.find((x) => x.id === userId);
  const [model, setModel] = useState(models[0]?.model ?? '');
  const m = models.find((x) => x.model === model);
  const [base, setBase] = useState<string>(() => String(m?.templates.find((t) => t.isDefault)?.id ?? ''));
  useEffect(() => setBase(String(models.find((x) => x.model === model)?.templates.find((t) => t.isDefault)?.id ?? '')), [model, models]);
  if (!u) return null;
  return (
    <Card title={`Template personale per ${u.username}`}>
      <p className="ui-muted ui-small pf-p">Sarà visibile solo a questo installatore e proposto come suo predefinito nell’app. Puoi partire da un template esistente o da un modulo nuovo.</p>
      <div className="pf-inline">
        <Field label="Modello" hint="Il modello della CPE.">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((x) => (
              <option key={x.model} value={x.model}>
                {x.model}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Parti da" hint="Una copia porta con sé anche community SNMP e chiave UISP.">
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            <option value="">Modulo nuovo / backup CPE</option>
            {m?.templates.map((t) => (
              <option key={t.id} value={t.id}>
                Copia di «{t.name}»
              </option>
            ))}
          </select>
        </Field>
        <AsyncButton
          variant="primary"
          onClick={async () => {
            const src = base ? await api<EditorOpts>(`/api/admin/templates/${base}`) : null;
            onOpen({
              model,
              name: `${u.username}${src ? ` · ${src.name}` : ''}`.slice(0, 60),
              template: src?.template,
              params: src?.params,
              boardMatch: src?.boardMatch,
              audience: 'users',
              userIds: [u.id],
              defaultForAssigned: true,
              ...(src ? { secretsFrom: Number(base), secretsSet: src.secretsSet } : {}),
            });
          }}
          onError={fail}
        >
          Crea template personale
        </AsyncButton>
      </div>
    </Card>
  );
}

/** One field of the form, like the airOS web interface: the network rule and the bench note under it. */
/** A new template (from the form, a CPE backup or a copy) or an existing one. */
function TemplateEditor({
  opts,
  fields,
  placeholders,
  users,
  onDirty,
  onClose,
  onSaved,
}: {
  opts: EditorOpts;
  fields: FieldDef[];
  placeholders: Array<{ name: string; description: string }>;
  users: Array<{ id: number; username: string; role: string }>;
  onDirty: (d: boolean) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = !opts.id;
  const base = `/api/admin/profiles/${encodeURIComponent(opts.model)}`;
  const [name, setName] = useState(opts.name ?? '');
  const [boardMatch, setBoardMatch] = useState(opts.boardMatch ?? opts.suggestedBoardMatch ?? '');
  const [form, setFormState] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // the latest form and the values typed but not yet written into the text (an IP being typed is
  // not valid yet); the writes go one after the other, each from the text the previous one returned
  const formRef = useRef<FormState | null>(null);
  const pending = useRef<Record<string, Value>>({});
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const setForm = (f: FormState) => {
    formRef.current = f;
    setFormState(f);
  };
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('wireless');
  const [isDefault, setIsDefault] = useState(!!opts.isDefault);
  const [audience, setAudience] = useState<'all' | 'users'>(opts.audience === 'users' ? 'users' : 'all');
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(opts.userIds ?? (opts.users ?? []).map((u) => u.id)));
  const [dfa, setDfa] = useState(opts.audience === 'users' ? !!opts.defaultForAssigned : true);
  const [snmpCommunity, setSnmpCommunity] = useState('');
  const [uispKey, setUispKey] = useState('');
  const [removeUisp, setRemoveUisp] = useState(false);
  const [fromBackup, setFromBackup] = useState<{ warnings: string[]; replacements: Array<{ line: number; key: string; original: string; placeholder: string }> } | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const secretsSet = opts.secretsSet ?? { snmpCommunity: false, uispKey: false };

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

  const read = async (template: string | undefined, params: Params | undefined) => {
    const r = await api<FormState>(`${base}/form/read`, { method: 'POST', body: { ...(template ? { template } : {}), ...(params ? { params } : {}) } });
    setForm(r);
    pending.current = {};
    setFieldErrors({});
    return r;
  };
  useEffect(() => {
    read(opts.template, opts.params).catch((e) => setLoadError((e as Error).message));
  }, []);

  /** Writes the pending values into the text (on the server, nothing stored), after the writes before. */
  const flush = (extra: Record<string, Value> = {}): Promise<FormState | null> => {
    const run = queue.current.catch(() => undefined).then(() => write(extra));
    queue.current = run;
    return run;
  };
  const write = async (extra: Record<string, Value>): Promise<FormState | null> => {
    const cur = formRef.current;
    if (!cur) return null;
    const changes = { ...pending.current, ...extra };
    if (!Object.keys(changes).length) return cur;
    try {
      const r = await api<FormState>(`${base}/form/apply`, { method: 'POST', body: { template: cur.template, params: cur.params, changes } });
      // what was typed meanwhile stays on screen and is written next time
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
    // modes and switches change what the form shows: written at once
    if (f.type === 'bool' || f.type === 'select') void flush().catch(fail);
  };
  const goTo = async (next: Tab) => {
    const cur = formRef.current;
    if (tab === 'advanced' && text !== null && cur && text !== cur.template) {
      // the text edited by hand: the form is read again from it
      await read(text, cur.params);
    } else if (next !== tab) {
      await flush();
    }
    if (next === 'advanced') setText((await flush())?.template ?? formRef.current?.template ?? '');
    setTab(next);
  };

  const loadBackup = async (f: File) => {
    const r = await api<{ template: string; suggestedBoardMatch: string; warnings: string[]; replacements: Array<{ line: number; key: string; original: string; placeholder: string }> }>(`${base}/autotemplate`, {
      method: 'POST',
      body: { backup: await f.text() },
    });
    await read(r.template, formRef.current?.params);
    setText(r.template);
    if (!boardMatch.trim()) setBoardMatch(r.suggestedBoardMatch);
    if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, '').slice(0, 60));
    setFromBackup({ warnings: r.warnings, replacements: r.replacements });
    mark();
  };

  const restricted = audience === 'users';
  const save = async () => {
    if (!name.trim()) throw new Error('Inserisci un nome per il template');
    if (restricted && chosen.size === 0) throw new Error('Seleziona almeno un installatore oppure scegli «Tutti gli installatori»');
    const last = formRef.current;
    const cur = tab === 'advanced' && text !== null && last && text !== last.template ? await read(text, last.params) : await flush();
    if (!cur) throw new Error('Configurazione non ancora caricata');
    if (!cur.report.ok) {
      setTab('advanced');
      setText(cur.template);
      throw new Error('La configurazione non è valida: vedi i dettagli');
    }
    if (isNew && !opts.secretsFrom && !snmpCommunity) throw new Error('Inserisci la community SNMP (scheda Servizi)');
    const secrets = {
      ...(snmpCommunity ? { snmpCommunity } : {}),
      ...(uispKey ? { uispKey } : removeUisp ? { uispKey: null } : {}),
    };
    const body = {
      name: name.trim(),
      template: cur.template,
      params: cur.params,
      boardMatch: boardMatch.trim(),
      ...(Object.keys(secrets).length ? { secrets } : {}),
      ...(restricted ? { audience: 'users', userIds: [...chosen], defaultForAssigned: dfa } : { audience: 'all' }),
    };
    try {
      const r = isNew
        ? await api<{ name: string; sha256: string }>(`${base}/templates`, { method: 'POST', body: { ...body, isDefault, ...(opts.secretsFrom ? { secretsFrom: opts.secretsFrom } : {}) } })
        : await api<{ name: string; sha256: string }>(`/api/admin/templates/${opts.id}`, { method: 'PATCH', body: { ...body, ...(isDefault && !opts.isDefault ? { isDefault: true } : {}) } });
      toast(`Template «${r.name}» salvato · ${r.sha256.slice(0, 12)}…`);
      setDirtyState(false);
      await onSaved();
    } catch (e) {
      const err = e as Error & { body?: { error?: string } };
      throw new Error(MESSAGES[err.body?.error ?? ''] ?? err.message);
    }
  };

  if (loadError) return <Notice tone="bad">{loadError}</Notice>;
  if (!form) return <Skeleton lines={6} />;
  const values = form.values;
  const warnFor = (id: string) => form.warnings.find((w) => w.field === id)?.message;
  const shown = (f: FieldDef) => (!f.only?.wirelessMode || values.wirelessMode === f.only.wirelessMode) && (!f.only?.netMode || values.netMode === f.only.netMode) && !(f.id.startsWith('scan') && f.id !== 'scanLimit' && !values.scanLimit) && !(f.id === 'ackDistance' && values.ackAuto) && !(f.id.startsWith('syslog') && f.id !== 'syslogRemote' && !values.syslogRemote);
  const warnCount = (s: Section) => form.warnings.filter((w) => fields.find((f) => f.id === w.field)?.section === s).length;
  const experimentalMode = values.wirelessMode === 'ap' || values.netMode === 'bridge';

  return (
    <Card title={isNew ? `Nuovo template · ${opts.model}` : `Modifica template · ${opts.model} · ${opts.name}`}>
      {!isNew && opts.updatedAt && (
        <p className="ui-muted ui-small pf-p">
          Ultima modifica {date(opts.updatedAt)}
          {opts.updatedBy ? ` · ${opts.updatedBy}` : ''} · SHA-256 {opts.sha256?.slice(0, 16)}…
        </p>
      )}
      <div className="ui-grid-form">
        <Field label="Nome" hint="Unico per modello, es. Standard, Palo alto, Ponte PtP.">
          <input value={name} maxLength={60} placeholder="es. Standard" onChange={(e) => (setName(e.target.value), mark())} />
        </Field>
        <Field label="Board match (regex su /etc/board.info)" hint="L’app scrive solo su una CPE di questo modello.">
          <input className="ui-mono" value={boardMatch} placeholder="es. board\.name=LiteBeam 5AC" onChange={(e) => (setBoardMatch(e.target.value), mark())} />
        </Field>
      </div>
      {isNew && !opts.template && (
        <label className="ui-btn ui-btn-secondary fw-file pf-backup">
          <input type="file" accept=".cfg,.txt,text/plain" onChange={(e) => e.target.files?.[0] && void loadBackup(e.target.files[0]).catch(fail)} />
          Parti da un backup della CPE (.cfg), facoltativo
        </label>
      )}

      <div className="tp-summary" aria-live="polite">
        <span className="tp-mode">{modeText(form.facts)}</span>
        <span className="ui-mono">LAN {form.facts.lanIp ?? '—'}</span>
        {form.warnings.length > 0 && <Badge tone="warn">{form.warnings.length} fuori dalle regole di rete</Badge>}
        {!form.report.ok && <Badge tone="bad">configurazione non valida</Badge>}
      </div>
      {experimentalMode && (
        <Notice tone="warn" title="Da collaudare al banco">
          {values.wirelessMode === 'ap' ? 'Access Point' : 'Bridge'}: le chiavi di questa modalità non vengono da un backup di laboratorio. Prova il template su una CPE di laboratorio prima dell’uso in campo, oppure parti dal backup di una CPE configurata così.
        </Notice>
      )}

      <Tabs<Tab>
        value={tab}
        onChange={(t) => void goTo(t).catch(fail)}
        tabs={[
          ...SECTIONS.map((s) => ({ value: s.value as Tab, label: s.label, badge: warnCount(s.value) ? <Badge tone="warn">{warnCount(s.value)}</Badge> : undefined })),
          { value: 'access', label: 'Accesso' },
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
                {...(warnFor(f.id) ? { warn: warnFor(f.id) } : {})}
                {...(fieldErrors[f.id] ? { error: fieldErrors[f.id] } : {})}
                onChange={(v) => change(f, v)}
                onCommit={() => void flush().catch(fail)}
              />
            ))}
          {tab === 'services' && (
            <>
              <Field label="SNMP: community" hint={secretsSet.snmpCommunity || opts.secretsFrom ? 'Impostata: lascia vuoto per non cambiarla. Cifrata, non viene mai mostrata.' : 'Obbligatoria. Cifrata, non viene mai mostrata.'}>
                <input type="password" autoComplete="new-password" value={snmpCommunity} onChange={(e) => (setSnmpCommunity(e.target.value), mark())} />
              </Field>
              <div>
                <Field label="Chiave UISP (wss://…)" hint={secretsSet.uispKey || opts.secretsFrom ? 'Impostata: lascia vuoto per non cambiarla. Cifrata, non viene mai mostrata.' : 'La «UISP key» con cui la CPE compare in UISP. Cifrata, non viene mai mostrata.'}>
                  <input type="password" autoComplete="new-password" value={uispKey} disabled={removeUisp} onChange={(e) => (setUispKey(e.target.value), mark())} />
                </Field>
                {secretsSet.uispKey && !isNew && (
                  <label className="ui-check ui-small">
                    <input type="checkbox" checked={removeUisp} onChange={(e) => (setRemoveUisp(e.target.checked), setUispKey(''), mark())} />
                    Rimuovi la chiave UISP da questo template
                  </label>
                )}
              </div>
            </>
          )}
        </section>
      )}
      {SECTIONS.some((s) => s.value === tab) && (
        <p className="ui-muted ui-small pf-p">
          Sempre imposti dal server a ogni provisioning: watchdog e SNMP attivi, Calculate EIRP Limit spento, controllo automatico della potenza (Station) attivo, Device Name e location SNMP con il nome del cliente, posizione della CPE. Utente e password admin delle CPE sono quelli del server (Impostazioni server).
        </p>
      )}

      {tab === 'access' && (
        <section className="pf-sec">
          <label className="ui-check">
            <input type="radio" name="audience" checked={!restricted} onChange={() => (setAudience('all'), mark())} />
            Tutti gli installatori
          </label>
          <label className="ui-check">
            <input
              type="radio"
              name="audience"
              checked={restricted}
              onChange={() => {
                setAudience('users');
                setIsDefault(false);
                mark();
              }}
            />
            Solo gli installatori selezionati (template personale o di squadra)
          </label>
          {restricted && (
            <>
              <div className="pf-users">
                {users.length ? (
                  users.map((u) => (
                    <label key={u.id} className="ui-check ui-small">
                      <input
                        type="checkbox"
                        checked={chosen.has(u.id)}
                        onChange={(e) => {
                          const n = new Set(chosen);
                          if (e.target.checked) n.add(u.id);
                          else n.delete(u.id);
                          setChosen(n);
                          mark();
                        }}
                      />
                      {u.username}
                      {u.role === 'admin' ? ' (admin)' : u.role === 'specialist' ? ' (specialist)' : ''}
                    </label>
                  ))
                ) : (
                  <p className="ui-muted ui-small">Nessun account attivo.</p>
                )}
              </div>
              <label className="ui-check ui-small">
                <input type="checkbox" checked={dfa} onChange={(e) => (setDfa(e.target.checked), mark())} />
                Predefinito per gli installatori selezionati (proposto automaticamente nell’app)
              </label>
            </>
          )}
          <label className="ui-check">
            <input type="checkbox" checked={isDefault} disabled={restricted} onChange={(e) => (setIsDefault(e.target.checked), mark())} />
            {opts.isDefault ? 'Predefinito generale del modello' : 'Imposta come predefinito generale del modello (solo se visibile a tutti)'}
          </label>
        </section>
      )}

      {tab === 'advanced' && text !== null && (
        <section className="pf-sec">
          <p className="ui-muted ui-small pf-p">Il testo completo del system.cfg. Le modifiche fatte qui tornano nel modulo quando cambi scheda. Clic su un placeholder per inserirlo: sono i valori del cliente e i segreti, riempiti a ogni provisioning.</p>
          <div className="pf-chips">
            {placeholders.map((p) => (
              <button
                key={p.name}
                type="button"
                className="pf-chip"
                title={p.description}
                onClick={() => {
                  const el = area.current;
                  if (!el) return;
                  const token = `\${${p.name}}`;
                  const { selectionStart: a, selectionEnd: b } = el;
                  setText(text.slice(0, a) + token + text.slice(b));
                  mark();
                  requestAnimationFrame(() => {
                    el.focus();
                    el.selectionStart = el.selectionEnd = a + token.length;
                  });
                }}
              >
                {`\${${p.name}}`}
              </button>
            ))}
          </div>
          <textarea ref={area} className="pf-code" spellCheck={false} autoComplete="off" rows={22} wrap="off" value={text} onChange={(e) => (setText(e.target.value), mark())} aria-label="Configurazione del template" />
          <span className="ui-muted ui-small">{text.split('\n').length} righe</span>
          <div className="ui-row">
            <AsyncButton onClick={async () => void (await read(text, form.params))} onError={fail}>
              Controlla
            </AsyncButton>
            <Button onClick={() => downloadText(`template-${opts.model.replace(/\s+/g, '-')}-${(name || 'nuovo').replace(/[^\w.-]+/g, '_')}.cfg`, text)}>Scarica</Button>
          </div>
        </section>
      )}

      <ReportView r={form.report} />
      {fromBackup && fromBackup.warnings.length > 0 && (
        <Notice tone="warn">
          <ul className="ui-list">
            {fromBackup.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      {fromBackup && (
        <details className="ui-details">
          <summary>{fromBackup.replacements.length} valori del backup sostituiti con i dati del cliente</summary>
          <Table
            rows={fromBackup.replacements}
            rowKey={(x) => `${x.line}-${x.key}`}
            columns={[
              { label: 'Riga', render: (x) => x.line },
              { label: 'Chiave', render: (x) => <span className="ui-mono ui-small">{x.key}</span> },
              { label: 'Valore nel backup', render: (x) => <span className="ui-mono ui-small">{x.original}</span> },
              { label: 'Diventa', render: (x) => <code>{`\${${x.placeholder}}`}</code> },
            ]}
          />
        </details>
      )}
      <div className="ui-row">
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          {isNew ? 'Salva nuovo template' : 'Salva modifiche'}
        </AsyncButton>
        <Button
          variant="ghost"
          onClick={() => {
            if (dirty && !confirm('Chiudere senza salvare le modifiche?')) return;
            onClose();
          }}
        >
          Chiudi
        </Button>
      </div>
    </Card>
  );
}
