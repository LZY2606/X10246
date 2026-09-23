import { defineConfig } from "vite";
import { apiMiddleware } from "./src/server/apiMiddleware";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  root: ".",
  plugins: [
    tsconfigPaths(),
    {
      name: "fringe-ledger-api",
      configureServer(server) {
        server.middlewares.use(apiMiddleware);
      }
    }
  ],
  server: {
    host: "127.0.0.1",
    port: 5356,
    strictPort: true
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "threads",
    fileParallelism: false,
    testTimeout: 20000
  }
});
