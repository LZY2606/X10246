import { defineConfig } from 'vite';
import { apiPlugin } from './src/server/vitePlugin';

export default defineConfig({
  root: 'src/client',
  plugins: [apiPlugin()],
  build: { outDir: '../../dist', emptyOutDir: true }
});
