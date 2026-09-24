import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiHandler } from './server/app';

function apiPlugin(): Plugin {
  return {
    name: 'interferogram-api',
    configureServer(server) {
      const handler = createApiHandler({
        dbPath: process.env.INTERFEROGRAM_DB ?? 'data/interferogram.db',
      });
      server.middlewares.use('/api', (req, res) => {
        void handler(req, res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
