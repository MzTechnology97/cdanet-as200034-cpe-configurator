/**
 * React in the console, without a build step: React and ReactDOM (vendored, production builds)
 * are loaded the first time a React page opens, and the components are written with htm (tagged
 * templates instead of JSX: `html\`<${Card} title=${t}>…</${Card}>\``). The other pages stay as
 * they are; a React page is a view like the others (see reactView).
 *
 * Text is always escaped by React: like dom.js, no markup from data can get into the page.
 */
import htm from '../vendor/htm/htm.module.js';

let loading = null;
const script = (src) =>
  new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Pagina non disponibile: ricarica la console'));
    document.head.append(s);
  });

/** Loads React once (the other pages never pay for it). */
export function loadReact() {
  loading ??= (async () => {
    if (!window.React) await script('/vendor/react/react.production.min.js');
    if (!window.ReactDOM) await script('/vendor/react/react-dom.production.min.js');
  })();
  return loading;
}

/** Components as tagged templates; React is looked up at render time (after loadReact). */
export const html = htm.bind((type, props, ...children) => window.React.createElement(type, props, ...children));

// the hooks, so the pages import them from here like the rest
export const useState = (...a) => window.React.useState(...a);
export const useEffect = (...a) => window.React.useEffect(...a);
export const useMemo = (...a) => window.React.useMemo(...a);
export const useRef = (...a) => window.React.useRef(...a);
export const useCallback = (...a) => window.React.useCallback(...a);
export const Fragment = (props) => window.React.createElement(window.React.Fragment, null, props.children);

/**
 * A React page for the router: an element with [Component] rendered inside, unmounted (timers and
 * requests of its effects stopped) as soon as another page replaces it.
 */
export async function reactView(Component, props = {}) {
  await loadReact();
  const el = document.createElement('div');
  const root = window.ReactDOM.createRoot(el);
  // drawn at once: the router decorates the page title right after this function returns
  window.ReactDOM.flushSync(() => root.render(window.React.createElement(Component, props)));
  const view = document.getElementById('view');
  if (view) {
    // the router attaches the element after this function returns: once it has been in the page,
    // leaving it (another page) unmounts the components
    let shown = false;
    const watch = new MutationObserver(() => {
      if (el.isConnected) shown = true;
      else if (shown) {
        watch.disconnect();
        root.unmount();
      }
    });
    watch.observe(view, { childList: true });
  }
  return el;
}
