import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiMiddleware } from './server/api';

function pgsbApi(): Plugin {
  return {
    name: 'pgsb-api',
    configureServer(server) {
      server.middlewares.use('/api', createApiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [react(), pgsbApi()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
