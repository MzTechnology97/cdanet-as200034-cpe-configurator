import { Field, Segmented } from '../ui';

/**
 * The airOS form of a template, shared by CDA Net's archive (Profili airOS) and the specialist's
 * (I miei template): the fields come from the server (like the CPE's web interface), every change
 * is written into the text by the server, nothing is stored until «Salva».
 */

export type Section = 'wireless' | 'network' | 'services' | 'system';
export type Value = string | number | boolean;
export interface FieldDef {
  id: string;
  section: Section;
  label: string;
  hint: string;
  type: 'bool' | 'int' | 'ip' | 'host' | 'text' | 'select';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  only?: { wirelessMode?: 'station' | 'ap'; netMode?: 'router' | 'bridge' };
  policy?: { value: Value; message: string };
  experimental?: boolean;
  param?: true;
  fallback: Value | Record<string, Value>;
}

export interface Facts {
  lanIp: string | null;
  wirelessMode: 'station' | 'ap';
  netMode: 'router' | 'bridge';
  ptp: boolean;
}

export const SECTIONS: Array<{ value: Section; label: string }> = [
  { value: 'wireless', label: 'Wireless' },
  { value: 'network', label: 'Rete' },
  { value: 'services', label: 'Servizi' },
  { value: 'system', label: 'Sistema' },
];

export const modeText = (f: Facts) => `${f.wirelessMode === 'ap' ? 'Access Point' : 'Station'} ${f.ptp ? 'PtP' : 'PtMP'} · ${f.netMode === 'bridge' ? 'Bridge' : 'Router'}`;

export function downloadText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function FormField({ f, value, missing, warn, error, onChange, onCommit }: { f: FieldDef; value: Value; missing: boolean; warn?: string; error?: string; onChange: (v: Value) => void; onCommit: () => void }) {
  const hint = [f.hint, missing ? 'Non presente nel template: verrà scritto solo se lo cambi.' : '', f.experimental ? 'Chiave da provare al banco.' : ''].filter(Boolean).join(' ');
  if (f.type === 'bool') {
    return (
      <div className={`tp-bool${warn ? ' tp-warn' : ''}`}>
        <label className="ui-check">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span>
            <strong>{f.label}</strong>
            <span className="ui-field-hint">{hint}</span>
          </span>
        </label>
        {warn && <span className="tp-policy">{warn}</span>}
      </div>
    );
  }
  return (
    <div className={warn ? 'tp-warn' : ''}>
      <Field label={f.label} hint={hint} {...(error ? { error } : {})}>
        {f.type === 'select' && (f.options?.length ?? 0) <= 3 ? (
          <Segmented label={f.label} value={String(value)} options={f.options ?? []} onChange={(v) => onChange(v)} />
        ) : f.type === 'select' ? (
          <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className={f.type === 'ip' || f.type === 'host' ? 'ui-mono' : undefined}
            type={f.type === 'int' ? 'number' : 'text'}
            inputMode={f.type === 'int' ? 'numeric' : f.type === 'ip' ? 'decimal' : undefined}
            min={f.min}
            max={f.max}
            value={String(value)}
            onChange={(e) => onChange(f.type === 'int' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
            onBlur={onCommit}
          />
        )}
      </Field>
      {warn && <span className="tp-policy">{warn}</span>}
    </div>
  );
}
