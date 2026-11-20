/**
 * Evaluation harness configuration (separate from the unit tests).
 *
 *   npm run eval        offline: deterministic metrics over 10 seeds, plus agent-workflow
 *                       mechanics and governance checks with the scripted test double.
 *                       Never calls a model, never costs anything.
 *   npm run eval:live   a real model: runs the five-agent investigation on each fault
 *                       scenario through the configured provider: ANTHROPIC_API_KEY for
 *                       Claude, or ATLAS_LLM_PROVIDER=ollama for a local model. With
 *                       neither it fails, measuring nothing. On a CPU-only machine a local
 *                       run takes far longer than testTimeout; pass a larger one, for example
 *                       npm run eval:live -- --testTimeout=14400000 (4 hours).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 900_000,
    hookTimeout: 900_000,
    projects: [
      { extends: true, test: { name: 'eval', include: ['src/eval/**/*.eval.ts'] } },
      { extends: true, test: { name: 'live', include: ['src/eval/**/*.live.ts'] } },
    ],
  },
});
