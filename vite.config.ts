import { defineConfig, type Plugin } from 'vite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Store } from './src/server/store';
import { createApiMiddleware } from './src/server/api';
import { seedCasePack } from './src/server/casepack';

function apiPlugin(): Plugin {
  return {
    name: 'interferometry-api',
    configureServer(server) {
      const dbPath = process.env.GSB_DB_PATH ?? 'data/app.db';
      mkdirSync(dirname(dbPath), { recursive: true });
      const store = new Store(dbPath);
      seedCasePack(store);
      server.middlewares.use('/api', createApiMiddleware(store));
    },
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  server: { host: '127.0.0.1' },
});
