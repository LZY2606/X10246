import { defineConfig } from 'vite';
import { interferometricApi } from './src/server/plugin.ts';

export default defineConfig({
  plugins: [interferometricApi()],
  server: { host: '127.0.0.1', port: 5356, strictPort: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/virtual-time.ts'],
    pool: 'forks',
    fileParallelism: false
  }
});
