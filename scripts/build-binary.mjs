// Compile braid (with the dashboard page embedded) into one executable with `bun build --compile`.
//   node scripts/build-binary.mjs            current platform
//   node scripts/build-binary.mjs --all      also macOS x64, Windows x64, Linux x64 (bun downloads each runtime)
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('npx', ['tsc', '-p', 'tsconfig.json']);

const out = join(root, 'build');
mkdirSync(out, { recursive: true });
// The page is set on globalThis before the CLI module loads (imports evaluate in order).
writeFileSync(join(out, 'ui-embedded.mjs'), `globalThis.__BRAID_UI = ${JSON.stringify(readFileSync(join(root, 'ui', 'index.html'), 'utf8'))};\n`);
writeFileSync(join(out, 'entry.mjs'), "import './ui-embedded.mjs';\nimport '../dist/src/cli.js';\n");

const os = platform() === 'win32' ? 'windows' : platform();
const here = `bun-${os}-${arch() === 'arm64' ? 'arm64' : 'x64'}`;
const targets = process.argv.includes('--all') ? ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-windows-x64', 'bun-linux-x64'] : [here];

mkdirSync(join(root, 'dist', 'bin'), { recursive: true });
for (const target of targets) {
  const name = `braid-${target.replace('bun-', '')}${target.includes('windows') ? '.exe' : ''}`;
  console.log(`\n== ${name}`);
  run('bun', ['build', '--compile', `--target=${target}`, join('build', 'entry.mjs'), '--outfile', join('dist', 'bin', name)]);
}
