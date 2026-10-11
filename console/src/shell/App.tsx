import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, session } from '../lib/api';
import { useLiveEvents } from '../lib/live';
import { keys, queryClient } from '../lib/query';
import { isOn, loadModules, modulesLoaded, resetModules } from '../../../web/js/modules.js';
import { toast } from '../../../web/js/dom.js';
import { setAdmin } from '../../../web/js/terms.js';
import { unreadCount } from '../../../web/js/views/notifications.js';
import { Icon } from '../ui/Icon';
import { CommandPalette } from './CommandPalette';
import { LegacyLogin, Page } from './Page';
import { allowed, isGroup, labelOf, ROUTES, type Route, type User } from './routes';
import { useTheme } from './theme';

interface Session {
  token: string;
  user: User;
  expiresAt: string;
}

const readHash = () => {
  const [path = '', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { path, query };
};

/** The page of the address, or the first one the user may open. */
function pick(path: string, user: User): Route {
  const routes = ROUTES.filter((r): r is Route => !isGroup(r));
  const id = path || (user.role === 'admin' ? 'dashboard' : 'jobs');
  return routes.find((r) => r.id === id && (r.legacy || r.react) && allowed(r, user, isOn)) ?? routes.find((r) => r.id === 'jobs')!;
}

/**
 * The frame of the console: top bar (pages at Ctrl+K, notifications, account, theme), menu on the
 * left (narrow to icons on request), a bottom bar on phones, and the page of the address.
 */
export function App() {
  const [s, setS] = useState<Session | null>(() => session.get());
  const [hash, setHash] = useState(readHash);
  const [modulesReady, setModulesReady] = useState(modulesLoaded());
  const [modulesRev, setModulesRev] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [narrow, setNarrow] = useState(() => localStorage.getItem('cda-menu') === 'narrow');
  const { theme, cycle } = useTheme();
  const user = s?.user ?? null;

  useEffect(() => {
    const onHash = () => {
      setHash(readHash());
      setMenuOpen(false);
      // the same session keeps the same object: the page and the polling do not start again
      setS((prev) => {
        const next = session.get() as Session | null;
        return next?.token === prev?.token ? prev : next;
      });
    };
    const onLogout = () => {
      queryClient.clear();
      toast('Sessione scaduta: accedi di nuovo', 'bad');
      setS(null);
    };
    // the Notifiche page tells the new count after marking read
    const onUnread = (e: Event) => queryClient.setQueryData(keys.unread, Number((e as CustomEvent).detail) || 0);
    const onModules = () => setModulesRev((n) => n + 1);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('cda:logout', onLogout);
    window.addEventListener('cda:unread', onUnread);
    window.addEventListener('cda:modules', onModules);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('cda:logout', onLogout);
      window.removeEventListener('cda:unread', onUnread);
      window.removeEventListener('cda:modules', onModules);
    };
  }, []);

  // after login: role words for the pages of web/js, the modules on
  useEffect(() => {
    if (!user) return;
    setAdmin(user.role === 'admin');
    if (!modulesLoaded()) void loadModules().then(() => setModulesReady(true));
  }, [s?.token]);

  // unread notifications: at once when the server says so (live events), else every 5 minutes
  useLiveEvents(s?.token ?? null);
  const unread =
    useQuery({ queryKey: keys.unread, queryFn: async () => (await unreadCount()) ?? 0, enabled: !!s?.token, refetchInterval: 5 * 60_000, staleTime: 60_000 }).data ?? 0;

  // Ctrl+K (or /) opens the pages, Escape closes the menu
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === '/' && !typing && user) {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [user]);

  const started = useCallback((d: { token: string; user: User; expiresAt: string; mfaSetupRequired?: boolean }) => {
    session.set({ token: d.token, user: d.user, expiresAt: d.expiresAt });
    toast(`Benvenuto ${d.user.username}`);
    if (d.mfaSetupRequired) {
      toast('Per gli amministratori la verifica in due passaggi è obbligatoria: attivala ora', 'bad');
      location.hash = '#/account';
    }
    setS(session.get());
    setHash(readHash());
  }, []);

  const logout = () => {
    session.clear();
    queryClient.clear();
    resetModules();
    setModulesReady(false);
    location.hash = '';
    setS(null);
  };

  const visible = useMemo(
    () => (user ? ROUTES.filter((r) => (isGroup(r) ? !r.admin || user.role === 'admin' : allowed(r, user, isOn) && !r.hidden)) : []),
    [user, modulesReady, modulesRev],
  );

  if (!s || !user) {
    return (
      <div className="cx-login">
        <LegacyLogin
          onLogin={async (username: string, password: string) => {
            const d = await api('/api/auth/login', { method: 'POST', body: { username, password } });
            if (d.mfaRequired) return { mfaToken: d.mfaToken };
            started(d);
            return {};
          }}
          onTotp={async (mfaToken: string, code: string) => started(await api('/api/auth/login/totp', { method: 'POST', body: { mfaToken, code } }))}
        />
      </div>
    );
  }

  const route = pick(hash.path, user);
  const active = route.parent ?? route.id;
  const bottom = visible.filter((r): r is Route => !isGroup(r) && !!r.bottom).slice(0, 4);
  const pages = visible.filter((r): r is Route => !isGroup(r));

  return (
    <div className={`cx-app${narrow ? ' narrow' : ''}`}>
      <header className="cx-top">
        <button className="cx-icon-btn cx-menu-btn" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <Icon name="menu" />
        </button>
        <a className="cx-brand" href="#/">
          <img src="/assets/cda-net-logo.svg" alt="CDA Net" />
          <span>CPE Configurator</span>
        </a>
        <button className="cx-search" onClick={() => setPalette(true)} aria-label="Vai a una pagina">
          <Icon name="search" />
          <span>Vai a…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <span className="cx-spacer" />
        <button className="cx-icon-btn" onClick={cycle} title={`Tema: ${theme === 'dark' ? 'scuro' : theme === 'light' ? 'chiaro' : 'come il sistema'}`} aria-label="Cambia tema">
          <Icon name={theme === 'dark' ? 'dark_mode' : theme === 'light' ? 'light_mode' : 'contrast'} />
        </button>
        <a className="cx-icon-btn cx-bell" href="#/notifications" title="Notifiche" aria-label={unread ? `Notifiche, ${unread} da leggere` : 'Notifiche'}>
          <Icon name="notifications" />
          {unread > 0 && <span className="cx-count">{unread > 99 ? '99+' : unread}</span>}
        </a>
        <a className="cx-user" href="#/account" title="Il mio account">
          <span className="cx-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
          <span className="cx-user-name">
            {user.username}
            <small>{user.role === 'admin' ? 'Admin' : 'Installatore'}</small>
          </span>
        </a>
        <button className="cx-icon-btn" onClick={logout} title="Esci" aria-label="Esci">
          <Icon name="logout" />
        </button>
      </header>
      <div className="cx-body">
        <nav className={`cx-nav${menuOpen ? ' open' : ''}`} aria-label="Menu">
          {visible.map((r, i) =>
            isGroup(r) ? (
              <div className="cx-group" key={`g${i}`}>
                {r.group}
              </div>
            ) : r.href ? (
              <a key={r.id} href={r.href} target="_blank" rel="noopener" title={r.label}>
                <Icon name={r.icon} />
                <span>{r.label}</span>
              </a>
            ) : (
              <a key={r.id} href={`#/${r.id}`} className={r.id === active ? 'active' : ''} aria-current={r.id === active ? 'page' : undefined} title={labelOf(r, user)}>
                <Icon name={r.icon} />
                <span>{labelOf(r, user)}</span>
                {r.id === 'notifications' && unread > 0 && <span className="cx-count">{unread > 99 ? '99+' : unread}</span>}
              </a>
            ),
          )}
          <button
            className="cx-narrow-btn"
            onClick={() => {
              localStorage.setItem('cda-menu', narrow ? 'wide' : 'narrow');
              setNarrow(!narrow);
            }}
            title={narrow ? 'Allarga il menu' : 'Stringi il menu'}
          >
            <Icon name={narrow ? 'chevron_right' : 'chevron_left'} />
            <span>{narrow ? 'Allarga' : 'Stringi il menu'}</span>
          </button>
        </nav>
        {menuOpen && <div className="cx-shade" onClick={() => setMenuOpen(false)} />}
        <main className="view cx-main" aria-live="polite">
          {modulesReady ? <Page key={`${route.id}?${hash.query}#${modulesRev}`} route={route} user={user} query={hash.query} /> : <p className="muted">Caricamento…</p>}
        </main>
      </div>
      <nav className="cx-bottom" aria-label="Pagine principali">
        {bottom.map((r) => (
          <a key={r.id} href={`#/${r.id}`} className={r.id === active ? 'active' : ''}>
            <Icon name={r.icon} />
            <span>{labelOf(r, user)}</span>
          </a>
        ))}
        <button onClick={() => setMenuOpen(true)}>
          <Icon name="menu" />
          <span>Altro</span>
        </button>
      </nav>
      {palette && <CommandPalette pages={pages} user={user} onClose={() => setPalette(false)} />}
    </div>
  );
}
