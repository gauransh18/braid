import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** What to hand to `child_process.spawn` to run a program. */
export interface Spawnable {
  cmd: string;
  args: string[];
  /** Set when the command line was built by hand for cmd.exe and must not be re-quoted. */
  windowsVerbatimArguments?: boolean;
}

interface Options {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}

/**
 * Quote one argument for cmd.exe. Plain words pass through; anything with spaces or cmd's special characters is
 * wrapped in double quotes, with embedded quotes and trailing backslashes escaped the way the C runtime reads them.
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>()^%!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Find a program the way a shell would. On Windows that means trying each PATH folder with each PATHEXT extension
 * (.exe before .cmd), because `spawn("claude")` only ever finds claude.exe: the npm-installed agent CLIs are
 * claude.cmd, codex.cmd and gemini.cmd. Returns null when nothing matches; elsewhere it is a plain PATH lookup.
 */
export function findExecutable(name: string, o: Options = {}): string | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const win = platform === 'win32';
  // Windows paths use Windows rules even when this code is exercised elsewhere (the tests do).
  const path = win ? win32 : posix;
  const pathVar = env.PATH ?? env.Path ?? '';
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasPath = /[\\/]/.test(name) || path.isAbsolute(name);
  const dirs = hasPath ? [''] : pathVar.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? path.join(dir, name) : name;
    const tries = win && path.extname(name) ? [base] : win ? exts.map((e) => base + e.toLowerCase()) : [base];
    for (const candidate of tries) if (exists(candidate)) return candidate;
  }
  return null;
}

/** What cannot be put inside a cmd.exe command line as part of one argument. */
const UNQUOTABLE = /["%\r\n\0]/;

/**
 * Turn "run this program with these arguments" into something spawn can start on the current platform.
 * Everywhere but Windows that is the input unchanged. On Windows a .cmd or .bat wrapper has to be run through
 * cmd.exe, since Node refuses to start one directly, and the arguments are quoted by hand. Free text (a prompt, a
 * pull request body) therefore goes to such a program on standard input; an argument that cmd.exe cannot carry is
 * refused with an error.
 */
export function spawnable(cmd: string, args: string[], o: Options = {}): Spawnable {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32') return { cmd, args };
  const found = findExecutable(cmd, o);
  if (!found) return { cmd, args };
  if (!/\.(cmd|bat)$/i.test(found)) return { cmd: found, args };
  // The line is built by hand and cmd.exe parses it again: inside double quotes it still reads `"` as the end of the
  // quote (a `\"` is not an escape to it, so what follows would run as a command), expands `%NAME%`, and stops at a
  // line break. None of the three can be said safely, so an argument that has one is refused, never mangled.
  const unsafe = args.find((a) => UNQUOTABLE.test(a));
  if (unsafe !== undefined) {
    throw new Error(`${cmd} is a .cmd or .bat wrapper, which runs through cmd.exe, and cmd.exe cannot be given an argument with a quote, a percent sign or a line break safely (${JSON.stringify(unsafe.slice(0, 60))}). Use the .exe of the program instead.`);
  }
  const shell = (o.env ?? process.env).ComSpec || 'cmd.exe';
  // /d skips AutoRun, /s keeps the outer quotes as a pair, /c runs the line and exits.
  return { cmd: shell, args: ['/d', '/s', '/c', `"${[quoteForCmd(found), ...args.map(quoteForCmd)].join(' ')}"`], windowsVerbatimArguments: true };
}
