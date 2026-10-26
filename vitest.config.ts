import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Let tests import server modules the same way the app does.
      '@': here('./src'),
      // The server-only guard is a browser-build guard; tests run in node.
      'server-only': here('./tests/stubs/server-only.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      // Placeholder only — never a real credential. Lets '@/db' initialize
      // its Pool object in tests; no connection is ever opened (pool.connect
      // is spied in the transaction-safety tests).
      DATABASE_URL: 'postgres://test:test@localhost:5432/fleetflow_test'
    }
  }
});
