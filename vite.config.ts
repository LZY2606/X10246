import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 离线优先：不访问公网。sql.js 的 wasm 通过 vite 的 ?url 资源在本地解析。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5356,
    strictPort: true,
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
  },
});
