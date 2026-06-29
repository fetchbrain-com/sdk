import { describe, it, expect, vi } from "vitest";
import { RequestBatcher, LearnBatcher } from "../src/batch";
import { createLogger } from "../src/logger";

const log = createLogger("info", false);

describe("RequestBatcher", () => {
  it("sends each queued request with a unique ref and resolves each by its ref", async () => {
    const executor = vi.fn(async (items: { ref: string; request: { url: string } }[]) => {
      const m = new Map();
      for (const i of items) m.set(i.ref, { known: i.request.url.endsWith("/known"), data: { u: i.request.url } });
      return m;
    });
    const b = new RequestBatcher(executor, { maxSize: 10, maxWait: 1 }, log);
    const [a, k] = await Promise.all([
      b.query({ url: "https://x/unknown" }),
      b.query({ url: "https://x/known" }),
    ]);
    expect(a.known).toBe(false);
    expect(k.known).toBe(true);
    // refs are unique per item
    const sentRefs = executor.mock.calls[0][0].map((i: any) => i.ref);
    expect(new Set(sentRefs).size).toBe(sentRefs.length);
  });

  it("a ref missing from the executor result resolves to {known:false}", async () => {
    const executor = vi.fn(async () => new Map()); // server omits every ref
    const b = new RequestBatcher(executor, { maxSize: 1, maxWait: 0 }, log);
    expect(await b.query({ url: "https://x/a" })).toEqual({ known: false });
  });
});

describe("LearnBatcher", () => {
  it("threads { request, data } entries to the executor", async () => {
    const executor = vi.fn(async () => ({ learned: 1, status: "success" as const }));
    const b = new LearnBatcher(executor, { maxSize: 1, maxWait: 0 }, log);
    await b.learn({ url: "https://x/a", method: "POST", uniqueKey: "k1" }, { v: 1 });
    expect(executor.mock.calls[0][0][0]).toEqual({ request: { url: "https://x/a", method: "POST", uniqueKey: "k1" }, data: { v: 1 } });
  });
});
