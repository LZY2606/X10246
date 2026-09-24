import { defineConfig } from 'vite';
import { interferometryApi } from './src/server/vite-plugin';

export default defineConfig({
  plugins: [interferometryApi()],
  server: { strictPort: true },
});
