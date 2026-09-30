import type { TokenUsage } from './types.js';

export const noTokens = (): TokenUsage => ({ input: 0, cached: 0, output: 0 });

export function addTokens(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage {
  return { input: (a?.input ?? 0) + (b?.input ?? 0), cached: (a?.cached ?? 0) + (b?.cached ?? 0), output: (a?.output ?? 0) + (b?.output ?? 0) };
}

export const totalTokens = (t: TokenUsage | undefined): number => (t ? t.input + t.cached + t.output : 0);

/** 950 -> "950", 12_300 -> "12.3k", 4_560_000 -> "4.56M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 2 : 1)}k`.replace(/\.?0+k$/, 'k');
  return `${(n / 1e6).toFixed(2)}M`;
}

/** "$0.12", or "~$0.12" when the figure is an estimate rather than what the CLI reported. */
export const formatCost = (usd: number, estimated?: boolean): string => `${estimated ? '~' : ''}$${usd.toFixed(2)}`;

/** "31.2k tok (fresh 6.4k, cached 21.4k, out 3.4k)"; "-" when the CLI reported nothing. */
export function describeTokens(t: TokenUsage | undefined, detail = true): string {
  const total = totalTokens(t);
  if (!t || !total) return '-';
  const base = `${formatTokens(total)} tok`;
  return detail ? `${base} (fresh ${formatTokens(t.input)}, cached ${formatTokens(t.cached)}, out ${formatTokens(t.output)})` : base;
}
