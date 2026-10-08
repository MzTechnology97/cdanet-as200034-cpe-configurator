/**
 * Tiny DOM helpers. All text goes through textContent: no innerHTML with data,
 * so values coming from devices or the API can never inject markup.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

let toastTimer;
export function toast(message, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export const stat = (label, value) => h('div', { class: 'stat' }, h('small', {}, label), h('strong', {}, value ?? '—'));

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);

export function statusBadge(status) {
  const map = { success: ['Completato', 'good'], failed: ['Fallito', 'bad'], prepared: ['Preparato', 'warn'], expired: ['Scaduto', ''] };
  const [t, k] = map[status] ?? [status, ''];
  return badge(t, k);
}

export const card = (...children) => h('section', { class: 'card' }, ...children);

export function pageHead(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null), h('div', { class: 'btns' }, ...actions));
}

export function field(label, input) {
  return h('label', {}, label, input);
}

/** Runs an async action with the button disabled; reports errors as a toast. */
export async function busy(button, fn) {
  button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), 'bad');
    return undefined;
  } finally {
    button.disabled = false;
  }
}

export function table(columns, rows, onRow) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c.label)))),
      h(
        'tbody',
        {},
        rows.length
          ? rows.map((r) =>
              h(
                'tr',
                { class: onRow ? 'clickable' : '', onclick: onRow ? () => onRow(r) : undefined },
                // data-label lets narrow screens render each row as a labelled card.
                columns.map((c) => h('td', { 'data-label': c.label || null }, c.render ? c.render(r) : r[c.key] ?? '—')),
              ),
            )
          : h('tr', {}, h('td', { colspan: columns.length, class: 'muted empty' }, 'Nessun elemento.')),
      ),
    ),
  );
}
