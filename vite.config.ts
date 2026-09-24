import { defineConfig, type Plugin } from 'vite';
import { startApiServer } from './src/server/api';
import { Store } from './src/server/store';
import { systemClock } from './src/shared/clock';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// 演示模式：Vite 开发服务器内嵌 API 进程，/api 代理到 5357。
// 数据库落在仓库 data/dev.db，可用 /api/reset 删除后重放导入。
function apiPlugin(): Plugin {
  let started = false;
  return {
    name: 'fringe-logbook-api',
    configureServer() {
      if (started) return;
      started = true;
      const dataDir = path.resolve(__dirname, 'data');
      mkdirSync(dataDir, { recursive: true });
      const store = new Store(path.join(dataDir, 'dev.db'), systemClock());
      const server = startApiServer(store, { host: '127.0.0.1', port: 5357 });
      server.unref?.();
    },
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:5357', changeOrigin: false },
    },
  },
});
