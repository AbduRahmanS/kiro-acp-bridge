import { describe, expect, it } from "vitest";
import {
  buildUsageUpdate,
  contextUsageFrom,
  creditLineOf,
  formatCreditSummary,
  impliedContextWindow,
  monetaryCostFrom,
} from "../src/bridge/usage.js";
import type { KiroContextData, KiroUsageData } from "../src/kiro/protocol.js";

/** Captured verbatim from a live gpt-5.6-luna session (buckets summed to 9929). */
const REAL_CONTEXT: KiroContextData = {
  model: "gpt-5.6-luna",
  contextUsagePercentage: 3.659926414489746,
  breakdown: {
    contextFiles: { tokens: 1523, percent: 0.559926450252533 },
    tools: { tokens: 7285, percent: 2.6783087253570557 },
    kiroResponses: { tokens: 777, percent: 0.29228726029396057 },
    yourPrompts: { tokens: 344, percent: 0.12940391898155212 },
    sessionFiles: { tokens: 0, percent: 0 },
  },
};

/**
 * Captured shape from a live `/usage`, with the real balance replaced.
 * Never commit an actual credit balance.
 */
const REAL_USAGE: KiroUsageData = {
  planName: "KIRO PRO MAX",
  billingCycleReset: "2026-10-01",
  overagesEnabled: true,
  isEnterprise: true,
  usageBreakdowns: [
    {
      resourceType: "CREDIT",
      displayName: "Credits",
      used: 600.5,
      limit: 5000,
      percentage: 12,
      currentOverages: 0,
      overageRate: 0.04,
      overageCharges: 0,
      currency: "USD",
      hasLimit: true,
    },
  ],
  overageCapable: true,
};

describe("contextUsageFrom", () => {
  it("sums the breakdown buckets into absolute tokens", () => {
    const u = contextUsageFrom(REAL_CONTEXT)!;
    expect(u.usedTokens).toBe(9929);
  });

  it("keeps the per-bucket detail", () => {
    const u = contextUsageFrom(REAL_CONTEXT)!;
    expect(u.buckets).toHaveLength(5);
    expect(u.buckets.find((b) => b.name === "tools")!.tokens).toBe(7285);
  });

  it("retains Kiro's percentage for cross-checking", () => {
    expect(contextUsageFrom(REAL_CONTEXT)!.reportedPercentage).toBeCloseTo(3.6599, 3);
  });

  it("returns undefined with no breakdown, so no misleading zero is published", () => {
    expect(contextUsageFrom(undefined)).toBeUndefined();
    expect(contextUsageFrom({ model: "x" })).toBeUndefined();
    expect(contextUsageFrom({ breakdown: {} })).toBeUndefined();
  });

  it("ignores non-numeric bucket values", () => {
    const u = contextUsageFrom({
      breakdown: { a: { tokens: 10 }, b: {} as never, c: { tokens: Number.NaN } },
    })!;
    expect(u.usedTokens).toBe(10);
    expect(u.buckets).toHaveLength(1);
  });
});

describe("impliedContextWindow", () => {
  it("reconstructs the window from tokens and percentage", () => {
    // 9929 / 3.659926% = 271290, against a declared 272000 — agrees to 0.3%.
    const implied = impliedContextWindow(contextUsageFrom(REAL_CONTEXT)!)!;
    expect(implied).toBeGreaterThan(265000);
    expect(implied).toBeLessThan(280000);
  });

  it("returns undefined when no percentage was reported", () => {
    expect(impliedContextWindow({ usedTokens: 100, buckets: [], reportedPercentage: undefined })).toBeUndefined();
  });

  it("returns undefined for a zero percentage rather than dividing by zero", () => {
    expect(impliedContextWindow({ usedTokens: 0, buckets: [], reportedPercentage: 0 })).toBeUndefined();
  });
});

