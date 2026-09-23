import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: { outDir: 'dist/client' },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000
  }
});
