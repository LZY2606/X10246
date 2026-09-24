import { defineConfig } from "vite";
import { reviewApiPlugin } from "./src/server/vitePlugin";

export default defineConfig({
  root: ".",
  plugins: [reviewApiPlugin()],
  server: { strictPort: true },
});
