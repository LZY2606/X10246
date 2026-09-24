import { defineConfig } from 'vite';
import { fringeBookApi } from './src/server/plugin';

export default defineConfig({
  plugins: [fringeBookApi()],
  server: { host: '127.0.0.1' },
});
