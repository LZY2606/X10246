import { defineConfig } from 'vite';
import { apiPlugin } from './server/index';

export default defineConfig({
  plugins: [apiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5356,
    strictPort: true,
  },
});
