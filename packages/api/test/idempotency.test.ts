/**
 * Idempotency: the request fingerprint, the REST routes, and the shared
 * withIdempotency / withIdempotentResult helpers.
 */

import { describe, expect, test } from "vitest";
import type { HttpRequest, HttpResponse } from "../src/http.ts";
import {
  canonicalJson,
  fingerprintRequest,
  IdempotencyKeyReuseError,
  withIdempotency,
  withIdempotentResult,
} from "../src/idempotency.ts";
import { route } from "../src/router.ts";
import { authHeader, buildHarness, mintToken } from "./helpers.ts";

function req(overrides: Partial<HttpRequest> & { method: string; path: string }): HttpRequest {
  return { query: {}, headers: {}, params: {}, host: "kiro.example.com", ...overrides };
}

const headers = (key?: string) => ({
  ...authHeader(mintToken({})),
  ...(key === undefined ? {} : { "idempotency-key": key }),
});

const ok = (body: string): HttpResponse => ({ status: 202, headers: {}, body });

describe("fingerprint", () => {
  test("canonicalJson ignores key order and undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: [1, { z: 1, y: 2 }] } })).toBe(
      canonicalJson({ a: { e: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }),
    );
  });

  test("differs by method, target and input", () => {
    const base = fingerprintRequest("POST", "/v1/sessions", { a: 1 });
    expect(base).toBe(fingerprintRequest("POST", "/v1/sessions", { a: 1 }));
    expect(base).not.toBe(fingerprintRequest("PATCH", "/v1/sessions", { a: 1 }));
    expect(base).not.toBe(fingerprintRequest("POST", "/v1/sessions/x", { a: 1 }));
    expect(base).not.toBe(fingerprintRequest("POST", "/v1/sessions", { a: 2 }));
  });
});

