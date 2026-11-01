import { test, expect } from 'bun:test';
import { mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverModels, watchModels } from '../src/models';
import { runCli } from '../src/auth';
import { createBridge } from '../src/bridge';
import plugin from '../src/index';

async function fixture(state: Record<string, boolean | undefined> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kiro-auth-test-'));
  const cli = join(directory, 'kiro');
  await copyFile(resolve('tests/fixtures/auth-kiro'), cli);
  await chmod(cli, 0o755);
  const set = (value: Record<string, boolean | undefined>) => Bun.write(cli + '.json', JSON.stringify(value));
  await set(state);
  return { cli, set, async calls() { return (await Bun.file(cli + '.calls').text()).trim().split('\n').map(line => JSON.parse(line)); }, stop: () => rm(directory, { recursive: true, force: true }) };
}

async function until(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await Bun.sleep(10); }
}

test('signed-out discovery does not launch chat or expose login secrets', async () => {
  const f = await fixture();
  try {
    await expect(discoverModels(f.cli)).rejects.toThrow('login --use-device-flow');
    expect((await f.calls()).map(args => args[0])).toEqual(['whoami']);
    await f.set({ unauthorized: true });
    await expect(discoverModels(f.cli)).rejects.toThrow('login --use-device-flow');
    await f.set({ loggedIn: true, listFailure: true });
    try { await discoverModels(f.cli); throw new Error('Expected auth failure'); } catch (error) {
      expect(String(error)).toContain('login --use-device-flow'); expect(String(error)).not.toContain('SECRET');
    }
    await f.set({ loggedIn: true, noisy: true });
    expect((await discoverModels(f.cli))[0]!.model_id).toBe('test-model');
  } finally { await f.stop(); }
});

test('timeout kills an unresponsive CLI and abort cancels discovery', async () => {
  const f = await fixture({ hang: true });
  try {
    await expect(runCli(f.cli, ['whoami'], undefined, 100)).rejects.toThrow('timed out');
    if (process.platform !== 'win32') {
      await f.set({ forkHang: true });
      await expect(runCli(f.cli, ['whoami'], undefined, 200)).rejects.toThrow('timed out');
    }
    const controller = new AbortController();
    const pending = discoverModels(f.cli, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  } finally { await f.stop(); }
});

test('model watcher recovers after login, deduplicates updates and stops on unload', async () => {
  const f = await fixture(); const controller = new AbortController();
  const updates: unknown[] = []; const reports: string[] = [];
  const watching = watchModels({ cli: f.cli, signal: controller.signal, interval: 20,
    async update(models) { updates.push(models); }, report(message) { reports.push(message); } });
  try {
    await until(() => reports.length > 0);
    expect(updates).toHaveLength(0);
    await f.set({ loggedIn: true });
    await until(() => updates.length === 1);
    await Bun.sleep(120);
    expect(updates).toHaveLength(1);
    expect(reports).toHaveLength(1);
    controller.abort(); await watching;
    const count = (await f.calls()).length;
    await Bun.sleep(60); expect((await f.calls()).length).toBe(count);
  } finally { controller.abort(); await watching; await f.stop(); }
});

test('plugin setup remains active when authentication is missing', async () => {
  const f = await fixture();
  let cleanup: (() => Promise<void> | void) | void;
  try {
    cleanup = await plugin.setup({ options: { cli: f.cli }, location: { directory: process.cwd() },
      provider: { async transform(callback: any) { callback({ add() {} }); }, async reload() {} },
      session: { async hook() {} }, event: { async *subscribe() {} },
    } as any);
    expect(typeof cleanup).toBe('function');
  } finally { await cleanup!?.(); await f.stop(); }
}, 2000);

test('same bridge recovers from expired auth, ACP exit and mid-request expiry', async () => {
  const f = await fixture();
  const bridge = await createBridge(process.cwd(), { cli: f.cli });
  const ask = async () => (await fetch(bridge.url + '/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${bridge.secret}`, 'x-opencode-session': 'same-session' },
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: true }),
  })).text();
  try {
    for (const state of [{}, { loggedIn: true, acpFailure: true }, { loggedIn: true, promptFailure: true }]) {
      await f.set(state);
      const failed = await ask();
      expect(failed).toContain('login --use-device-flow'); expect(failed).not.toContain('SECRET');
      await f.set({ loggedIn: true });
      expect(await ask()).toContain('RECOVERED');
    }
  } finally { await bridge.stop(); await f.stop(); }
});
