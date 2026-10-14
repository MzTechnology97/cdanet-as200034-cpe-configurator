import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, Field, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * Profili airOS (admins): several templates per CPE model, each visible to every installer or only
 * to the chosen ones (personal or team templates). The default is proposed in the app; an installer
 * sees and uses only the templates open to them. A template can start from a CPE backup.
 * #/profiles?user=N (from Account) opens a personal template for that installer.
 */

const MESSAGES: Record<string, string> = {
  template_size: 'Dimensione non valida (minimo 64 caratteri)',
  profile_not_system_cfg: 'Non sembra una configurazione airOS (mancano radio./wireless./netconf./users.)',
  profile_contains_vlan: 'Contiene una VLAN (vlan.* o ppp.N.devname=ath0.X): la policy CDA Net non la prevede.',
  profile_contains_nul: 'Contiene byte NUL',
  unknown_placeholders: 'Placeholder non riconosciuti',
  users_password_requires_hash_placeholder: 'users.N.password deve usare ${CPE_PASSWORD_HASH}, non ${CPE_PASSWORD}',
  non_key_value_lines: 'Alcune righe non sono nel formato chiave=valore',
  template_name_exists: 'Esiste già un template con questo nome per il modello',
  template_audience_empty: 'Seleziona almeno un installatore',
  default_must_be_public: 'Il predefinito generale deve essere visibile a tutti: rendi predefinito un altro template prima di riservare questo.',
  board_match_invalid_regex: 'Board match: espressione regolare non valida',
};
const msg = (c: string) => MESSAGES[c] ?? (c.startsWith('missing_placeholder_') ? `Placeholder ${c.slice(20)} non presente` : c);
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');

interface TemplateRow {
  id: number;
  model: string;
  name: string;
  isDefault: boolean;
  audience: 'all' | 'users';
  users: Array<{ id: number; username: string }>;
  defaultForAssigned?: boolean;
  boardMatch: string;
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
}
interface EditorOpts {
  model: string;
  id?: number;
  name?: string;
  template?: string;
  boardMatch?: string;
  suggestedBoardMatch?: string;
  isDefault?: boolean;
  audience?: 'all' | 'users';
  users?: Array<{ id: number }>;
  userIds?: number[];
  defaultForAssigned?: boolean;
  updatedAt?: string;
  updatedBy?: string | null;
  sha256?: string;
}

