import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { reviewApiPlugin } from "./src/server/plugin";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@core": fileURLToPath(new URL("./src/core", import.meta.url))
    }
  },
  plugins: [reviewApiPlugin()],
  server: { host: "127.0.0.1", port: 5356, strictPort: true }
});
