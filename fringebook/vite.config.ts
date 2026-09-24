import { defineConfig } from 'vite';
import { fringebookApiPlugin } from './src/server/api';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5356, strictPort: true },
  plugins: [fringebookApiPlugin()],
});
