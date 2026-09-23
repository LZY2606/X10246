import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiServerPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [react(), apiServerPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5356,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
