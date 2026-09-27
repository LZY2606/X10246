import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fringeApiPlugin } from './src/server/vite-plugin';

export default defineConfig({
  plugins: [react(), fringeApiPlugin()],
  server: { host: '127.0.0.1', port: 5356, strictPort: true },
  preview: { host: '127.0.0.1', port: 5356, strictPort: true }
});
