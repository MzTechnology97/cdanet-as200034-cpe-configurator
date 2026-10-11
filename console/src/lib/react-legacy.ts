/**
 * web/js/react.js inside the build: the pages written with htm (Stato rete, Copertura, Guasti Enel,
 * IA-AP…) use the React of the console instead of loading a second one (the vendored React 18, 148
 * KB) on their first opening. The same exports; vite.config.ts puts this module in place of that
 * one for every import from web/js.
 *
 * A page made by reactView is unmounted (its timers and requests stopped) when the frame removes
 * it: the frame calls `unmountLegacy` on the element it is leaving.
 */
import { createElement, Fragment as F, type ReactNode, useCallback as uc, useEffect as ue, useMemo as um, useRef as ur, useState as us } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import htm from '../../../web/vendor/htm/htm.module.js';

export async function loadReact(): Promise<void> {
  /* already there */
}

export const html = htm.bind(createElement as (type: unknown, props: unknown, ...children: unknown[]) => unknown);

export const useState = us;
export const useEffect = ue;
export const useMemo = um;
export const useRef = ur;
export const useCallback = uc;
export const Fragment = (props: { children?: ReactNode }) => createElement(F, null, props.children);

const ROOTS = new WeakMap<Element, Root>();

/**
 * A React page for the router: an element with [Component] rendered inside. Drawn right after the
 * frame puts it in the page (not before): the effects of the page (a map, a measurement) find
 * their element already in the document, as with the React of web/js.
 */
export async function reactView(Component: (props: Record<string, unknown>) => ReactNode, props: Record<string, unknown> = {}): Promise<HTMLElement> {
  const el = document.createElement('div');
  const root = createRoot(el);
  ROOTS.set(el, root);
  queueMicrotask(() => {
    if (ROOTS.get(el) === root) root.render(createElement(Component, props));
  });
  return el;
}

/** Unmounts the React pages inside [node] (the page the frame is leaving). */
export function unmountLegacy(node: Element | null | undefined) {
  if (!node) return;
  for (const el of [node, ...node.querySelectorAll('div')]) {
    const root = ROOTS.get(el);
    if (root) {
      ROOTS.delete(el);
      // after the frame's own render: React does not like an unmount during another render
      queueMicrotask(() => root.unmount());
    }
  }
}
