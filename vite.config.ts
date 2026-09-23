import { defineConfig } from 'vitest/config';
import { ledgerApiPlugin } from './src/server/vite-plugin-ledger';

export default defineConfig({
  plugins: [ledgerApiPlugin()],
  server: { host: '127.0.0.1', port: 5356, strictPort: true },
  build: { outDir: '../dist' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000
  }
});