describe("monetaryCostFrom — credits must never become currency", () => {
  it("emits NO cost when there are no overage charges", () => {
    // The plan allowance is prepaid; consuming it costs nothing extra. Reporting
    // 600.5 as USD would be a fabricated charge.
    expect(monetaryCostFrom(REAL_USAGE)).toBeUndefined();
  });

  it("emits a cost only for genuine overage charges", () => {
    const withOverage: KiroUsageData = {
      ...REAL_USAGE,
      usageBreakdowns: [
        { ...REAL_USAGE.usageBreakdowns[0]!, currentOverages: 120, overageCharges: 4.8 },
      ],
    };
    expect(monetaryCostFrom(withOverage)).toEqual({ amount: 4.8, currency: "USD" });
  });

  it("never invents a currency", () => {
    const noCurrency: KiroUsageData = {
      ...REAL_USAGE,
      usageBreakdowns: [
        { ...REAL_USAGE.usageBreakdowns[0]!, overageCharges: 4.8, currency: undefined },
      ],
    };
    expect(monetaryCostFrom(noCurrency)).toBeUndefined();
  });

  it("ignores a negative or non-finite charge", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const u: KiroUsageData = {
        ...REAL_USAGE,
        usageBreakdowns: [{ ...REAL_USAGE.usageBreakdowns[0]!, overageCharges: bad }],
      };
      expect(monetaryCostFrom(u)).toBeUndefined();
    }
  });

  it("returns undefined when there is no credit line at all", () => {
    expect(monetaryCostFrom({ usageBreakdowns: [] })).toBeUndefined();
    expect(monetaryCostFrom(undefined)).toBeUndefined();
  });
});

describe("creditLineOf", () => {
  it("finds the CREDIT resource regardless of case", () => {
    expect(creditLineOf(REAL_USAGE)?.limit).toBe(5000);
    expect(
      creditLineOf({ usageBreakdowns: [{ resourceType: "credit", used: 1 }] })?.used,
    ).toBe(1);
  });

  it("ignores unrelated resource types", () => {
    expect(creditLineOf({ usageBreakdowns: [{ resourceType: "SEATS", used: 3 }] })).toBeUndefined();
  });
});

describe("buildUsageUpdate", () => {
  it("produces used and size from measured values", () => {
    expect(buildUsageUpdate(REAL_CONTEXT, 272000)).toEqual({ used: 9929, size: 272000 });
  });

  it("attaches cost only when overage is real", () => {
    const withOverage: KiroUsageData = {
      ...REAL_USAGE,
      usageBreakdowns: [{ ...REAL_USAGE.usageBreakdowns[0]!, overageCharges: 2.5 }],
    };
    expect(buildUsageUpdate(REAL_CONTEXT, 272000, withOverage)).toEqual({
      used: 9929,
      size: 272000,
      cost: { amount: 2.5, currency: "USD" },
    });
  });

  it("omits cost for a normal in-plan session", () => {
    expect(buildUsageUpdate(REAL_CONTEXT, 272000, REAL_USAGE)).not.toHaveProperty("cost");
  });

  it("refuses to emit without a known context window, rather than guessing", () => {
    expect(buildUsageUpdate(REAL_CONTEXT, undefined)).toBeUndefined();
    expect(buildUsageUpdate(REAL_CONTEXT, 0)).toBeUndefined();
  });

  it("refuses to emit without token counts", () => {
    expect(buildUsageUpdate(undefined, 272000)).toBeUndefined();
  });
});

describe("formatCreditSummary", () => {
  const text = formatCreditSummary(REAL_USAGE)!;

  it("names the plan", () => {
    expect(text).toContain("KIRO PRO MAX");
  });

  it("reports credits with their unit, never as money", () => {
    expect(text).toContain("Credits");
    expect(text).toContain("5,000");
    expect(text).not.toContain("USD");
  });

  it("shows the remaining balance", () => {
    expect(text).toContain("remaining");
  });

  it("includes the renewal date", () => {
    expect(text).toContain("2026-10-01");
  });

  it("reports overage in credits with the money alongside", () => {
    const withOverage: KiroUsageData = {
      ...REAL_USAGE,
      usageBreakdowns: [
        { ...REAL_USAGE.usageBreakdowns[0]!, currentOverages: 100, overageCharges: 4 },
      ],
    };
    const t = formatCreditSummary(withOverage)!;
    expect(t).toContain("Overage");
    expect(t).toContain("100 credits");
    expect(t).toContain("4.00 USD");
  });

  it("handles a plan with no limit", () => {
    const t = formatCreditSummary({
      planName: "Enterprise",
      usageBreakdowns: [{ resourceType: "CREDIT", used: 42 }],
    })!;
    expect(t).toContain("42 used");
    expect(t).not.toContain("remaining");
  });

  it("returns undefined when there is nothing to report", () => {
    expect(formatCreditSummary(undefined)).toBeUndefined();
    expect(formatCreditSummary({ usageBreakdowns: [] })).toBeUndefined();
  });
});
