import type { Plugin, ViteDevServer } from 'vite';
import { createServerApi } from './api.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = resolve(here, '../../.data/interference-ledger.sqlite');

export function ledgerApiPlugin(dbPath: string = DEFAULT_DB_PATH): Plugin {
  return {
    name: 'interference-ledger-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const localApi = createServerApi(dbPath);
      server.middlewares.use('/api', async (req, res) => {
        try {
          await localApi.handle(req, res);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.name : 'UnknownError',
              message: err instanceof Error ? err.message : String(err),
            })
          );
        }
      });
      server.httpServer?.once('close', () => localApi.close());
    },
  };
}
