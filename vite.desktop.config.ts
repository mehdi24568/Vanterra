/**
 * Builds the Electron main process (desktop/main.ts) into one CommonJS file, with the AI
 * service and its dependencies bundled in, so the packaged app needs no node_modules.
 *
 *   npm run desktop        build and run the desktop app
 *   npm run desktop:dist   build the Windows installer into release/
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'desktop/main.ts',
    outDir: 'desktop-dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      external: ['electron'],
      output: { format: 'cjs', entryFileNames: 'main.cjs' },
    },
  },
  ssr: { noExternal: true },
});
