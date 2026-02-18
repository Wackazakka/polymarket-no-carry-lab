/**
 * Unit tests for CLOB HTTP top-of-book fetch. Mocks fetch to avoid network.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { fetchTopOfBookHttp } from "../markets/clob_http";

describe("clob_http fetchTopOfBookHttp", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns noBid, noAsk, spread from 200 JSON (mocked)", async () => {
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          bids: [{ price: "0.93", size: "100" }],
          asks: [{ price: "0.94", size: "200" }],
        }),
      }) as unknown as Response;
    const out = await fetchTopOfBookHttp("12345");
    assert.ok(out != null);
    assert.strictEqual(out!.noBid, 0.93);
    assert.strictEqual(out!.noAsk, 0.94);
    assert.ok(Math.abs((out!.spread ?? 0) - 0.01) < 1e-9);
  });

  it("returns null on non-200 (mocked)", async () => {
    globalThis.fetch = async () => ({ ok: false }) as unknown as Response;
    const out = await fetchTopOfBookHttp("999");
    assert.strictEqual(out, null);
  });

  it("returns null on parse failure / invalid JSON (mocked)", async () => {
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => {
          throw new Error("parse error");
        },
      }) as unknown as Response;
    const out = await fetchTopOfBookHttp("999");
    assert.strictEqual(out, null);
  });
});
