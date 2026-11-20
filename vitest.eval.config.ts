/**
 * Evaluation harness configuration (separate from the unit tests).
 *
 *   npm run eval        offline: deterministic metrics over 10 seeds, plus agent-workflow
 *                       mechanics and governance checks with the scripted test double.
 *                       Never calls a model, never costs anything.
 *   npm run eval:live   a real model: runs the five-agent investigation on each fault
 *                       scenario through the configured provider. Needs ANTHROPIC_API_KEY
 *                       in .env.local and fails, measuring nothing, without one.
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
