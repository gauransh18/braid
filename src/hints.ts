/**
 * Setup, verify and agent commands run without a controlling terminal, so a command that wants to ask a question (a
 * git password, an ssh passphrase, sudo) fails instead of waiting. What it prints is git's, ssh's, sudo's or gpg's own
 * wording, which reads like a broken repository or a bad change to anyone who does not know there is no terminal.
 * This names the cause in one line.
 */
const NO_TERMINAL: { pattern: RegExp; hint: string }[] = [
  {
    // "fatal: could not read Username for 'https://...': Device not configured" (macOS) or "...: No such device or address" (Linux)
    pattern: /could not read (?:Username|Password)|terminal prompts disabled/,
    hint: 'git cannot ask for a username or password here. Credentials have to come from a credential helper or an SSH key.',
  },
  {
    pattern: /Permission denied \(publickey|Host key verification failed/,
    hint: 'ssh cannot ask for a key passphrase or to trust a new host here. Load the key into ssh-agent and add the host to known_hosts beforehand.',
  },
  {
    pattern: /a terminal is required/i,
    hint: 'sudo cannot ask for a password here. Use a command that needs no root, or allow it without a password.',
  },
  {
    // "gpg: cannot open '/dev/tty': No such device or address", "gpg: signing failed: Inappropriate ioctl for device"
    pattern: /gpg[^\n]*(?:No such device|Inappropriate ioctl for device)/i,
    hint: 'gpg cannot ask for a passphrase here. Cache it in gpg-agent, or turn off signing for this run (git config commit.gpgsign false).',
  },
  {
    // What macOS says when anything at all opens /dev/tty and there is none.
    pattern: /Device not configured/,
    hint: 'something asked a question on the terminal. Give it the answer another way (a flag, an environment variable, stored credentials).',
  },
];

/**
 * One line to append to the output of a failed setup or verify command when that output shows a prompt that could not
 * be answered, or undefined when it does not. Only an explanation: whether the command failed is not decided here.
 */
export function terminalHint(output: string): string | undefined {
  const found = NO_TERMINAL.find((h) => h.pattern.test(output));
  return found ? `Hint: braid runs this command without a terminal. ${found.hint}` : undefined;
}
