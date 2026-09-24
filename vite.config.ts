import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiPlugin } from './src/server/vite-plugin-api.ts';

export default defineConfig({
  plugins: [react(), apiPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
