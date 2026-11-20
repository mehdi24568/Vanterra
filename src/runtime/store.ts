import { useSyncExternalStore } from 'react';

/**
 * Minimal external store. The simulation and render loops never touch React;
 * they publish snapshots here a few times per second and components subscribe to
 * exactly the slice they need.
 */
export interface Store<T extends object> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      let changed = false;
      for (const key in patch) {
        if (!Object.is(patch[key], state[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribe to one slice. The selector must return a primitive or a stable reference. */
export function useStore<T extends object, S>(store: Store<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

export function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a) as Array<keyof typeof a>;
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], (b as typeof a)[k])) return false;
  return true;
}
