import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { atlasAi } from './server/atlasAi';

export default defineConfig(({ mode }) => {
  // Server-side configuration (API keys included) is read here, in the Node process.
  // Nothing without the VITE_ prefix is ever exposed to browser code.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), atlasAi(env)],
    server: { port: 5173, strictPort: false },
    build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
      // Scenario tests simulate minutes of plant time. On a busy laptop (for example while a
      // local model is running) the 5 s default was exceeded; the assertions are unchanged.
      testTimeout: 30_000,
    },
  };
});
