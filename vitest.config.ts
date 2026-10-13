import { defineConfig } from 'vitest/config';

// Tests run against the TypeScript sources, not the built output, so `npm test` works before `npm run build`.
export default defineConfig({
  resolve: { conditions: ['ghillie-source'] },
  ssr: { resolve: { conditions: ['ghillie-source'], externalConditions: ['ghillie-source'] } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'evals/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
