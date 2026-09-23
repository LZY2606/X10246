import { defineConfig } from "vite";
import { reviewApiPlugin } from "./src/server/plugin";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5356,
    strictPort: true,
  },
  plugins: [reviewApiPlugin()],
});
