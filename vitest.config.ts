import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { TEST_ENV } from './test/support/test-env.ts';

const src = fileURLToPath(new URL('./src', import.meta.url));
const generated = fileURLToPath(new URL('./prisma/generated', import.meta.url));

const resolve = {
  tsconfigPaths: true,
  // package.json "imports" resolve to dist/ at runtime; tests must run against src/.
  alias: [
    {
      find: /^#(core|infra|modules|shared)\/(.*)\.ts$/,
      replacement: `${src}/$1/$2.ts`,
    },
    {
      find: /^#generated\/(.*)\.ts$/,
      replacement: `${generated}/$1.ts`,
    },
  ],
};

// Two groups (TESTING_STANDARDS.md, TEST-01):
// - unit: fast, no services, `npm test`
// - db: endpoint tests and service tests on the real test database, `npm run test:e2e`
// One config so `npm run test:cov` measures both together (TEST-08).
export default defineConfig({
  resolve,
  test: {
    globals: true,
    root: './',
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/worker.ts', 'src/seed.ts', 'src/generate-openapi.ts', 'src/**/*.module.ts', 'src/**/*.spec.ts', 'src/**/*.db-spec.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          globals: true,
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        resolve,
        test: {
          name: 'db',
          globals: true,
          include: ['test/**/*.e2e-spec.ts', 'src/**/*.db-spec.ts'],
          env: TEST_ENV,
          globalSetup: ['./test/support/global-setup.ts'],
          setupFiles: ['./test/support/reset-database.ts'],
          // Files share one test database that is emptied before each test, so they must not overlap.
          fileParallelism: false,
        },
      },
    ],
  },
});
