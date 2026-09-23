import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: [],
    hookTimeout: 10000,
    testTimeout: 10000,
  },
});
