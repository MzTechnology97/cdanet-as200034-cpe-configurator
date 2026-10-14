import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Card, Notice, PageHeader, Skeleton } from '../ui';

/**
 * Guida amministratore: the server's own guide (an admin-only route, a static file with no device
 * or user data), so it is shown as the HTML it is, without scripts. Its images come from another
 * admin-only route with the session and are shown as data: URLs. A click on a screenshot opens it
 * full screen (arrows for the others, real size, Esc or the back button to close).
 */

async function imageUrl(name: string): Promise<string | null> {
  const r = await api<Response>(`/api/admin/guide/img/${encodeURIComponent(name)}`, { raw: true });
  if (!r.ok) return null;
  const blob = await r.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

export function Guide() {
  const q = useQuery({ queryKey: ['admin', 'guide'], queryFn: () => api<{ html: string }>('/api/admin/guide'), staleTime: Infinity });
  const body = useRef<HTMLElement>(null);
  const [photos, setPhotos] = useState<Array<{ src: string; alt: string; caption: string }>>([]);
  const [open, setOpen] = useState<number | null>(null);

  // the guide's markup, without anything that runs, then its images read with the session
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !q.data) return;
    const doc = new DOMParser().parseFromString(q.data.html, 'text/html');
    for (const x of doc.querySelectorAll('script, iframe, object, embed')) x.remove();
    for (const x of doc.body.querySelectorAll('*')) for (const a of [...x.attributes]) if (a.name.startsWith('on')) x.removeAttribute(a.name);
    el.replaceChildren(...doc.body.childNodes);
    for (const img of el.querySelectorAll<HTMLImageElement>('img[data-guide]')) {
      void imageUrl(img.dataset.guide!)
        .then((src) => {
          if (src) img.src = src;
        })
        .catch(() => (img.alt = `${img.alt} (immagine non disponibile)`));
    }
  }, [q.data]);

  const figures = useCallback(() => [...(body.current?.querySelectorAll('figure') ?? [])].filter((f) => f.querySelector('img')), []);
  const show = (i: number) => {
    const list = figures().map((f) => ({ src: f.querySelector('img')!.src, alt: f.querySelector('img')!.alt, caption: f.querySelector('figcaption')?.textContent ?? '' }));
    if (!list.length) return;
    setPhotos(list);
    setOpen(((i % list.length) + list.length) % list.length);
  };
  // clicks inside the guide: the index scrolls within the page (the hash is the console's route),
  // a screenshot opens full screen
  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const a = t.closest?.('a[href^="#g-"]');
    if (a) {
      e.preventDefault();
      body.current?.querySelector(a.getAttribute('href')!)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const img = t.closest?.('figure img') as HTMLImageElement | null;
    if (img?.src) show(figures().findIndex((f) => f.contains(img)));
  };

  return (
    <div className="ui-page">
      <PageHeader
        icon="menu_book"
        title="Guida amministratore"
        subtitle="Come preparare il sistema, gestire installatori e rete. Visibile solo agli amministratori."
        actions={
          <a className="ui-btn ui-btn-secondary" href="/wiki/" target="_blank" rel="noopener">
            Guida installatore
          </a>
        }
      />
      <Card>
        {q.error ? <Notice tone="bad">{(q.error as Error).message}</Notice> : !q.data ? <Skeleton lines={10} /> : null}
        <article ref={body} className="guide" onClick={onClick} />
      </Card>
      {open !== null && photos[open] && <Lightbox photo={photos[open]} onPrev={() => show(open - 1)} onNext={() => show(open + 1)} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** A screenshot full screen: arrows for the others, real size to read the details, Esc or back to close. */
function Lightbox({ photo, onPrev, onNext, onClose }: { photo: { src: string; alt: string; caption: string }; onPrev: () => void; onNext: () => void; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const keys = useRef({ onPrev, onNext, onClose });
  keys.current = { onPrev, onNext, onClose };
  useEffect(() => {
    setZoomed(false);
    stage.current?.scrollTo(0, 0);
  }, [photo.src]);
  useEffect(() => {
    // same address: the back button just closes the photo, the console's router is not involved
    history.pushState({ lightbox: true }, '');
    let closedByHistory = false;
    const onPop = () => {
      closedByHistory = true;
      keys.current.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') keys.current.onClose();
      else if (e.key === 'ArrowLeft') keys.current.onPrev();
      else if (e.key === 'ArrowRight') keys.current.onNext();
    };
    document.body.classList.add('lb-open');
    window.addEventListener('popstate', onPop);
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('lb-open');
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('keydown', onKey);
      if (!closedByHistory && history.state?.lightbox) history.back();
    };
  }, []);
  return (
    <div className={`lightbox${zoomed ? ' zoomed' : ''}`} role="dialog" aria-modal="true" aria-label={photo.caption || 'Foto'}>
      <div ref={stage} className="lb-stage" onClick={(e) => e.target === stage.current && onClose()}>
        <img src={photo.src} alt={photo.alt} />
      </div>
      <p className="lb-caption">{photo.caption}</p>
      <button type="button" className="lb-close" aria-label="Chiudi" onClick={onClose}>
        ×
      </button>
      <button type="button" className="lb-prev" aria-label="Foto precedente" onClick={onPrev}>
        ‹
      </button>
      <button type="button" className="lb-next" aria-label="Foto successiva" onClick={onNext}>
        ›
      </button>
      <button type="button" className="lb-zoom" onClick={() => setZoomed(!zoomed)}>
        {zoomed ? 'Adatta allo schermo' : 'Dimensione reale'}
      </button>
    </div>
  );
}
