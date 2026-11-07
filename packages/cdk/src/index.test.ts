import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.ts";

test("cdk package exposes its name", () => {
  expect(PACKAGE_NAME).toBe("@nikovirtala/cdk");
});
