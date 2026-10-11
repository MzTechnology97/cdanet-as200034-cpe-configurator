import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { labelOf, type Route, type User } from './routes';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Ctrl+K: jump to a page by typing part of its name (arrows and Enter, or a click). The search of
 * CPEs, customers and APs joins it in the next phase.
 */
export function CommandPalette({ pages, user, onClose }: { pages: Route[]; user: User; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => {
    const words = norm(q).split(/\s+/).filter(Boolean);
    return pages.filter((r) => words.every((w) => norm(`${labelOf(r, user)} ${r.label} ${r.id}`).includes(w)));
  }, [q, pages, user]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setSel(0), [q]);

  const go = (r: Route | undefined) => {
    if (!r) return;
    if (r.href) window.open(r.href, '_blank', 'noopener');
    else location.hash = `#/${r.id}`;
    onClose();
  };

  return (
    <div className="cx-palette-shade" onMouseDown={onClose}>
      <div className="cx-palette" role="dialog" aria-modal="true" aria-label="Vai a una pagina" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cx-palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            placeholder="Vai a una pagina…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((i) => Math.min(i + 1, hits.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') go(hits[sel]);
            }}
            aria-controls="cx-palette-list"
            aria-activedescendant={hits[sel] ? `cx-p-${hits[sel].id}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="cx-palette-list" role="listbox">
          {hits.map((r, i) => (
            <li key={r.id} id={`cx-p-${r.id}`} role="option" aria-selected={i === sel} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => go(r)}>
              <Icon name={r.icon} />
              <span>{labelOf(r, user)}</span>
              <Icon name="arrow_forward" className="icon cx-go" />
            </li>
          ))}
          {!hits.length && <li className="cx-none">Nessuna pagina con «{q}»</li>}
        </ul>
      </div>
    </div>
  );
}
