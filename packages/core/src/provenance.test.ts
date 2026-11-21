import { describe, expect, it } from "vitest";
import { parseResourceAttributes, resourceAttributes } from "./provenance.ts";

describe("the deploy's resource attributes", () => {
  it("are read from OTEL_RESOURCE_ATTRIBUTES, percent-decoded", () => {
    expect(
      resourceAttributes({
        OTEL_RESOURCE_ATTRIBUTES:
          "vcs.ref.head.revision=9bb4f62,deployment.environment.name=production,service.version=1.0%20beta",
      }),
    ).toEqual({
      "vcs.ref.head.revision": "9bb4f62",
      "deployment.environment.name": "production",
      "service.version": "1.0 beta",
    });
  });

  it("are empty when the function was not stamped, and leave out what is malformed", () => {
    expect(resourceAttributes({})).toEqual({});
    expect(parseResourceAttributes("=x,novalue,a=%E0%A4%A,b=ok")).toEqual({ b: "ok" });
  });
});
