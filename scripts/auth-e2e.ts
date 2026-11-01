import { OpenCode } from '@opencode/client';
import { strict as assert } from 'node:assert';
import { mkdtemp, realpath, copyFile, chmod, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// Real OpenCode server, simulated Kiro authentication; no account or model credits used.
const root = resolve(import.meta.dir, '..');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'kiro-auth-e2e-')));
await Bun.spawn(['git', 'init', '--quiet'], { cwd: directory }).exited;
let server: ReturnType<typeof Bun.spawn> | undefined;
const deadline = setTimeout(() => server?.kill('SIGKILL'), 90_000);
try {
  const cli = join(directory, 'kiro');
  await copyFile(join(root, 'tests/fixtures/auth-kiro'), cli);
  await chmod(cli, 0o755);
  const login = (loggedIn: boolean) => Bun.write(cli + '.json', JSON.stringify({ loggedIn }));
  await login(false);
  await Bun.write(join(directory, 'opencode.json'), JSON.stringify({ plugins: [{ package: root, options: { cli } }] }));
  server = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: directory, env: { ...process.env, OPENCODE_CONFIG_DIR: join(directory, 'global-config') }, stdout: 'pipe', stderr: 'pipe',
  });
  void new Response(server.stderr as ReadableStream).text();
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  let startup = '';
  while (!startup.includes('server password ')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('OpenCode server exited before startup');
    startup += new TextDecoder().decode(value);
  }
  void (async () => { while (!(await reader.read()).done) {} })();
  const client = OpenCode.make({ baseUrl: startup.match(/server listening on (http:\/\/[^\s]+)/)![1]!,
    headers: { authorization: 'Basic ' + Buffer.from(`opencode:${startup.match(/server password ([^\s]+)/)![1]!}`).toString('base64'), 'x-opencode-directory': directory } });
  await client.model.list({ location: { directory } });
  const plugins = await client.plugin.list({ location: { directory } });
  assert(plugins.data.some(plugin => plugin.source.type === 'local' && plugin.source.path.startsWith(root) && plugin.state.status === 'active'));
  console.log('PASS real OpenCode activates the plugin while signed out');
  // Wait for the first failed discovery before simulating a completed login.
  const firstCheck = Date.now() + 5000;
  while (!await Bun.file(cli + '.calls').exists()) {
    assert(Date.now() < firstCheck, 'Expected authentication check'); await Bun.sleep(50);
  }
  await Bun.sleep(200);
  await login(true);
  const modelDeadline = Date.now() + 45_000;
  while (true) {
    const models = await client.model.list({ location: { directory } });
    if (JSON.stringify(models).includes('test-model')) break;
    assert(Date.now() < modelDeadline, 'Models did not reload after sign-in');
    await Bun.sleep(500);
  }
  console.log('PASS Kiro models appear after login without restarting OpenCode');
  const session = await client.session.create({ model: { providerID: 'kiro', id: 'test-model' } });
  async function ask() {
    await client.session.prompt({ sessionID: session.id, text: 'hello' });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10_000) });
    return client.session.context({ sessionID: session.id });
  }
  try {
    for (const state of [{ loggedIn: false }, { loggedIn: true, acpFailure: true }, { loggedIn: true, promptFailure: true }]) {
      await Bun.write(cli + '.json', JSON.stringify(state));
      const failed = await ask();
      const failedSession = await client.session.get({ sessionID: session.id });
      assert.equal(failedSession.outcome, 'failed');
      assert(JSON.stringify(failed.findLast((message: any) => message.type === 'idle')).includes('login --use-device-flow'));
      await login(true);
      const recovered = await ask();
      const latest = recovered.findLast((message: any) => message.type === 'assistant');
      assert(JSON.stringify(latest).includes('RECOVERED'));
    }
    console.log('PASS signed-out, ACP exit and mid-stream auth failures stop promptly; the same session recovers after each login');
  } finally { await client.session.remove({ sessionID: session.id }); }
} finally {
  clearTimeout(deadline); server?.kill('SIGKILL'); if (server) await server.exited;
  await rm(directory, { recursive: true, force: true });
}
