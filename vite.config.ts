import { defineConfig } from "vite";
import { resolve } from "node:path";
import { apiMiddleware } from "./src/server/api-middleware.js";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5356,
    strictPort: true,
  },
  plugins: [
    {
      name: "interference-ledger-api",
      configureServer(server) {
        server.middlewares.use("/api", apiMiddleware({ dbPath: resolve("data/ledger.sqlite") }));
      },
    },
  ],
});
