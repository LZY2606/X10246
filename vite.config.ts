import { defineConfig } from 'vite';
import { interferometryApiPlugin } from './src/server/vitePlugin';

export default defineConfig({
  plugins: [interferometryApiPlugin()],
  server: { strictPort: true },
});
