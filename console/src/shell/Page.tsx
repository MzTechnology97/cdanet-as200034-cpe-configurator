import { type ComponentType, useEffect, useState } from 'react';
import type { PageContext, Route, User } from './routes';

/** The page of the address: its component, loaded when opened. While it loads: a skeleton, not an empty area. */
export function Page({ route, user, query }: { route: Route; user: User; query: string }) {
  const [Comp, setComp] = useState<ComponentType<PageContext> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        if (!route.react) throw new Error(`Pagina ${route.id} non disponibile`);
        const C = await route.react();
        if (!gone) setComp(() => C);
      } catch (e) {
        const err = e as { message?: string };
        // the console was updated while this page was open: its pieces have new names, reload once
        if (staleBuild(err.message) && reloadOnce()) return;
        if (!gone) setError(err.message || String(e));
      } finally {
        if (!gone) setLoading(false);
      }
    })();
    return () => {
      gone = true;
    };
  }, [route]);

  if (error) return <div className="notice bad">{error}</div>;
  return (
    <>
      {loading && <PageSkeleton />}
      {Comp && <Comp user={user} params={new URLSearchParams(query)} />}
    </>
  );
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
