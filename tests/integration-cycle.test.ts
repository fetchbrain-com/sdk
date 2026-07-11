import { describe, it, expect } from "vitest";
import { MockFetchBrain } from "../src/mock";

describe("recall→learn→recall cycle (identity = url,method,uniqueKey)", () => {
  it("a request is known on the next recall by (url,method,uniqueKey), not raw url", async () => {
    const mock = new MockFetchBrain();
    const U = "https://api/gql";
    await mock.learn({ url: U, method: "POST", uniqueKey: "k1" }, { which: "k1" });
    // same triple → known
    expect((await mock.recall({ url: U, method: "POST", uniqueKey: "k1" })).known).toBe(true);
    // same url, different uniqueKey → unknown (distinct identity)
    expect((await mock.recall({ url: U, method: "POST", uniqueKey: "k2" })).known).toBe(false);
  });

  it("a learned url is known on the next recall (simple GET, no uniqueKey)", async () => {
    const mock = new MockFetchBrain();
    await mock.learn({ url: "https://site/rooms/42" }, { title: "Loft" });
    const first = await mock.recall({ url: "https://site/rooms/42" });
    expect(first.known).toBe(true);
    expect(first.data).toMatchObject({ title: "Loft" });
    // Different url → unknown
    const miss = await mock.recall({ url: "https://site/rooms/99" });
    expect(miss.known).toBe(false);
  });
});
