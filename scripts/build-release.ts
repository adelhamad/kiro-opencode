import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const { version } = await Bun.file(join(root, 'package.json')).json();
const staging = await mkdtemp(join(tmpdir(), 'opencode-kiro-release-'));
async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${error}`);
  return output.trim();
}
try {
  const packed = await run(['bun', 'pm', 'pack', '--destination', staging, '--quiet']);
  await run(['tar', '-xzf', packed, '-C', staging]);
  // Package managers omit their lockfiles from npm-style archives. The
  // standalone installer needs ours for a reproducible production install.
  await copyFile(join(root, 'bun.lock'), join(staging, 'package/bun.lock'));
  await mkdir(join(root, 'dist'), { recursive: true });
  const artifact = join(root, 'dist', `opencode-kiro-${version}.tgz`);
  await run(['tar', '-czf', artifact, '-C', staging, 'package']);
  console.log(artifact);
} finally { await rm(staging, { recursive: true, force: true }); }
