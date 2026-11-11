import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
      // Integration tests spawn a real child process (the fake ACP agent).
      testTimeout: 15000,
      hookTimeout: 15000,
    },
  }),
);
