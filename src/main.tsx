import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AtlasRuntime } from './runtime/AtlasRuntime';
import './styles.css';
import './vanterra.css';
import { RuntimeContext } from './ui/context';

const DEFAULT_SEED = 20260112;

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

try {
  // The runtime lives outside React so that React re-mounts (StrictMode, HMR of
  // components) never restart the simulation or discard its history.
  const runtime = new AtlasRuntime({
    seed: Math.floor(readNumber(import.meta.env.VITE_ATLAS_SEED, DEFAULT_SEED, 1, 999_999_999)),
    prerollS: readNumber(import.meta.env.VITE_ATLAS_PREROLL_S, 120, 45, 600),
  });
  runtime.start();
  if (import.meta.env.DEV) (window as unknown as { __atlas?: AtlasRuntime }).__atlas = runtime;

  createRoot(root).render(
    <StrictMode>
      <RuntimeContext.Provider value={runtime}>
        <App />
      </RuntimeContext.Provider>
    </StrictMode>,
  );
} catch (err) {
  console.error('[atlas] failed to start', err);
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  const title = document.createElement('h1');
  title.textContent = 'ATLAS could not start';
  const detail = document.createElement('p');
  detail.textContent = err instanceof Error ? err.message : String(err);
  box.append(title, detail);
  root.append(box);
}
