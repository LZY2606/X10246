import type { Plugin } from 'vite';
import { Store } from './store';
import { createApiHandler } from './api';

export function fringeApiPlugin(dbPath: string): Plugin {
  return {
    name: 'fringe-book-api',
    configureServer(server) {
      const store = new Store(dbPath);
      const handler = createApiHandler(store);
      server.middlewares.use('/api', (req, res, next) => {
        void handler(req as never, res as never).catch(next);
      });
    },
  };
}
