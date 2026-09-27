import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { opticsApiPlugin } from './src/server/viteApiPlugin';

export default defineConfig({
  plugins: [react(), opticsApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5356,
    strictPort: true
  }
});