describe("withIdempotency", () => {
  test("same key and fingerprint replays the stored response without running fn", async () => {
    const h = buildHarness();
    let runs = 0;
    const fn = async () => ok(`run-${++runs}`);
    const a = await withIdempotency(h.repo, "u", "k", "fp", fn);
    const b = await withIdempotency(h.repo, "u", "k", "fp", fn);
    expect(a.body).toBe("run-1");
    expect(b.body).toBe("run-1");
    expect(runs).toBe(1);
  });

  test("same key with a different fingerprint is refused and runs nothing", async () => {
    const h = buildHarness();
    let runs = 0;
    const fn = async () => ok(`run-${++runs}`);
    await withIdempotency(h.repo, "u", "k", "fp-1", fn);
    await expect(withIdempotency(h.repo, "u", "k", "fp-2", fn)).rejects.toBeInstanceOf(
      IdempotencyKeyReuseError,
    );
    expect(runs).toBe(1);
  });

  test("an entry stored without a fingerprint stays valid for any replay", async () => {
    const h = buildHarness();
    await h.repo.putIdempotency("u", "old", { status: 202, headers: {}, body: "legacy" });
    let runs = 0;
    const res = await withIdempotency(h.repo, "u", "old", "any-fp", async () => {
      runs++;
      return ok("new");
    });
    expect(res.body).toBe("legacy");
    expect(runs).toBe(0);
  });

  test("an error is not cached: a retry with the same key runs again", async () => {
    const h = buildHarness();
    let runs = 0;
    const fn = async () => {
      runs++;
      if (runs === 1) {
        throw new Error("boom");
      }
      return ok("fine");
    };
    await expect(withIdempotency(h.repo, "u", "k", "fp", fn)).rejects.toThrow("boom");
    expect((await withIdempotency(h.repo, "u", "k", "fp", fn)).body).toBe("fine");
    expect(runs).toBe(2);
  });

  test("a non-2xx response is not cached either", async () => {
    const h = buildHarness();
    let runs = 0;
    const fn = async (): Promise<HttpResponse> => {
      runs++;
      return runs === 1 ? { status: 503, headers: {}, body: "later" } : ok("fine");
    };
    expect((await withIdempotency(h.repo, "u", "k", "fp", fn)).status).toBe(503);
    expect((await withIdempotency(h.repo, "u", "k", "fp", fn)).status).toBe(202);
  });

  test("keys are scoped per sub", async () => {
    const h = buildHarness();
    let runs = 0;
    const fn = async () => ok(`run-${++runs}`);
    await withIdempotency(h.repo, "u1", "k", "fp", fn);
    await withIdempotency(h.repo, "u2", "k", "fp", fn);
    expect(runs).toBe(2);
  });

  test("a lost race returns the winner, or refuses when the winner differs", async () => {
    const h = buildHarness();
    const racing = (key: string, winnerFp: string) => async () => {
      await h.repo.putIdempotency("u", key, ok("winner") as never, winnerFp);
      return ok("loser");
    };
    expect((await withIdempotency(h.repo, "u", "r", "fp", racing("r", "fp"))).body).toBe("winner");
    await expect(
      withIdempotency(h.repo, "u", "r2", "fp", racing("r2", "other")),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });
});

describe("withIdempotentResult", () => {
  test("replays a JSON value, including a void result", async () => {
    const h = buildHarness();
    let runs = 0;
    const value = await withIdempotentResult(h.repo, "u", "k", "fp", async () => ({
      n: ++runs,
    }));
    const replay = await withIdempotentResult(h.repo, "u", "k", "fp", async () => ({
      n: ++runs,
    }));
    expect(value).toEqual({ n: 1 });
    expect(replay).toEqual({ n: 1 });
    const none = await withIdempotentResult(h.repo, "u", "v", "fp", async () => undefined);
    expect(none).toBeNull();
  });
});

describe("REST routes", () => {
  let h = buildHarness();
  const launch = (key: string | undefined, prompt = "hi") =>
    route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt, repos: ["acme/app"] }),
      }),
      headers: headers(key),
    });

  test("same key and body: one session, stored response replayed", async () => {
    h = buildHarness({ ids: ["sess-1", "cmd-1", "turn-1", "sess-2", "cmd-2"] });
    const a = await launch("rest-1");
    const b = await launch("rest-1");
    expect(a.status).toBe(202);
    expect(b.body).toBe(a.body);
    expect(JSON.parse(a.body).sessionId).toBe("sess-1");
    expect(h.queue.commands).toHaveLength(1);
  });

  test("same key with a different body is 422 idempotency-key-reused", async () => {
    h = buildHarness({ ids: ["sess-1", "cmd-1", "turn-1", "sess-2", "cmd-2"] });
    await launch("rest-2");
    const refused = await launch("rest-2", "a different prompt");
    expect(refused.status).toBe(422);
    expect(refused.headers["content-type"]).toBe("application/problem+json");
    const problem = JSON.parse(refused.body);
    expect(problem.type).toContain("idempotency-key-reused");
    expect(problem.detail).toMatch(/already used for a different request/);
    expect(h.queue.commands).toHaveLength(1);
  });

  test("a body that differs only in key order or an explicit default is the same request", async () => {
    h = buildHarness({ ids: ["sess-1", "cmd-1", "turn-1"] });
    h.seedSession({ id: "s1", status: "idle" });
    const turn = (body: unknown) =>
      route(h.ctx, {
        ...req({ method: "POST", path: "/v1/sessions/s1/turns", body: JSON.stringify(body) }),
        headers: headers("turn-key"),
      });
    const a = await turn({ prompt: "x" });
    const b = await turn({ whenBusy: "steer", prompt: "x" });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body).toBe(a.body);
  });

  test("the same key on another session's route is refused", async () => {
    h = buildHarness();
    h.seedSession({ id: "s1", status: "idle" });
    h.seedSession({ id: "s2", status: "idle" });
    const cancel = (id: string) =>
      route(h.ctx, {
        ...req({ method: "POST", path: `/v1/sessions/${id}/cancel`, body: "{}" }),
        headers: headers("cancel-key"),
      });
    expect((await cancel("s1")).status).toBe(202);
    expect((await cancel("s2")).status).toBe(422);
  });

  test("no key on POST is still 400", async () => {
    h = buildHarness();
    expect((await launch(undefined)).status).toBe(400);
  });

  test("a key outside the allowed set or longer than 128 is 400", async () => {
    h = buildHarness();
    for (const key of ["has space", "a#b", "x".repeat(129)]) {
      const res = await launch(key);
      expect(res.status, key).toBe(400);
      expect(JSON.parse(res.body).type).toContain("invalid-idempotency-key");
    }
    expect(h.queue.commands).toHaveLength(0);
  });

  test("PATCH config and DELETE link accept an optional key and deduplicate with it", async () => {
    h = buildHarness();
    h.seedSession({ id: "s1", status: "idle" });
    const patch = (key: string | undefined, body: unknown) =>
      route(h.ctx, {
        ...req({ method: "PATCH", path: "/v1/sessions/s1/config", body: JSON.stringify(body) }),
        headers: headers(key),
      });
    expect((await patch(undefined, { mode: "vibe" })).status).toBe(202);
    expect((await patch("cfg", { mode: "vibe" })).status).toBe(202);
    const commandsAfterFirstKeyed = h.queue.commands.length;
    expect((await patch("cfg", { mode: "vibe" })).status).toBe(202);
    expect(h.queue.commands).toHaveLength(commandsAfterFirstKeyed);
    expect((await patch("cfg", { mode: "spec" })).status).toBe(422);
  });
});
