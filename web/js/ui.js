/**
 * Shared React components of the console: the same look as the classic pages (same CSS classes),
 * so the pages moved to React and the others sit side by side.
 */
import { toast } from './dom.js';
import { html, useState } from './react.js';

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Title, subtitle and the actions on the right (the router adds the icon of the section). */
export const PageHead = ({ title, subtitle, children }) => html`
  <div class="page-head">
    <div><h1>${title}</h1>${subtitle ? html`<p class="muted">${subtitle}</p>` : null}</div>
    <div class="btns">${children}</div>
  </div>
`;

export const Card = ({ children, className = '' }) => html`<section class=${`card ${className}`}>${children}</section>`;

export const Badge = ({ kind = '', children }) => html`<span class=${`badge ${kind}`}>${children}</span>`;

export const Notice = ({ kind = '', children }) => html`<div class=${`notice ${kind}`}>${children}</div>`;

/**
 * A button for an async action: disabled while it runs, the error as a toast (like busy() of the
 * classic pages). [onClick] returns a promise.
 */
export function BusyButton({ onClick, className = '', children, ...rest }) {
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      await onClick();
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      setRunning(false);
    }
  };
  return html`<button ...${rest} type="button" class=${className} disabled=${running || !!rest.disabled} onClick=${run}>${children}</button>`;
}

/** Segmented control: [options] = [[value, label], …]. */
export const Segmented = ({ options, value, onChange, label }) => html`
  <div class="ia-seg" role="group" aria-label=${label}>
    ${options.map(([k, l]) => html`<button key=${k} type="button" class=${value === k ? 'on' : ''} aria-pressed=${value === k ? 'true' : 'false'} onClick=${() => onChange(k)}>${l}</button>`)}
  </div>
`;

/** A label above its control, as field() of the classic pages. */
export const Field = ({ label, children }) => html`<label>${label}${children}</label>`;
