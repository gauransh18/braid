import { exec } from './proc.js';

interface Tool {
  name: string;
  bin: string;
  args: string[];
  /** Missing this stops braid from working at all. */
  required?: boolean;
  why: string;
  install: string;
}

const TOOLS: Tool[] = [
  { name: 'git', bin: 'git', args: ['--version'], required: true, why: 'worktrees and merging', install: 'https://git-scm.com/downloads' },
  {
    name: 'claude',
    bin: process.env.BRAID_CLAUDE_BIN ?? 'claude',
    args: ['--version'],
    why: 'the default agent',
    install: 'npm install -g @anthropic-ai/claude-code, then run `claude` once to sign in',
  },
  { name: 'codex', bin: process.env.BRAID_CODEX_BIN ?? 'codex', args: ['--version'], why: 'optional agent', install: 'npm install -g @openai/codex, then `codex login`' },
  { name: 'gemini', bin: process.env.BRAID_GEMINI_BIN ?? 'gemini', args: ['--version'], why: 'optional agent', install: 'npm install -g @google/gemini-cli' },
  { name: 'docker', bin: process.env.BRAID_CONTAINER_RUNTIME ?? 'docker', args: ['--version'], why: 'optional: container sandbox', install: 'https://docs.docker.com/get-docker/ (or Podman)' },
];

export interface ToolStatus {
  name: string;
  ok: boolean;
  version?: string;
  required: boolean;
  why: string;
  install: string;
}

/** Which external programs braid can find. Never launches an agent or signs anything in. */
export async function checkTools(tools: Tool[] = TOOLS): Promise<ToolStatus[]> {
  return Promise.all(
    tools.map(async (t) => {
      const base = { name: t.name, required: !!t.required, why: t.why, install: t.install };
      try {
        const res = await exec(t.bin, t.args, { cwd: process.cwd(), allowFail: true });
        if (res.code !== 0) return { ...base, ok: false };
        return { ...base, ok: true, version: (res.stdout || res.stderr).trim().split('\n')[0] };
      } catch {
        return { ...base, ok: false };
      }
    }),
  );
}

export function formatDoctor(rows: ToolStatus[]): string {
  const lines = rows.map((r) =>
    r.ok ? `  ok       ${r.name.padEnd(7)} ${r.version} (${r.why})` : `  ${r.required ? 'MISSING ' : 'not found'} ${r.name.padEnd(7)} ${r.why}. Install: ${r.install}`,
  );
  const agents = rows.filter((r) => ['claude', 'codex', 'gemini'].includes(r.name));
  const problems: string[] = [];
  if (rows.some((r) => r.required && !r.ok)) problems.push('A required tool is missing; braid cannot run.');
  if (!agents.some((r) => r.ok)) problems.push('No agent CLI found; install at least one of claude, codex or gemini and sign in.');
  return [...lines, '', problems.length ? problems.join('\n') : 'Ready. Signing in to each agent CLI is up to you; braid never handles your login.'].join('\n');
}

export const doctorExitCode = (rows: ToolStatus[]): number => (rows.some((r) => r.required && !r.ok) || !rows.some((r) => ['claude', 'codex', 'gemini'].includes(r.name) && r.ok) ? 1 : 0);
