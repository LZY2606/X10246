import { defineConfig, type Plugin } from 'vite';
import { createApiMiddleware } from './server/api';

function gsbApiPlugin(): Plugin {
  return {
    name: 'gsb-api',
    configureServer(server) {
      server.middlewares.use('/api', createApiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [gsbApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5356,
    strictPort: true,
  },
});
