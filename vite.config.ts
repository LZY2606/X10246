import { defineConfig, Plugin } from 'vite';
import { mkdirSync, rmSync } from 'node:fs';
import { Store } from './src/server/store.js';
import { handleApi } from './src/server/api.js';

const DB_PATH = 'data/dev.db';

function apiPlugin(): Plugin {
  let store: Store;
  const open = () => {
    mkdirSync('data', { recursive: true });
    store = new Store(DB_PATH);
  };
  return {
    name: 'interference-book-api',
    configureServer(server) {
      open();
      server.middlewares.use('/api', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const url = req.url ?? '/';
          if (req.method === 'POST' && url === '/dev/reset') {
            // 开发辅助：删除本地数据库（演示 导出→删除→导入 流程）。
            store.db.close();
            rmSync(DB_PATH, { force: true });
            rmSync(`${DB_PATH}-wal`, { force: true });
            rmSync(`${DB_PATH}-shm`, { force: true });
            open();
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          let body: unknown;
          const text = Buffer.concat(chunks).toString('utf8');
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'invalid JSON body' }));
              return;
            }
          }
          const r = handleApi(store, req.method ?? 'GET', url, body);
          res.statusCode = r.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(r.body));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  server: { host: '127.0.0.1' },
});
