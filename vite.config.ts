import { defineConfig } from "vite";
import { apiServerPlugin } from "./src/server/plugin";

export default defineConfig({
  root: ".",
  server: {
    host: "127.0.0.1",
    port: 5356,
    strictPort: true
  },
  plugins: [apiServerPlugin()]
});
