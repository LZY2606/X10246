import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ["sql.js"] },
  server: { host: "127.0.0.1", port: 5356, strictPort: true },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks"
  }
});
