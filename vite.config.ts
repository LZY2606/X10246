import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(async () => {
  const { apiMiddleware } = await import('./src/server/api.ts');
  return {
    root: fileURLToPath(new URL('./src/ui', import.meta.url)),
    server: {
      host: '127.0.0.1',
      port: 5356,
      strictPort: true,
      fs: { strict: true },
    },
    plugins: [
      {
        name: 'ledger-api',
        configureServer(server) {
          server.middlewares.use('/api', apiMiddleware());
        },
      },
    ],
  };
});
