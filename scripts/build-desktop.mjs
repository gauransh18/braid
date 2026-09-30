// Build the desktop app: compile the braid executable, place it as the app's sidecar, run `cargo tauri build`.
//   node scripts/build-desktop.mjs            bundles for this platform (.app/.dmg, .msi/.exe, .deb/.AppImage)
//   node scripts/build-desktop.mjs --debug    faster, unoptimized
// Needs: Rust, the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`), Bun.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const host = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout.match(/^host: (.+)$/m)?.[1];
if (!host) throw new Error('rustc not found; install Rust from https://rustup.rs');

const bunTarget = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-pc-windows-msvc': 'windows-x64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
}[host];
if (!bunTarget) throw new Error(`no braid build for ${host}`);

run('node', ['scripts/build-binary.mjs']);

// Tauri looks for binaries/<name>-<rust target triple>[.exe] and strips the suffix when bundling.
const ext = host.includes('windows') ? '.exe' : '';
const dest = join(root, 'desktop', 'src-tauri', 'binaries');
mkdirSync(dest, { recursive: true });
copyFileSync(join(root, 'dist', 'bin', `braid-${bunTarget}${ext}`), join(dest, `braid-${host}${ext}`));

// Prefer an installed `cargo tauri`; otherwise fetch the prebuilt CLI from npm, which is much faster than compiling it (CI).
const haveCargoTauri = spawnSync('cargo', ['tauri', '--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
const tauri = haveCargoTauri ? ['cargo', 'tauri'] : ['npx', '--yes', '@tauri-apps/cli@^2'];
// On Windows build the NSIS installer only: the MSI needs the WiX toolset downloaded, and one installer is enough.
const bundles = process.platform === 'win32' ? ['--bundles', 'nsis'] : [];
run(tauri[0], [...tauri.slice(1), 'build', ...bundles, ...(process.argv.includes('--debug') ? ['--debug'] : [])], join(root, 'desktop', 'src-tauri'));
