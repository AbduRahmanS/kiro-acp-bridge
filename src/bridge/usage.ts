/**
 * Context-usage and credit translation.
 *
 * Two separate problems, deliberately kept apart.
 *
 * **Context usage.** ACP's `usage_update` wants absolute token counts
 * (`used`, `size`). Kiro's `_kiro.dev/metadata` notification carries only a
 * *percentage* — this is Kiro issue #9992, where per-turn token counts were
 * dropped from ACP output in 2.10+. The brief forbids inferring counts from
 * percentages, and rightly so. But `/context` does expose real absolute counts
 * per bucket, and `/model` exposes each model's context window, so we can report
 * measured values rather than derived ones:
 *
 *     used  = sum of /context breakdown bucket tokens
 *     size  = the active model's contextWindow
 *
 * Verified against live data: buckets summed to 9929 tokens which Kiro reported
 * as 3.659926% of a gpt-5.6-luna session; 9929 / 0.03659926 = 271290, against a
 * declared window of 272000 — consistent to within 0.3%, which confirms the two
 * numbers describe the same quantity.
 *
 * **Credits.** Kiro bills in abstract credits (e.g. 1234.56 used of 5000). ACP's `Cost`
 * requires `{amount, currency}` with an ISO 4217 code. Putting a credit count in
 * a currency-typed field would make Zed render "1234.56 USD", which is simply
 * false. So credits are never mapped to `cost`.
 *
 * Kiro does separately report genuine money: `overageCharges` with
 * `currency: "USD"`, being actual billable overage beyond the plan allowance.
 * That, and only that, may populate `cost`.
 */

import type * as schema from "@agentclientprotocol/sdk";
import type { KiroContextData, KiroUsageData } from "../kiro/protocol.js";

/** Absolute token figures derived from a `/context` reading. */
export interface ContextUsage {
  usedTokens: number;
  /** Per-bucket breakdown, preserved for diagnostics and richer UIs. */
  buckets: Array<{ name: string; tokens: number }>;
  /** Percentage Kiro reported, retained for cross-checking. */
  reportedPercentage: number | undefined;
}

/**
 * Sums the `/context` breakdown into an absolute token count.
 *
 * Returns undefined when Kiro supplied no usable buckets, so callers can decline
 * to emit a `usage_update` rather than publishing a misleading zero.
 */
export function contextUsageFrom(data: KiroContextData | undefined): ContextUsage | undefined {
  if (!data?.breakdown) return undefined;

  const buckets: Array<{ name: string; tokens: number }> = [];
  let total = 0;
  for (const [name, bucket] of Object.entries(data.breakdown)) {
    const tokens = bucket?.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) continue;
    buckets.push({ name, tokens });
    total += tokens;
  }
  if (buckets.length === 0) return undefined;

  return {
    usedTokens: total,
    buckets,
    reportedPercentage: data.contextUsagePercentage,
  };
}

/**
 * Cross-checks the summed tokens against Kiro's own percentage.
 *
 * Used only for diagnostics. A large divergence would mean the two Kiro surfaces
 * have drifted apart and the derived `used` value should be distrusted, which is
 * worth a log line rather than silent acceptance.
 */
export function impliedContextWindow(usage: ContextUsage): number | undefined {
  const pct = usage.reportedPercentage;
  if (!pct || pct <= 0) return undefined;
  return Math.round(usage.usedTokens / (pct / 100));
}

/** The credit line from `/usage`, if Kiro reported one. */
export function creditLineOf(usage: KiroUsageData | undefined) {
  return usage?.usageBreakdowns?.find(
    (b) => (b.resourceType ?? "").toUpperCase() === "CREDIT",
  );
}

/**
 * Extracts a genuine monetary cost, or undefined.
 *
 * Returns a value only when Kiro reports real overage charges. Credits are never
 * converted: `overageRate` exists, so a credits-to-dollars multiplication would
 * be *possible*, but it would invent a charge the user has not incurred — plan
 * allowance is prepaid, so consuming it costs nothing additional.
 */
export function monetaryCostFrom(usage: KiroUsageData | undefined): schema.Cost | undefined {
  const credit = creditLineOf(usage);
  if (!credit) return undefined;
  const charges = credit.overageCharges;
  if (typeof charges !== "number" || !Number.isFinite(charges) || charges <= 0) return undefined;
  const currency = credit.currency;
  if (!currency) return undefined; // ACP requires a currency; never fabricate one.
  return { amount: charges, currency };
}

/**
 * Builds an ACP `usage_update` payload.
 *
 * Returns undefined unless both a token count and a context window are known,
 * because ACP requires both `used` and `size` and a guessed window would misdraw
 * Zed's context ring.
 */
export function buildUsageUpdate(
  contextData: KiroContextData | undefined,
  contextWindow: number | undefined,
  usageData?: KiroUsageData | undefined,
): schema.UsageUpdate | undefined {
  const usage = contextUsageFrom(contextData);
  if (!usage || !contextWindow || contextWindow <= 0) return undefined;

  const cost = monetaryCostFrom(usageData);
  return {
    used: usage.usedTokens,
    size: contextWindow,
    ...(cost ? { cost } : {}),
  };
}

/**
 * Formats Kiro's credit standing as human-readable Markdown.
 *
 * This is how credits reach the user: as text, in response to `/usage`, where the
 * unit can be named honestly. No ACP field claims to hold an abstract balance,
 * and the brief is explicit that correct semantics beat forcing a value into an
 * existing widget.
 */
export function formatCreditSummary(usage: KiroUsageData | undefined): string | undefined {
  if (!usage) return undefined;
  const credit = creditLineOf(usage);
  const lines: string[] = [];

  if (usage.planName) lines.push(`**Plan:** ${usage.planName}`);
  if (credit) {
    const used = credit.used ?? 0;
    const limit = credit.limit;
    const label = credit.displayName ?? "Credits";
    if (limit) {
      const pct = credit.percentage ?? Math.round((used / limit) * 100);
      const remaining = Math.max(0, limit - used);
      lines.push(
        `**${label}:** ${formatNumber(used)} / ${formatNumber(limit)} used (${pct}%) · ${formatNumber(remaining)} remaining`,
      );
    } else {
      lines.push(`**${label}:** ${formatNumber(used)} used`);
    }
    if (credit.currentOverages && credit.currentOverages > 0) {
      const money =
        credit.overageCharges !== undefined && credit.currency
          ? ` (${credit.overageCharges.toFixed(2)} ${credit.currency})`
          : "";
      lines.push(`**Overage:** ${formatNumber(credit.currentOverages)} credits${money}`);
    }
  }
  if (usage.billingCycleReset) lines.push(`**Renews:** ${usage.billingCycleReset}`);

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatNumber(n: number): string {
  // Credits are fractional; show at most two decimals and drop trailing zeros.
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toLocaleString("en-US") : rounded.toFixed(2);
}
