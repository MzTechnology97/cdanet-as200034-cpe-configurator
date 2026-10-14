// Guida: tap on a screenshot to see it full screen (arrows/swipe for the others, Esc or back to close).
(() => {
  const figures = [...document.querySelectorAll('main figure')].filter((f) => f.querySelector('img'));
  if (!figures.length) return;

  const box = document.createElement('div');
  box.className = 'lightbox';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML =
    '<div class="lb-stage"><img alt=""></div>' +
    '<p class="lb-caption"></p>' +
    '<button type="button" class="lb-close" aria-label="Chiudi">×</button>' +
    '<button type="button" class="lb-prev" aria-label="Foto precedente">‹</button>' +
    '<button type="button" class="lb-next" aria-label="Foto successiva">›</button>' +
    '<button type="button" class="lb-zoom">Dimensione reale</button>';
  document.body.append(box);
  const stage = box.querySelector('.lb-stage');
  const img = box.querySelector('img');
  const caption = box.querySelector('.lb-caption');
  const zoomBtn = box.querySelector('.lb-zoom');
  let index = -1;

  function show(i) {
    index = (i + figures.length) % figures.length;
    const src = figures[index].querySelector('img');
    img.src = src.currentSrc || src.src;
    img.alt = src.alt;
    caption.textContent = figures[index].querySelector('figcaption')?.textContent ?? '';
    setZoom(false);
  }
  function setZoom(on) {
    box.classList.toggle('zoomed', on);
    zoomBtn.textContent = on ? 'Adatta allo schermo' : 'Dimensione reale';
    stage.scrollTo(0, 0);
  }
  function open(i) {
    show(i);
    box.hidden = false;
    document.body.classList.add('lb-open');
    // the back button (browser or phone) closes the photo instead of leaving the guide
    history.pushState({ lightbox: true }, '');
    box.querySelector('.lb-close').focus();
  }
  function close(fromHistory) {
    if (box.hidden) return;
    box.hidden = true;
    document.body.classList.remove('lb-open');
    if (!fromHistory && history.state?.lightbox) history.back();
  }

  figures.forEach((f, i) => {
    const el = f.querySelector('img');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.title = 'Tocca per ingrandire';
    el.addEventListener('click', () => open(i));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), open(i));
    });
  });
  box.querySelector('.lb-close').addEventListener('click', () => close(false));
  box.querySelector('.lb-prev').addEventListener('click', () => show(index - 1));
  box.querySelector('.lb-next').addEventListener('click', () => show(index + 1));
  zoomBtn.addEventListener('click', () => setZoom(!box.classList.contains('zoomed')));
  stage.addEventListener('click', (e) => {
    if (e.target === stage) close(false);
  });
  window.addEventListener('popstate', () => close(true));
  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') close(false);
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
  });
  // horizontal swipe changes photo (only when not zoomed, where the finger pans the image)
  let startX = null;
  stage.addEventListener('touchstart', (e) => (startX = e.touches.length === 1 ? e.touches[0].clientX : null), { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (startX === null || box.classList.contains('zoomed')) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 60) show(index + (dx < 0 ? 1 : -1));
    startX = null;
  });
})();

// Guida da telefono: indice a pannello (tasto «Indice» nella barra in alto), capitolo corrente
// evidenziato, tasto per tornare su e tabelle che scorrono di lato invece di uscire dallo schermo.
(() => {
  const toc = document.querySelector('nav.toc');
  const header = document.querySelector('header.top');
  if (!toc || !header) return;

  // tables: their own horizontal scroll on a narrow screen
  for (const t of document.querySelectorAll('main table')) {
    if (t.parentElement?.classList.contains('table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    t.replaceWith(wrap);
    wrap.append(t);
  }

  // the index as a panel on the phone
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toc-toggle';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'toc');
  btn.textContent = 'Indice';
  toc.id = 'toc';
  header.insertBefore(btn, header.querySelector('a.back'));
  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'toc-filter';
  filter.placeholder = 'Cerca nell’indice…';
  filter.setAttribute('aria-label', 'Cerca nell’indice');
  toc.prepend(filter);
  const setOpen = (open) => {
    document.body.classList.toggle('toc-open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) filter.focus({ preventScroll: true });
  };
  btn.addEventListener('click', () => setOpen(!document.body.classList.contains('toc-open')));
  toc.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('toc-open')) setOpen(false);
  });
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const li of toc.querySelectorAll('li')) {
      const hit = !q || li.textContent.toLowerCase().includes(q);
      li.hidden = !hit;
    }
  });

  // the chapter on screen, highlighted in the index
  const links = new Map([...toc.querySelectorAll('a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
  const heads = [...document.querySelectorAll('main h2[id], main h3[id]')].filter((h) => links.has(h.id));
  if ('IntersectionObserver' in window && heads.length) {
    let current = null;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) current = e.target.id;
        for (const [id, a] of links) a.classList.toggle('here', id === current);
      },
      { rootMargin: '-70px 0px -70% 0px' },
    );
    heads.forEach((h) => io.observe(h));
  }

  // back to the top
  const up = document.createElement('a');
  up.href = '#inizio';
  up.className = 'to-top';
  up.setAttribute('aria-label', 'Torna all’inizio');
  up.textContent = '↑';
  document.body.append(up);
  const onScroll = () => up.classList.toggle('show', window.scrollY > 900);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
