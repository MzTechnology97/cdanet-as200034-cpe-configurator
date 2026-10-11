import { useEffect, useMemo, useRef, useState } from 'react';
import { isOn } from '../../../web/js/modules.js';
import { Icon } from '../ui/Icon';
import { labelOf, type Route, type User } from './routes';
import { matches, useGlobalSearch, type Hit } from './search';

const GROUP: Record<Hit['kind'], string> = { cpe: 'CPE', customer: 'Clienti', ap: 'AP', job: 'Installazioni' };

interface Item {
  key: string;
  icon: string;
  title: string;
  sub?: string;
  group: string;
  go: () => void;
}

/**
 * Ctrl+K: pages by name and, from two letters, CPEs (name, MAC also without separators, AP),
 * customers (admins), APs and installations. Arrows and Enter, or a click.
 */
export function CommandPalette({ pages, user, onClose }: { pages: Route[]; user: User; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { hits, loading } = useGlobalSearch(q, user, (m) => isOn(m));

  const items = useMemo<Item[]>(() => {
    const open = (href: string) => () => {
      if (href.startsWith('http') || href.startsWith('/')) window.open(href, '_blank', 'noopener');
      else location.hash = href;
      onClose();
    };
    const pageItems = pages
      .filter((r) => !q.trim() || matches(q, labelOf(r, user), r.label, r.id))
      .slice(0, q.trim() ? 5 : 30)
      .map((r) => ({ key: `p:${r.id}`, icon: r.icon, title: labelOf(r, user), group: 'Pagine', go: open(r.href ?? `#/${r.id}`) }));
    return [...pageItems, ...hits.map((h) => ({ key: `${h.kind}:${h.id}`, icon: h.icon, title: h.title, sub: h.sub, group: GROUP[h.kind], go: open(h.href) }))];
  }, [q, pages, user, hits, onClose]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    if (sel >= items.length) setSel(Math.max(0, items.length - 1));
  }, [items.length, sel]);
  useEffect(() => {
    document.getElementById(`cx-p-${sel}`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  return (
    <div className="cx-palette-shade" onMouseDown={onClose}>
      <div className="cx-palette" role="dialog" aria-modal="true" aria-label="Cerca" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cx-palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            placeholder={user.role === 'admin' ? 'Pagina, cliente, CPE, MAC, AP, installazione…' : 'Pagina, CPE, MAC, AP, installazione…'}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') items[sel]?.go();
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="cx-palette-list"
            aria-activedescendant={items[sel] ? `cx-p-${sel}` : undefined}
          />
          {loading ? <span className="ui-spinner" aria-label="Ricerca in corso" /> : <kbd>Esc</kbd>}
        </div>
        <ul id="cx-palette-list" role="listbox">
          {items.flatMap((it, i) => [
            ...(i === 0 || items[i - 1]!.group !== it.group
              ? [
                  <li key={`g:${it.group}`} className="cx-palette-group" role="presentation">
                    {it.group}
                  </li>,
                ]
              : []),
            <li key={it.key} id={`cx-p-${i}`} role="option" aria-selected={i === sel} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={it.go}>
              <Icon name={it.icon} />
              <span className="cx-palette-text">
                <span>{it.title}</span>
                {it.sub && <small>{it.sub}</small>}
              </span>
              <Icon name="arrow_forward" className="icon cx-go" />
            </li>,
          ])}
          {!items.length && !loading && <li className="cx-none">Nessun risultato per «{q}»</li>}
        </ul>
      </div>
    </div>
  );
}
