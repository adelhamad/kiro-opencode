import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';

const root = resolve(import.meta.dir, '..');
const { version } = await Bun.file(join(root, 'package.json')).json();
const staging = await mkdtemp(join(tmpdir(), 'opencode-kiro-install-'));
async function run(command: string[], env = process.env) {
  const child = Bun.spawn(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${output}\n${error}`);
}
try {
  await run(['bun', 'scripts/build-release.ts']);
  await mkdir(join(staging, 'bin'));
  // Substitute only the download, exercising the actual published archive,
  // production dependency install, migration and current symlink locally.
  const curl = join(staging, 'bin/curl');
  await Bun.write(curl, '#!/bin/bash\nset -eu\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "--output" ]; then cp "$INSTALLER_TEST_ARCHIVE" "$2"; exit 0; fi\n shift\ndone\nexit 1\n');
  await chmod(curl, 0o755);
  const configDirectory = join(staging, 'config');
  await mkdir(configDirectory);
  const configPath = join(configDirectory, 'opencode.json');
  await Bun.write(configPath, JSON.stringify({ model: 'existing/model', plugins: ['unrelated-plugin'] }));
  const installBase = join(staging, 'installed');
  const env = { ...process.env, PATH: `${join(staging, 'bin')}:${process.env.PATH}`, INSTALLER_TEST_ARCHIVE: join(root, 'dist', `opencode-kiro-${version}.tgz`), OPENCODE_CONFIG_DIR: configDirectory, KIRO_OPENCODE_INSTALL_DIR: installBase };
  await run(['bash', 'install.sh'], env);
  const first = await Bun.file(configPath).json();
  assert.equal(first.model, 'existing/model');
  assert.equal(first.plugins.length, 2);
  assert(await Bun.file(join(first.plugins[1], 'bun.lock')).exists());
  assert(await Bun.file(join(installBase, 'current/src/mcp.ts')).exists());
  await run(['bash', 'install.sh'], env);
  const second = await Bun.file(configPath).json();
  assert.equal(second.plugins.length, 2);
  assert.notEqual(first.plugins[1], second.plugins[1]);
  await run(['bun', join(installBase, 'current/scripts/install.ts'), '--uninstall'], env);
  assert.deepEqual((await Bun.file(configPath).json()).plugins, ['unrelated-plugin']);
  console.log('PASS release installer, production lockfile, upgrade migration and uninstall');
} finally { await rm(staging, { recursive: true, force: true }); }
