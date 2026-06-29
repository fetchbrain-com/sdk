import { describe, it, expect } from "vitest";
import { deriveIdentity } from "../src/mock/derive-identity";

describe("deriveIdentity (mirrors the API's key derivation)", () => {
  it("GET with no uniqueKey keys on the normalized url", () => {
    expect(deriveIdentity({ url: "https://x.test/a" }))
      .toBe(deriveIdentity({ url: "https://x.test/a", method: "GET" }));
  });
  it("method is case-insensitive", () => {
    expect(deriveIdentity({ url: "https://x.test/a", method: "post", uniqueKey: "k1" }))
      .toBe(deriveIdentity({ url: "https://x.test/a", method: "POST", uniqueKey: "k1" }));
  });
  it("body is NOT part of identity", () => {
    expect(deriveIdentity({ url: "https://x.test/g", method: "POST", uniqueKey: "op:1", body: '{"ts":1}' }))
      .toBe(deriveIdentity({ url: "https://x.test/g", method: "POST", uniqueKey: "op:1", body: '{"ts":2}' }));
  });
  it("distinct uniqueKeys on one url+method are distinct", () => {
    expect(deriveIdentity({ url: "https://x.test/g", method: "POST", uniqueKey: "op:1" }))
      .not.toBe(deriveIdentity({ url: "https://x.test/g", method: "POST", uniqueKey: "op:2" }));
  });
  it("normalizes the url (sorts query params, lowercases host)", () => {
    expect(deriveIdentity({ url: "https://X.test/a?b=2&a=1" }))
      .toBe(deriveIdentity({ url: "https://x.test/a?a=1&b=2" }));
  });
});
