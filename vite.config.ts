import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  server: {
    host: "127.0.0.1",
    port: 5356,
    strictPort: true,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
  },
  optimizeDeps: { exclude: ["sql.js"] },
});
