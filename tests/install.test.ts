import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'jsonc-parser';

test('installer preserves JSONC, is idempotent, and uninstalls only this plugin', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'kiro-install-test-'));
  const target = join(temp, 'opencode.jsonc');
  const content = '// keep this comment\n{"model":"other/existing","plugins":["existing-plugin"],"providers":{"other":{"settings":{"apiKey":"fake-test-key"}}},}\n';
  await Bun.write(target, content);
  const run = async (uninstall = false) => {
    const child = Bun.spawn(['bun', 'scripts/install.ts', `--config=${target}`, ...(uninstall ? ['--uninstall'] : [])], { stdout: 'ignore', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
  };
  try {
    await run();
    const installed = await readFile(target, 'utf8');
    expect(installed).toContain('// keep this comment');
    const config = parse(installed);
    expect(config.model).toBe('other/existing'); expect(config.providers.other.settings.apiKey).toBe('fake-test-key');
    expect(config.plugins).toEqual(['existing-plugin', resolve('.')]);
    const files = await readdir(temp);
    await run(); expect(await readFile(target, 'utf8')).toBe(installed); expect(await readdir(temp)).toEqual(files);
    await run(true); expect(parse(await readFile(target, 'utf8')).plugins).toEqual(['existing-plugin']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('installer migrates an older local package and preserves its options', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'kiro-migrate-test-'));
  try {
    const older = join(temp, 'older');
    await mkdir(older);
    await Bun.write(join(older, 'package.json'), JSON.stringify({ name: 'opencode-kiro' }));
    const target = join(temp, 'opencode.json');
    await Bun.write(target, JSON.stringify({ plugins: ['existing-plugin', { package: older, options: { cli: '/custom/kiro-cli' } }] }));
    const child = Bun.spawn(['bun', 'scripts/install.ts', `--config=${target}`], { stdout: 'ignore', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
    expect((await Bun.file(target).json()).plugins).toEqual(['existing-plugin', { package: resolve('.'), options: { cli: '/custom/kiro-cli' } }]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
