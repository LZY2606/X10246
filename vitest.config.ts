import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@core": fileURLToPath(new URL("./src/core", import.meta.url))
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    sequence: { shuffle: false }
  }
});
