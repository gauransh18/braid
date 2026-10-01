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

// These are matched only against what the provider or the CLI itself reported (AgentResult.error), never the agent's
// own prose. The wordings come from running Claude Code 2.1.283 and Codex 0.147 against stand-in APIs, from the CLI
// bundle for the subscription notices, and from the providers' documented errors; they change when the CLIs do.
const QUOTA = [
  /\byou(?:'|\u2019)ve hit your .{0,40}\blimit\b/i, // "You've hit your session / weekly / usage limit · resets 3pm", "... monthly spend limit."
  /out of usage credits/i,
  /usage limits?\. you will regain access/i,
  /usage limit reached/i,
  /\b(?:5-hour|weekly|daily|monthly) limit reached/i,
  /limit reached\b.{0,60}\bresets?\b/i,
  /credit balance is too low/i,
  /insufficient[_ ]quota/i,
  /exceeded your (?:current )?quota/i,
  /exhausted your (?:daily )?quota/i,
];

const TRANSIENT = [
  /\brate[ _-]?limit(?:ed|_error| exceeded| reached)\b/i,
  /request rejected \(429\)/i,
  /temporarily limiting requests/i, // "(not your usage limit)": a capacity blip, not an empty account
  /\brequest timed out\b/i,
  /too many requests/i,
  /overloaded/i,
  /experiencing high demand/i,
  /stream disconnected before completion/i,
  /\b(?:API Error|HTTP|status(?: code)?|error)\b\D{0,3}\b(?:429|500|502|503|504|529)\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EPIPE)\b/,
  /socket hang up|fetch failed|network (?:error|is unreachable)|connection (?:reset|refused|timed out|error|closed)|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|RESOURCE_EXHAUSTED/i,
];

/** What kind of provider-side failure this error text (AgentResult.error) describes, or null when it is neither. */
export function classifyAgentFailure(text: string): AgentFailureKind | null {
  if (QUOTA.some((re) => re.test(text))) return 'quota';
  if (TRANSIENT.some((re) => re.test(text))) return 'transient';
  return null;
}

/**
 * An agent call that kept failing for reasons outside the work. The task fails without using up its attempts. `kind`
 * is what the provider said, or `missing` when the agent's program could not be started at all (waiting will not help).
 */
export class AgentUnavailableError extends Error {
  constructor(
    readonly kind: AgentFailureKind | 'missing',
    detail: string,
    retries: number,
    /** Which call it was (worker, resolver, reviewer, replanner): what the task owes for it differs. */
    readonly role: string = 'worker',
  ) {
    const line = detail.trim().split('\n')[0]!.slice(0, 300);
    super(
      kind === 'quota'
        ? `agent unavailable: usage or credit limit reached. ${line}`
        : kind === 'missing'
          ? `agent unavailable: ${line}`
          : `agent unavailable: still failing after ${retries} ${retries === 1 ? 'retry' : 'retries'}. ${line}`,
    );
  }
}
