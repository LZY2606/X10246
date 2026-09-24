import { defineConfig, type Plugin } from 'vitest/config';
import { createApiMiddleware } from './src/server/api';

function apiPlugin(): Plugin {
  return {
    name: 'fringe-book-api',
    configureServer(server) {
      const dbPath = process.env.PWG_DB || 'data/app.db';
      server.middlewares.use('/api', createApiMiddleware(dbPath));
    },
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
