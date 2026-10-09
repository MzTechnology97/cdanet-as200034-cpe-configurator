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
    lightbox(body),
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

/** Click on a screenshot: full screen, arrows for the others, real size to read the details, Esc/back to close. */
function lightbox(body) {
  const figures = () => [...body.querySelectorAll('figure')].filter((f) => f.querySelector('img'));
  const img = h('img', { alt: '' });
  const caption = h('p', { class: 'lb-caption' });
  const stage = h('div', { class: 'lb-stage' }, img);
  const zoom = h('button', { type: 'button', class: 'lb-zoom' }, 'Dimensione reale');
  const box = h(
    'div',
    { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', hidden: true },
    stage,
    caption,
    h('button', { type: 'button', class: 'lb-close', 'aria-label': 'Chiudi', onclick: () => close(false) }, '×'),
    h('button', { type: 'button', class: 'lb-prev', 'aria-label': 'Foto precedente', onclick: () => show(index - 1) }, '‹'),
    h('button', { type: 'button', class: 'lb-next', 'aria-label': 'Foto successiva', onclick: () => show(index + 1) }, '›'),
    zoom,
  );
  let index = -1;
  const setZoom = (on) => {
    box.classList.toggle('zoomed', on);
    zoom.textContent = on ? 'Adatta allo schermo' : 'Dimensione reale';
    stage.scrollTo(0, 0);
  };
  function show(i) {
    const list = figures();
    index = (i + list.length) % list.length;
    const src = list[index].querySelector('img');
    img.src = src.src;
    img.alt = src.alt;
    caption.textContent = list[index].querySelector('figcaption')?.textContent ?? '';
    setZoom(false);
  }
  function close(fromHistory) {
    if (box.hidden) return;
    box.hidden = true;
    document.body.classList.remove('lb-open');
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    if (!fromHistory && history.state?.lightbox) history.back();
  }
  const onPop = () => close(true);
  const onKey = (e) => {
    if (e.key === 'Escape') close(false);
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
  };
  zoom.addEventListener('click', () => setZoom(!box.classList.contains('zoomed')));
  stage.addEventListener('click', (e) => {
    if (e.target === stage) close(false);
  });
  body.addEventListener('click', (e) => {
    const target = e.target.closest?.('figure img');
    if (!target?.src) return;
    show(figures().findIndex((f) => f.contains(target)));
    box.hidden = false;
    document.body.classList.add('lb-open');
    // same URL and hash: the console router is not involved, the back button just closes the photo
    history.pushState({ lightbox: true }, '');
    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
  });
  return box;
}