function downloadText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function ReportView({ r }: { r: Report }) {
  return (
    <>
      <Notice tone={r.ok ? (r.warnings.length ? 'warn' : 'good') : 'bad'} title={r.ok ? `Template valido · ${r.lines} righe` : 'Template non valido'}>
        {r.ok && <p className="pf-p">Placeholder: {r.placeholders.join(', ') || 'nessuno'}</p>}
        {r.errors.length > 0 && (
          <ul className="ui-list">
            {r.errors.map((e) => (
              <li key={e}>{msg(e)}</li>
            ))}
          </ul>
        )}
        {!!r.unknownPlaceholders?.length && <p className="ui-mono ui-small pf-p">{r.unknownPlaceholders.join(', ')}</p>}
      </Notice>
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
  const edit = async (t: TemplateRow) => {
    const full = await api<EditorOpts>(`/api/admin/templates/${t.id}`);
    open({ ...full, model: t.model });
  };
  const forUser = Number(params.get('user')) || null;

  return (
    <div className="ui-page">
      <PageHeader
        icon="settings_input_antenna"
        title="Profili airOS"
        subtitle="Più template per modello, ognuno visibile a tutti gli installatori o solo a quelli scelti (template personali). Il predefinito viene proposto nell’app; un installatore vede e usa solo i template a cui ha accesso."
      />
      {models.error && <Notice tone="bad">{(models.error as Error).message}</Notice>}
      {!models.data && !models.error && <Skeleton lines={8} />}
      {forUser && models.data && users.data && <PersonalShortcut userId={forUser} models={models.data} users={users.data} onOpen={open} />}
      <div ref={editorRef}>
        {editor && placeholders.data && users.data && (
          <TemplateEditor
            key={`${editor.model}-${editor.id ?? 'new'}-${editor.name ?? ''}`}
            opts={editor}
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
                { label: 'Board match', render: (t) => <span className="ui-mono ui-small">{t.boardMatch}</span> },
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
                      <AsyncButton variant="ghost" onClick={() => edit(t)} onError={fail}>
                        Modifica
                      </AsyncButton>
                      <AsyncButton
                        variant="ghost"
                        onClick={async () => {
                          const full = await api<EditorOpts>(`/api/admin/templates/${t.id}`);
                          open({ model: t.model, name: `${t.name} (copia)`.slice(0, 60), template: full.template, boardMatch: full.boardMatch, audience: full.audience, users: full.users, defaultForAssigned: full.defaultForAssigned });
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

/** From Account: a personal template for one installer, empty or copied from an existing one. */
function PersonalShortcut({ userId, models, users, onOpen }: { userId: number; models: Model[]; users: Array<{ id: number; username: string }>; onOpen: (o: EditorOpts) => void }) {
  const u = users.find((x) => x.id === userId);
  const [model, setModel] = useState(models[0]?.model ?? '');
  const m = models.find((x) => x.model === model);
  const [base, setBase] = useState<string>(() => String(m?.templates.find((t) => t.isDefault)?.id ?? ''));
  useEffect(() => setBase(String(models.find((x) => x.model === model)?.templates.find((t) => t.isDefault)?.id ?? '')), [model, models]);
  if (!u) return null;
  return (
    <Card title={`Template personale per ${u.username}`}>
      <p className="ui-muted ui-small pf-p">Sarà visibile solo a questo installatore e proposto come suo predefinito nell’app. Puoi partire da un template esistente o da un backup.</p>
      <div className="pf-inline">
        <Field label="Modello">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((x) => (
              <option key={x.model} value={x.model}>
                {x.model}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Parti da">
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            <option value="">Vuoto / da backup CPE</option>
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
            onOpen({ model, name: `${u.username}${src ? ` · ${src.name}` : ''}`.slice(0, 60), template: src?.template, boardMatch: src?.boardMatch, audience: 'users', userIds: [u.id], defaultForAssigned: true });
          }}
          onError={fail}
        >
          Crea template personale
        </AsyncButton>
      </div>
    </Card>
  );
}

/** A new template (from a CPE backup or a copy) or an existing one. */
function TemplateEditor({
  opts,
  placeholders,
  users,
  onDirty,
  onClose,
  onSaved,
}: {
  opts: EditorOpts;
  placeholders: Array<{ name: string; description: string }>;
  users: Array<{ id: number; username: string; role: string }>;
  onDirty: (d: boolean) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = !opts.id;
  const [name, setName] = useState(opts.name ?? '');
  const [boardMatch, setBoardMatch] = useState(opts.boardMatch ?? opts.suggestedBoardMatch ?? '');
  const [text, setText] = useState(opts.template ?? '');
  const [isDefault, setIsDefault] = useState(!!opts.isDefault);
  const [audience, setAudience] = useState<'all' | 'users'>(opts.audience === 'users' ? 'users' : 'all');
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(opts.userIds ?? (opts.users ?? []).map((u) => u.id)));
  const [dfa, setDfa] = useState(opts.audience === 'users' ? !!opts.defaultForAssigned : true);
  const [report, setReport] = useState<Report | null>(null);
  const [fromBackup, setFromBackup] = useState<{ warnings: string[]; replacements: Array<{ line: number; key: string; original: string; placeholder: string }> } | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const mark = () => {
    setDirtyState(true);
    onDirty(true);
  };
  // leaving the page with unsaved changes asks first
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const restricted = audience === 'users';
  const insert = (token: string) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const next = text.slice(0, a) + token + text.slice(b);
    setText(next);
    mark();
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = a + token.length;
    });
  };
  const loadBackup = async (f: File) => {
    const r = await api<{ template: string; suggestedBoardMatch: string; report: Report; warnings: string[]; replacements: Array<{ line: number; key: string; original: string; placeholder: string }> }>(`/api/admin/profiles/${encodeURIComponent(opts.model)}/autotemplate`, {
      method: 'POST',
      body: { backup: await f.text() },
    });
    setText(r.template);
    if (!boardMatch.trim()) setBoardMatch(r.suggestedBoardMatch);
    if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, '').slice(0, 60));
    setReport(r.report);
    setFromBackup({ warnings: r.warnings, replacements: r.replacements });
    mark();
  };
  const check = async () => {
    setReport(await api<Report>(`/api/admin/profiles/${encodeURIComponent(opts.model)}/inspect`, { method: 'POST', body: { template: text, ...(boardMatch.trim() ? { boardMatch: boardMatch.trim() } : {}) } }));
  };
  const save = async () => {
    if (!name.trim()) throw new Error('Inserisci un nome per il template');
    if (!text.trim()) throw new Error('Il template è vuoto: carica un backup o incolla una configurazione');
    if (restricted && chosen.size === 0) throw new Error('Seleziona almeno un installatore oppure scegli «Tutti gli installatori»');
    const body = { name: name.trim(), template: text, boardMatch: boardMatch.trim(), ...(restricted ? { audience: 'users', userIds: [...chosen], defaultForAssigned: dfa } : { audience: 'all' }) };
    try {
      const r = isNew
        ? await api<{ name: string; sha256: string }>(`/api/admin/profiles/${encodeURIComponent(opts.model)}/templates`, { method: 'POST', body: { ...body, isDefault } })
        : await api<{ name: string; sha256: string }>(`/api/admin/templates/${opts.id}`, { method: 'PATCH', body: { ...body, ...(isDefault && !opts.isDefault ? { isDefault: true } : {}) } });
      toast(`Template «${r.name}» salvato · ${r.sha256.slice(0, 12)}…`);
      setDirtyState(false);
      await onSaved();
    } catch (e) {
      const err = e as Error & { body?: { error?: string; report?: Report } };
      if (err.body?.report) setReport(err.body.report);
      throw new Error(MESSAGES[err.body?.error ?? ''] ?? err.message);
    }
  };

  return (
    <Card title={isNew ? `Nuovo template · ${opts.model}` : `Modifica template · ${opts.model} · ${opts.name}`}>
      {!isNew && opts.updatedAt && (
        <p className="ui-muted ui-small pf-p">
          Ultima modifica {date(opts.updatedAt)}
          {opts.updatedBy ? ` · ${opts.updatedBy}` : ''} · SHA-256 {opts.sha256?.slice(0, 16)}…
        </p>
      )}
      {isNew && (
        <label className="ui-btn ui-btn-secondary fw-file pf-backup">
          <input type="file" accept=".cfg,.txt,text/plain" onChange={(e) => e.target.files?.[0] && void loadBackup(e.target.files[0]).catch(fail)} />
          Parti da un backup della CPE (.cfg), facoltativo
        </label>
      )}
      <div className="ui-grid-form">
        <Field label="Nome">
          <input value={name} maxLength={60} placeholder="es. Standard, Palo alto, Bassa potenza" onChange={(e) => (setName(e.target.value), mark())} />
        </Field>
        <Field label="Board match (regex su /etc/board.info)">
          <input className="ui-mono" value={boardMatch} placeholder="es. board\.name=LiteBeam 5AC" onChange={(e) => (setBoardMatch(e.target.value), mark())} />
        </Field>
      </div>

      <section className="pf-sec">
        <h3>Chi può usarlo</h3>
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
                    {u.role === 'admin' ? ' (admin)' : ''}
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

      <section className="pf-sec">
        <h3>Configurazione</h3>
        <p className="ui-muted ui-small pf-p">Clic su un placeholder per inserirlo nel punto del cursore. Watchdog, SNMP, EIRP/ATPC e Device Name vengono comunque forzati dal server a ogni provisioning.</p>
        <div className="pf-chips">
          {placeholders.map((p) => (
            <button key={p.name} type="button" className="pf-chip" title={p.description} onClick={() => insert(`\${${p.name}}`)}>
              {`\${${p.name}}`}
            </button>
          ))}
        </div>
        <textarea ref={area} className="pf-code" spellCheck={false} autoComplete="off" rows={22} wrap="off" value={text} onChange={(e) => (setText(e.target.value), mark())} aria-label="Configurazione del template" />
        <span className="ui-muted ui-small">{text.split('\n').length} righe</span>
      </section>
      {report && <ReportView r={report} />}
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
        <details className="ui-details" open>
          <summary>{fromBackup.replacements.length} valori sostituiti dal backup</summary>
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
        <AsyncButton onClick={check} onError={fail}>
          Controlla
        </AsyncButton>
        <Button onClick={() => downloadText(`template-${opts.model.replace(/\s+/g, '-')}-${(name || 'nuovo').replace(/[^\w.-]+/g, '_')}.cfg`, text)}>Scarica</Button>
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
