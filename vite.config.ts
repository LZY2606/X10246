import { defineConfig } from 'vitest/config';
import { reviewApiPlugin } from './src/server/vite-plugin';

export default defineConfig({
  publicDir: 'cases',
  plugins: [reviewApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5356,
    strictPort: true
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    reporters: ['default']
  }
});
