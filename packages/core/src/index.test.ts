import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.ts";

test("core package exposes its name", () => {
  expect(PACKAGE_NAME).toBe("@nikovirtala/core");
});
