/**
 * Telling "the provider is having a bad moment" apart from "the agent did the work badly".
 *
 * An agent call that fails because of a rate limit, an overloaded API or a dropped connection says nothing about the
 * task, so braid must not feed it back as if it did ("fix your change") or spend one of the task's attempts on it.
 */

export type AgentFailureKind =
  /** Clears by itself in seconds or minutes: retry after a pause. */
  | 'transient'
  /** Out of usage or credit: waiting a few minutes will not help, and neither will starting other tasks. */
  | 'quota';

// Specific on purpose: a failed run's text can be an agent's own prose, and a goal like "add rate limiting" must not
// look like a provider error.
const QUOTA = [
  /usage limit reached/i,
  /\b(?:5-hour|weekly|daily|monthly) limit reached/i,
  /limit reached\b.{0,60}\bresets?\b/i,
  /credit balance is too low/i,
  /insufficient[_ ]quota/i,
  /exceeded your (?:current )?quota/i,
];

const TRANSIENT = [
  /\brate[ _-]?limit(?:ed|_error| exceeded| reached)\b/i,
  /too many requests/i,
  /overloaded/i,
  /\b(?:API Error|HTTP|status(?: code)?|error)\b\D{0,3}\b(?:429|500|502|503|504|529)\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EPIPE)\b/,
  /socket hang up|fetch failed|network (?:error|is unreachable)|connection (?:reset|refused|timed out|error|closed)|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|RESOURCE_EXHAUSTED/i,
];

/** What kind of provider-side failure this agent output describes, or null when it looks like the agent's own. */
export function classifyAgentFailure(text: string): AgentFailureKind | null {
  if (QUOTA.some((re) => re.test(text))) return 'quota';
  if (TRANSIENT.some((re) => re.test(text))) return 'transient';
  return null;
}

/** An agent call that kept failing for reasons outside the work. The task fails without using up its attempts. */
export class AgentUnavailableError extends Error {
  constructor(
    readonly kind: AgentFailureKind,
    detail: string,
    retries: number,
  ) {
    const line = detail.trim().split('\n')[0]!.slice(0, 300);
    super(
      kind === 'quota'
        ? `agent unavailable: usage or credit limit reached. ${line}`
        : `agent unavailable: still failing after ${retries} ${retries === 1 ? 'retry' : 'retries'}. ${line}`,
    );
  }
}
