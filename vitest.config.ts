import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
    testTimeout: 15000,
    hookTimeout: 15000,
    include: ["tests/**/*.test.ts"],
  },
});
