import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react';
import { Icon } from './Icon';

/**
 * The components of the console: every converted page is made of these, so the console looks like
 * one product. Colours, spacing and type come from the tokens (styles/tokens.css), the same in both
 * themes; nothing is styled inside a page.
 */

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'brand';

export function Button({ variant = 'secondary', icon, busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: string; busy?: boolean }) {
  return (
    <button type="button" {...rest} className={`ui-btn ui-btn-${variant} ${rest.className ?? ''}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy ? <span className="ui-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

/** A button that runs [onClick] and stays busy until it ends (errors go to [onError]). */
export function AsyncButton({ onClick, onError, ...rest }: Omit<Parameters<typeof Button>[0], 'onClick'> & { onClick: () => Promise<unknown>; onError?: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      {...rest}
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } catch (e) {
          onError?.(e);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

export function PageHeader({ icon, title, subtitle, actions }: { icon?: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="ui-page-head">
      <div>
        <h1>
          {icon && (
            <span className="ui-head-icon">
              <Icon name={icon} />
            </span>
          )}
          {title}
        </h1>
        {subtitle && <p className="ui-muted">{subtitle}</p>}
      </div>
      {actions && <div className="ui-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, actions, children, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; padded?: boolean }) {
  return (
    <section className={`ui-card${padded ? '' : ' flush'}`}>
      {(title || actions) && (
        <header className="ui-card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="ui-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`ui-badge ui-tone-${tone}`}>{children}</span>;
}

export function Notice({ tone = 'info', title, children }: { tone?: Exclude<Tone, 'neutral' | 'brand'>; title?: string; children?: ReactNode }) {
  const ic = tone === 'good' ? 'check_circle' : tone === 'bad' ? 'error_filled' : 'warning_filled';
  return (
    <div className={`ui-notice ui-tone-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon name={ic} />
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

/** A number with its label; with [onClick] it is also a filter (selected = [active]). */
export function Stat({ label, value, tone = 'neutral', hint, active, onClick }: { label: string; value: ReactNode; tone?: Tone; hint?: string; active?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <span className="ui-stat-value">{value ?? '—'}</span>
      <span className="ui-stat-label">{label}</span>
      {hint && <span className="ui-stat-hint">{hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={`ui-stat ui-tone-${tone}${active ? ' active' : ''}`} aria-pressed={!!active} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`ui-stat ui-tone-${tone}`}>{body}</div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className={`ui-field${error ? ' invalid' : ''}`}>
      <span className="ui-field-label">{label}</span>
      {children}
      {error ? <span className="ui-field-error">{error}</span> : hint ? <span className="ui-field-hint">{hint}</span> : null}
    </label>
  );
}

/** One choice among a few, side by side (filters, views). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ui-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'check_circle', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="ui-empty">
      <Icon name={icon} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="ui-skeleton" aria-label="Caricamento">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="ui-sk" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export { Icon };
