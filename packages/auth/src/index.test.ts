import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.ts";

test("auth package exposes its name", () => {
  expect(PACKAGE_NAME).toBe("@kiro-remote/auth");
});
