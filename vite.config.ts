import { defineConfig } from 'vite';
import { fringeApiPlugin } from './src/server/vitePlugin';

export default defineConfig({
  plugins: [fringeApiPlugin(process.env.FRINGE_DB ?? './data/fringe.db')],
  server: { host: '127.0.0.1' },
});
