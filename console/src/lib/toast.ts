/** The short message at the bottom of the console (#toast in index.html); [kind] 'bad' for errors. */
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => (el.hidden = true), 4200);
}
