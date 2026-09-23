import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startApi } from '../src/server/server';

const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const host = opt('--host', '127.0.0.1');
const port = Number(opt('--port', '5356'));
const strictPort = args.includes('--strictPort');
const apiPort = port + 1;
const dbPath =
  process.env.FRINGE_DB ?? new URL('../.data/fringe.db', import.meta.url).pathname;

const api = await startApi({ dbPath, host: '127.0.0.1', port: apiPort });
console.log(`[api] listening on http://127.0.0.1:${apiPort} (db: ${dbPath})`);

const server = await createServer({
  configFile: false,
  root: new URL('..', import.meta.url).pathname,
  plugins: [react()],
  server: {
    host,
    port,
    strictPort,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
await server.listen();
server.printUrls();

process.on('SIGINT', () => {
  api.close();
  void server.close().then(() => process.exit(0));
});
