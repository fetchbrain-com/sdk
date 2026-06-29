import { describe, it, expect } from "vitest";
import { MockFetchBrain } from "../src/mock";

describe("query→learn→query cycle (key-based)", () => {
  it("a learned key is recognized on the next query by key, not url", async () => {
    const mock = new MockFetchBrain();
    await mock.learn("listing:42", { title: "Loft" }, "https://site/rooms/42");
    const first = await mock.query("listing:42", "https://site/rooms/42");
    expect(first.known).toBe(true);
    expect(first.data).toMatchObject({ title: "Loft" });
    // Different url, SAME key → still a hit (proves key not url is the identity)
    const sameKeyDiffUrl = await mock.query("listing:42", "https://other/x");
    expect(sameKeyDiffUrl.known).toBe(true);
    // Different key → miss
    const miss = await mock.query("listing:99");
    expect(miss.known).toBe(false);
  });
});
