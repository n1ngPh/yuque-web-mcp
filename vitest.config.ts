import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 82,
        lines: 77,
      },
    },
  },
});
