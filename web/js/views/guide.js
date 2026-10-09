import { api } from '../api.js';
import { h, pageHead } from '../dom.js';

/**
 * Guida amministratore: page and images come from admin-only API routes, never from the public
 * web directory. The page is the server's own static guide file (no device or user data), so it
 * is parsed as HTML; images arrive with the session token and are shown as data: URLs.
 */
export async function adminGuideView() {
  const { html } = await api('/api/admin/guide');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('script, iframe, object, embed')) el.remove();
  const body = h('article', { class: 'guide' }, ...doc.body.childNodes);
  for (const img of body.querySelectorAll('img[data-guide]')) void loadImage(img);
  // index links scroll inside the page: the hash belongs to the console router (#/route)
  body.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#g-"]');
    if (!a) return;
    e.preventDefault();
    body.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return h(
    'div',
    {},
    pageHead('Guida amministratore', 'Come preparare il sistema, gestire installatori e rete. Visibile solo agli amministratori.', h('a', { class: 'button-link', href: '/wiki/', target: '_blank', rel: 'noopener' }, 'Guida installatore')),
    body,
  );
}

async function loadImage(img) {
  try {
    const r = await api(`/api/admin/guide/img/${encodeURIComponent(img.dataset.guide)}`, { raw: true });
    if (!r.ok) return;
    const blob = await r.blob();
    img.src = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  } catch {
    img.alt = `${img.alt} (immagine non disponibile)`;
  }
}
