import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.ts";

test("bridge package exposes its name", () => {
  expect(PACKAGE_NAME).toBe("@nikovirtala/kiro-remote-bridge");
});
