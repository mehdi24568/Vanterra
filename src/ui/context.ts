import { createContext, useContext } from 'react';
import type { AtlasRuntime, UiState } from '../runtime/AtlasRuntime';
import { useStore } from '../runtime/store';

export const RuntimeContext = createContext<AtlasRuntime | null>(null);

export function useRuntime(): AtlasRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('RuntimeContext is missing');
  return runtime;
}

/** Subscribe to one slice of the UI store. */
export function useUi<S>(selector: (state: UiState) => S): S {
  return useStore(useRuntime().store, selector);
}
