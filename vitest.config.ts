import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    css: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    // `pnpm test:coverage` 出覆盖率；报告写到 coverage/（不入库）
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/**/__tests__/**",
        "src/test-setup.ts",
        "src/**/*.d.ts",
      ],
      reporter: ["text-summary", "json-summary", "html"],
      // 低于门槛时 `pnpm test:coverage` 直接失败
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
