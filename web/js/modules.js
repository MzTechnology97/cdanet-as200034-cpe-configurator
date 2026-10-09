import { api } from './api.js';

/** Enabled optional features ("Funzionalità"), from /api/meta. Unknown = on (older servers). */
let state = {};
let loaded = false;

export const isOn = (key) => state[key] !== false;
export const modulesLoaded = () => loaded;

export async function loadModules() {
  try {
    state = (await api('/api/meta')).modules ?? {};
  } catch {
    state = {};
  }
  loaded = true;
}

export function setModules(next) {
  state = next;
  loaded = true;
}

export function resetModules() {
  state = {};
  loaded = false;
}
