import { describe, expect, it } from "vitest";
import type { WebhookDeliverySummary } from "../src/app-client.ts";
import { CollectingMetrics, silentLogger } from "../src/log.ts";
import { MAX_REDELIVERIES_PER_RUN, pickFailed, redeliverMissed } from "../src/redelivery.ts";

const d = (
  id: number,
  guid: string,
  status: string,
  at = "2026-02-01T10:00:00Z",
): WebhookDeliverySummary => ({
  id,
  guid,
  status,
  deliveredAt: at,
});

describe("pickFailed", () => {
  it("picks failures that never succeeded, once per guid, newest first", () => {
    const picked = pickFailed([
      d(1, "a", "OK"),
      d(2, "b", "Fail", "2026-02-01T10:01:00Z"),
      d(3, "b", "Fail", "2026-02-01T10:02:00Z"), // a retry of b that also failed
      d(4, "c", "Fail", "2026-02-01T10:03:00Z"),
      d(5, "c", "OK", "2026-02-01T10:04:00Z"), // c was redelivered successfully
      d(6, "e", "502", "2026-02-01T10:05:00Z"),
    ]);
    expect(picked.map((x) => x.id)).toEqual([6, 3]);
  });

  it("caps at 50", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      d(i + 1, `g${i}`, "Fail", new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString()),
    );
    expect(pickFailed(many)).toHaveLength(MAX_REDELIVERIES_PER_RUN);
    expect(MAX_REDELIVERIES_PER_RUN).toBe(50);
  });
});

describe("redeliverMissed", () => {
  it("asks GitHub to redeliver each failed delivery, counts them, and survives one failing", async () => {
    const redelivered: number[] = [];
    const metrics = new CollectingMetrics();
    const res = await redeliverMissed({
      github: {
        listAppDeliveries: async () => [d(1, "a", "Fail"), d(2, "b", "Fail"), d(3, "c", "OK")],
        redeliver: async (id) => {
          if (id === 1) throw new Error("gone");
          redelivered.push(id);
        },
      },
      metrics,
      logger: silentLogger,
    });
    expect(res).toEqual({ redelivered: 1, failed: 1 });
    expect(redelivered).toEqual([2]);
    expect(metrics.sum("Redelivered")).toBe(1);
  });

  it("honours a lower cap", async () => {
    const ids: number[] = [];
    await redeliverMissed({
      github: {
        listAppDeliveries: async () =>
          Array.from({ length: 10 }, (_, i) =>
            d(i + 1, `g${i}`, "Fail", new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString()),
          ),
        redeliver: async (id) => void ids.push(id),
      },
      metrics: new CollectingMetrics(),
      logger: silentLogger,
      max: 3,
    });
    expect(ids).toHaveLength(3);
  });
});
