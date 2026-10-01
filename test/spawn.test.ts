import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findExecutable, quoteForCmd, spawnable } from '../src/spawn.js';
import { parentIsExplorer } from '../src/winhelp.js';

/** A pretend Windows machine: only the listed files exist. */
const windows = (files: string[], extra: Record<string, string> = {}) => ({
  platform: 'win32' as const,
  env: { PATH: 'C:\\Windows\\System32;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Program Files\\Git\\cmd', ComSpec: 'C:\\Windows\\System32\\cmd.exe', ...extra },
  exists: (p: string) => files.map((f) => f.toLowerCase()).includes(p.toLowerCase()),
});

describe('quoting for cmd.exe', () => {
  it('leaves plain words alone and quotes anything cmd would misread', () => {
    assert.equal(quoteForCmd('--model'), '--model');
    assert.equal(quoteForCmd('Read,Edit,Glob'.replace(/,/g, '_')), 'Read_Edit_Glob');
    assert.equal(quoteForCmd(''), '""');
    assert.equal(quoteForCmd('Bash(npm test)'), '"Bash(npm test)"');
    assert.equal(quoteForCmd('Read,Edit'), '"Read,Edit"');
    assert.equal(quoteForCmd('a&b'), '"a&b"');
    assert.equal(quoteForCmd('C:\\Program Files\\x\\claude.cmd'), '"C:\\Program Files\\x\\claude.cmd"');
    assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteForCmd('dir with space\\'), '"dir with space\\\\"', 'a trailing backslash must not escape the closing quote');
  });
});

describe('finding programs on Windows', () => {
  it('finds the npm .cmd shim that a plain spawn of "claude" would miss', () => {
    const w = windows(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd']);
    assert.equal(findExecutable('claude', w)?.toLowerCase(), 'c:\\users\\me\\appdata\\roaming\\npm\\claude.cmd');
  });

  it('prefers an .exe over a .cmd in the same folder, and honours PATH order', () => {
    const both = windows(['C:\\Users\\me\\AppData\\Roaming\\npm\\tool.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\tool.exe']);
    assert.match(findExecutable('tool', both)!, /tool\.exe$/i);
    const two = windows(['C:\\Windows\\System32\\tool.exe', 'C:\\Users\\me\\AppData\\Roaming\\npm\\tool.exe']);
    assert.match(findExecutable('tool', two)!, /System32/i);
  });

  it('returns null when nothing matches, and respects an explicit extension or path', () => {
    assert.equal(findExecutable('nothing', windows([])), null);
    assert.ok(findExecutable('claude.cmd', windows(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'])));
    assert.equal(findExecutable('C:\\tools\\agent.exe', windows(['C:\\tools\\agent.exe'])), 'C:\\tools\\agent.exe');
  });
});

describe('spawnable', () => {
  it('is the input unchanged everywhere but Windows', () => {
    assert.deepEqual(spawnable('claude', ['-p', 'x'], { platform: 'darwin' }), { cmd: 'claude', args: ['-p', 'x'] });
    assert.deepEqual(spawnable('claude', ['-p'], { platform: 'linux' }), { cmd: 'claude', args: ['-p'] });
  });

  it('runs a .cmd shim through cmd.exe with every argument quoted, including tool lists with spaces and parentheses', () => {
    const w = windows(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd']);
    const s = spawnable('claude', ['-p', '--allowedTools', 'Read,Edit,Bash(npm test)', '--model', 'sonnet'], w);
    assert.equal(s.cmd, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(s.windowsVerbatimArguments, true);
    assert.deepEqual(s.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(s.args[3], '"C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd -p --allowedTools "Read,Edit,Bash(npm test)" --model sonnet"');
  });

  it('refuses an argument that cmd.exe would read as a second command, instead of quoting it wrong', () => {
    const w = windows(['C:\\Users\\me\\AppData\\Roaming\\npm\\gh.cmd']);
    // A quote ends the quoted part for cmd.exe (a backslash does not escape it), so the & after it would run `calc`.
    for (const bad of ['x" & calc & "', 'say "hi"', '100% done', '%PATH%', 'first\nsecond', 'first\r\nsecond', 'nul\0byte']) {
      assert.throws(() => spawnable('gh', ['pr', 'create', '--title', bad], w), /\.cmd or \.bat wrapper.*cannot be given an argument/s, JSON.stringify(bad));
    }
    // What can be quoted is still quoted, and the refusal is only for cmd.exe.
    assert.equal(spawnable('gh', ['--title', 'a & b (c)'], w).args[3], '"C:\\Users\\me\\AppData\\Roaming\\npm\\gh.cmd --title "a & b (c)""');
    assert.deepEqual(spawnable('gh', ['--title', 'say "hi" & 100%\nx'], windows(['C:\\Program Files\\Git\\cmd\\gh.exe'])), { cmd: 'C:\\Program Files\\Git\\cmd\\gh.exe', args: ['--title', 'say "hi" & 100%\nx'] });
    assert.deepEqual(spawnable('gh', ['--title', 'say "hi"'], { platform: 'linux' }), { cmd: 'gh', args: ['--title', 'say "hi"'] });
  });

  it('starts an .exe directly, and leaves an unknown program for spawn to report', () => {
    const w = windows(['C:\\Program Files\\Git\\cmd\\git.exe']);
    assert.deepEqual(spawnable('git', ['--version'], w), { cmd: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['--version'] });
    assert.deepEqual(spawnable('missing', ['a'], w), { cmd: 'missing', args: ['a'] });
  });
});

describe('double-click detection on Windows', () => {
  it('recognises Explorer as the parent and nothing else', () => {
    assert.equal(parentIsExplorer('"explorer.exe","4321","Console","1","81,244 K"\r\n'), true);
    assert.equal(parentIsExplorer('"Explorer.EXE","4321","Console","1","81,244 K"'), true);
    assert.equal(parentIsExplorer('"pwsh.exe","100","Console","1","90,000 K"'), false);
    assert.equal(parentIsExplorer('"cmd.exe","100","Console","1","5,000 K"'), false);
    assert.equal(parentIsExplorer('INFO: No tasks are running which match the specified criteria.'), false);
    assert.equal(parentIsExplorer(''), false);
  });
});
