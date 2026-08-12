import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["recharts"],
          icons: ["@phosphor-icons/react"],
          react: ["react", "react-dom", "react-router-dom"]
        }
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./web/src/test/setup.ts"],
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["web/src/**/*.{ts,tsx}"],
      exclude: ["web/src/**/*.test.{ts,tsx}", "web/src/test/**", "web/src/main.tsx", "web/src/data/types.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70
      }
    }
  }
});
