import { defineConfig } from 'vitest/config';

/**
 * The Vitest scopes of the testing architecture that have tests today, narrowest first. Component
 * tests exercise a component's public contract; integration tests cover one real boundary. The unit
 * scope joins with the first focused product rule, and the system scope with the assembled
 * application. Browser journeys live in tests/browser under Playwright, and recognition regressions
 * live in Python under src/recognition/python/tests and as retained browser cases in
 * tests/recognition.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Concurrent PGlite startups exhaust setup deadlines when workers scale with host CPU count.
    // Share a bounded pool across both projects, including focused npm test commands.
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: 'component',
          include: ['tests/component/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
        },
      },
    ],
  },
});
