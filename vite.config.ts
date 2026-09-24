import { defineConfig } from "vite";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { createApiMiddleware } from "./src/server/api.js";

// 离线演示：Vite 开发服务器同时承载只读/读写领域 API（node:sqlite），
// 前端为纯 TS，无需公网或额外服务进程。
export default defineConfig({
  root: resolve(__dirname, "src/web"),
  publicDir: resolve(__dirname, "public"),
  resolve: {
    alias: { "@core": resolve(__dirname, "src/core"), "@db": resolve(__dirname, "src/db") }
  },
  server: {
    host: "127.0.0.1",
    port: 5356,
    strictPort: true
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  },
  plugins: [
    {
      name: "interferometry-ledger-api",
      configureServer(server) {
        mkdirSync(resolve(__dirname, "data"), { recursive: true });
        const dbPath = process.env.LEDGER_DB ?? resolve(__dirname, "data/ledger.sqlite");
        const middleware = createApiMiddleware(dbPath);
        server.middlewares.use("/api", middleware);
      },
      configurePreviewServer(server) {
        mkdirSync(resolve(__dirname, "data"), { recursive: true });
        const dbPath = process.env.LEDGER_DB ?? resolve(__dirname, "data/ledger.sqlite");
        const middleware = createApiMiddleware(dbPath);
        server.middlewares.use("/api", middleware);
      }
    }
  ]
});
