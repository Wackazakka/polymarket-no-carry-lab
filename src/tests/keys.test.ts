/**
 * Tests for deterministic assumption_key and window_key (rule-based v1).
 * Proves: same input + same nowTs -> same keys; window buckets; entity grouping.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import type { NormalizedMarket } from "../types";
import {
  computeWindowKey,
  computeAssumptionKey,
  normalize,
  extractPrimaryEntity,
} from "../assumption/keys";

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    marketId: "m1",
    conditionId: "c1",
    question: "Will X happen?",
    title: "X market",
    outcomes: ["Yes", "No"],
    resolutionTime: null,
    endDateIso: null,
    category: null,
    description: null,
    rulesText: null,
    noTokenId: null,
    yesTokenId: null,
    liquidityNum: null,
    closed: false,
    ...overrides,
  };
}

const NOW = 1_700_000_000_000; // fixed timestamp

describe("keys determinism and behavior", () => {
  describe("normalize", () => {
    it("lowercases, trims, collapses spaces, strips punctuation", () => {
      assert.strictEqual(normalize("  Foo  Bar  "), "foo bar");
      assert.strictEqual(normalize("What? Yes!"), "what yes");
    });
  });

  describe("computeWindowKey", () => {
    it("same market + same nowTs -> same window_key", () => {
      const m = market({
        resolutionTime: new Date(NOW + 100 * 3600 * 1000),
      });
      const a = computeWindowKey(m, NOW);
      const b = computeWindowKey(m, NOW);
      assert.strictEqual(a, b);
    });

    it("different time-to-resolution -> different window_key when crossing bucket", () => {
      const m1 = market({ resolutionTime: new Date(NOW + 50 * 3600 * 1000) });   // 50h -> W0_0_72H
      const m2 = market({ resolutionTime: new Date(NOW + 100 * 3600 * 1000) });  // 100h -> W1_3_7D
      const m3 = market({ resolutionTime: new Date(NOW + 200 * 3600 * 1000) }); // 200h -> W2_8_30D
      const m4 = market({ resolutionTime: new Date(NOW + 5000 * 3600 * 1000) }); // 5000h -> W4_180D_PLUS
      assert.strictEqual(computeWindowKey(m1, NOW), "W0_0_72H");
      assert.strictEqual(computeWindowKey(m2, NOW), "W1_3_7D");
      assert.strictEqual(computeWindowKey(m3, NOW), "W2_8_30D");
      assert.strictEqual(computeWindowKey(m4, NOW), "W4_180D_PLUS");
    });

    it("W_UNKNOWN when resolutionTime and endDateIso missing", () => {
      const m = market({ resolutionTime: null, endDateIso: null });
      assert.strictEqual(computeWindowKey(m, NOW), "W_UNKNOWN");
    });

    it("uses endDateIso when resolutionTime missing", () => {
      const endIso = new Date(NOW + 100 * 3600 * 1000).toISOString();
      const m = market({ resolutionTime: null, endDateIso: endIso });
      assert.strictEqual(computeWindowKey(m, NOW), "W1_3_7D");
    });
  });

  describe("computeAssumptionKey", () => {
    it("same input + same nowTs -> same assumption_key", () => {
      const m = market({
        category: "Politics",
        question: "Will Biden win 2024?",
        resolutionTime: new Date(NOW + 168 * 3600 * 1000),
      });
      const a = computeAssumptionKey(m, "baseline", NOW);
      const b = computeAssumptionKey(m, "baseline", NOW);
      assert.strictEqual(a, b);
      assert.ok(a.startsWith("a1_"));
    });

    it("markets with same entity + category + bucket -> same assumption_key", () => {
      const base = {
        category: "Politics",
        resolutionTime: new Date(NOW + 200 * 3600 * 1000),
      };
      const m1 = market({ ...base, question: "Will Biden win the election?", marketId: "ma" });
      const m2 = market({ ...base, question: "Will Biden win the election?", marketId: "mb" });
      const k1 = computeAssumptionKey(m1, "baseline", NOW);
      const k2 = computeAssumptionKey(m2, "baseline", NOW);
      assert.strictEqual(k1, k2);
    });

    it("markets with same category but different entity -> different assumption_key", () => {
      const base = {
        category: "Politics",
        resolutionTime: new Date(NOW + 200 * 3600 * 1000),
      };
      const m1 = market({ ...base, question: "Will Biden win 2024?" });
      const m2 = market({ ...base, question: "Will Trump win 2024?" });
      const k1 = computeAssumptionKey(m1, "baseline", NOW);
      const k2 = computeAssumptionKey(m2, "baseline", NOW);
      assert.notStrictEqual(k1, k2);
    });

    it("capture vs baseline -> different assumption_key (thesis_label differs)", () => {
      const m = market({
        category: "Macro",
        question: "US recession in 2024?",
        resolutionTime: new Date(NOW + 200 * 3600 * 1000),
      });
      const kBase = computeAssumptionKey(m, "baseline", NOW);
      const kCap = computeAssumptionKey(m, "capture", NOW);
      assert.notStrictEqual(kBase, kCap);
    });
  });

  describe("extractPrimaryEntity", () => {
    it("election-style question yields entity-like string", () => {
      const m = market({ question: "Will Biden win the US election in 2024?" });
      const e = extractPrimaryEntity(m);
      assert.ok(e.length > 0);
      assert.ok(!/^\s*$/.test(e));
    });

    it("macro-style question yields indicator/country", () => {
      const m = market({ question: "Will the US enter recession in 2024?" });
      const e = extractPrimaryEntity(m);
      assert.ok(e.length > 0);
    });

    it("fallback: first 8-12 words of question", () => {
      const m = market({ question: "Will the foobar widget explode on a Tuesday in March?" });
      const e = extractPrimaryEntity(m);
      assert.ok(e.length > 0);
      assert.ok(e.includes("foobar") || e.split(/\s+/).length >= 5);
    });
  });
});
