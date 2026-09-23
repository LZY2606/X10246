import { defineConfig } from 'vite';
import { reviewApiPlugin } from './src/server/vitePlugin';

export default defineConfig({
  plugins: [reviewApiPlugin()],
  server: { host: '127.0.0.1' },
});
