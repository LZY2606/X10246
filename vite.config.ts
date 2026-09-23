import { defineConfig } from 'vite';
import { fringeApiPlugin } from './src/server/vitePlugin';

export default defineConfig({
  plugins: [fringeApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5356,
    strictPort: true
  }
});
