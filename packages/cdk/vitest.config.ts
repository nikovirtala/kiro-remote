import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // A synth or a bundle takes a second alone and several when every package's suite
      // runs at once (`pnpm test`), so the default 5 s is not enough.
      testTimeout: 30_000,
    },
  }),
);
