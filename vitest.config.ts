import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    sequence: { concurrent: false },
    pool: "forks",
    fileParallelism: false,
    globals: false,
    reporters: ["default"]
  }
});
