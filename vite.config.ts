import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'custom',
  logLevel: 'warn',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000
  }
});
