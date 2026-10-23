import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },  // serial — tests share the test DB
    // TEST_RLS=1 (tests/rls/rlsMode.ts): run tests/setup.ts's beforeAll to the
    // end BEFORE the file's own. Vitest 1.x runs root beforeAll hooks in
    // parallel by default, so a file's fixtures start as soon as setup first
    // awaits — after the schema push, but before the raw-SQL objects, the
    // chart and (in this mode) the RLS policies and the app role's grants.
    ...(process.env.TEST_RLS === '1' ? { sequence: { hooks: 'stack' as const } } : {}),
  },
})
