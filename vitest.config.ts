import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Kiro spawns are slow; integration tests opt into longer budgets themselves.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
