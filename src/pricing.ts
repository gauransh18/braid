import { readFileSync } from 'node:fs';
import type { TokenUsage } from './types.js';

/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
  /** Rate for cached input tokens; defaults to the full input rate. */
  cachedInput?: number;
}

export interface Usage {
  /** Model the tokens were billed to; unknown models fall back to the driver default. */
  model?: string;
  /** Fresh input tokens, excluding cached ones. */
  input: number;
  cached?: number;
  output: number;
}

/**
 * Rough list prices for CLIs that report tokens but not dollars. These are estimates for budgeting and
 * comparing variants, not invoices: they drift, and subscription plans are not billed per token at all.
 * Override or extend with a JSON file in BRAID_PRICES: {"model-prefix": {"input": 1, "output": 5, "cachedInput": 0.1}}.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  'gemini-2.5-pro': { input: 1.25, output: 10, cachedInput: 0.125 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cachedInput: 0.01 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cachedInput: 0.03 },
  'gpt-5-codex': { input: 1.25, output: 10, cachedInput: 0.125 },
  'gpt-5.2-codex': { input: 1.75, output: 14, cachedInput: 0.175 },
  'codex-mini': { input: 0.75, output: 3, cachedInput: 0.075 },
};

/** Used when a CLI does not say which model ran and none was requested. */
export const DRIVER_DEFAULT_MODEL: Record<string, string> = { gemini: 'gemini-2.5-pro', codex: 'gpt-5-codex' };

let overrides: Record<string, Price> | undefined;

function table(): Record<string, Price> {
  if (!overrides) {
    const file = process.env.BRAID_PRICES;
    try {
      overrides = file ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Price>) : {};
    } catch (err) {
      throw new Error(`BRAID_PRICES (${file}) is unreadable: ${(err as Error).message}`);
    }
  }
  return { ...DEFAULT_PRICES, ...overrides };
}

/** Test hook: forget cached overrides so BRAID_PRICES is re-read. */
export function resetPriceCache(): void {
  overrides = undefined;
}

/** Longest matching key wins, so `gemini-2.5-flash-lite-preview` prices as flash-lite, not flash. */
export function priceFor(model: string | undefined, fallbackModel?: string): Price | undefined {
  const prices = table();
  for (const name of [model, fallbackModel]) {
    if (!name) continue;
    const key = Object.keys(prices)
      .filter((k) => name.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key) return prices[key];
  }
  return undefined;
}

/** Estimated dollars for a set of usage records; 0 when no price is known. */
export function estimateCostUsd(usages: Usage[], fallbackModel?: string): number {
  let usd = 0;
  for (const u of usages) {
    const p = priceFor(u.model, fallbackModel);
    if (!p) continue;
    usd += (u.input * p.input + (u.cached ?? 0) * (p.cachedInput ?? p.input) + u.output * p.output) / 1_000_000;
  }
  return usd;
}

export function sumUsage(usages: Usage[]): TokenUsage {
  return usages.reduce<TokenUsage>((t, u) => ({ input: t.input + u.input, cached: t.cached + (u.cached ?? 0), output: t.output + u.output }), { input: 0, cached: 0, output: 0 });
}
