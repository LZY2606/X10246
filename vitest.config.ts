import { defineConfig } from "vitest/config";
import { ledgerApiPlugin } from "./src/server/vite-plugin.ts";

export default defineConfig({
  plugins: [ledgerApiPlugin({ tempRoot: process.env.LEDGER_TMP_ROOT })],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20000
  }
});
