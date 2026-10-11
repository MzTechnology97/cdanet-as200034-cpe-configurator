import { type ComponentType, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { icon } from '../../../web/js/icons.js';
import { loginView } from '../../../web/js/views/login.js';
import { unmountLegacy } from '../lib/react-legacy';
import type { PageContext, Route, User } from './routes';

/**
 * The page of the address. A page of web/js returns DOM, mounted here as it is; a converted page is
 * a component. While it loads: a skeleton, not an empty area.
 */
export function Page({ route, user, query }: { route: Route; user: User; query: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [Comp, setComp] = useState<ComponentType<PageContext> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let gone = false;
    const params = new URLSearchParams(query);
    (async () => {
      try {
        if (route.react) {
          const C = await route.react();
          if (!gone) setComp(() => C);
        } else if (route.legacy) {
          const view = await route.legacy();
          // Funzionalità: a module turned on or off changes the menu
          const content = await view({ user, params, onChange: () => window.dispatchEvent(new Event('cda:modules')) });
          if (gone || !host.current) return;
          host.current.replaceChildren(content);
          // the section's icon next to the page title, as in the menu (a React page of web/js draws
          // its title a moment after it is in the page)
          if (route.icon) decorate(content as Element, route.icon);
        }
      } catch (e) {
        const err = e as { body?: { error?: string }; message?: string };
        // the console was updated while this page was open: its pieces have new names, reload once
        if (staleBuild(err.message) && reloadOnce()) return;
        if (err.body?.error === 'mfa_setup_required' && route.id !== 'account') {
          location.hash = '#/account';
          return;
        }
        if (!gone) setError(err.message || String(e));
      } finally {
        if (!gone) setLoading(false);
      }
    })();
    const node = host.current;
    return () => {
      gone = true;
      // a React page of web/js leaves with its page: its timers and requests stop
      unmountLegacy(node);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, user.id, user.role, query]);

  if (error) return <div className="notice bad">{error}</div>;
  return (
    <>
      {loading && <PageSkeleton />}
      {Comp ? <Comp user={user} params={new URLSearchParams(query)} /> : <div ref={host} />}
    </>
  );
}

/** The icon of the section before the page title, as soon as the title is there (at most 2 s). */
function decorate(content: Element, name: string) {
  const put = () => {
    const h1 = content.querySelector?.('.page-head h1');
    if (!h1) return false;
    if (!h1.querySelector('svg')) {
      const span = document.createElement('span');
      span.className = 'head-icon';
      span.append(icon(name));
      h1.prepend(span);
    }
    return true;
  };
  if (put() || !(content instanceof Element)) return;
  const watch = new MutationObserver(() => put() && watch.disconnect());
  watch.observe(content, { childList: true, subtree: true });
  setTimeout(() => watch.disconnect(), 2000);
}

/** A piece of the console that is no longer on the server (Chrome, Firefox, Safari wording). */
const staleBuild = (m?: string) => !!m && /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(m);

/** Reloads the page, at most once a minute (a server really down must not reload forever). */
function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem('cda-reloaded') ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem('cda-reloaded', String(Date.now()));
  } catch {
    return false;
  }
  location.reload();
  return true;
}

function PageSkeleton() {
  return (
    <div className="cx-skeleton" aria-label="Caricamento">
      <div className="cx-sk cx-sk-title" />
      <div className="cx-sk cx-sk-line" />
      <div className="cx-sk cx-sk-card" />
    </div>
  );
}

/** The login of the console (its form, its checks and the two-step code) inside the new frame. */
export function LegacyLogin({ onLogin, onTotp }: { onLogin: (u: string, p: string) => Promise<{ mfaToken?: string }>; onTotp: (t: string, c: string) => Promise<void> }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    host.current?.replaceChildren(loginView(onLogin, onTotp));
  }, []);
  return <div ref={host} />;
}
