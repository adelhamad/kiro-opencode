import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { OpenCode } from '@opencode/client';

const root = resolve(import.meta.dir, '..');
await mkdir(join(root, '.e2e'), { recursive: true });
const directory = await mkdtemp(join(root, '.e2e', 'package-'));
let server: ReturnType<typeof Bun.spawn> | undefined;
async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} failed (${code}): ${out}\n${err}`);
  return out;
}
try {
  const archive = (await run(['bun', 'pm', 'pack', '--destination', directory, '--quiet'], root)).trim();
  await Bun.write(join(directory, 'package.json'), JSON.stringify({ name: 'kiro-installed-test', private: true }));
  await run(['bun', 'add', archive], directory);
  await run(['git', 'init', '--quiet'], directory);
  const installed = join(directory, 'node_modules/opencode-kiro');
  assert(await Bun.file(join(installed, 'src/mcp.ts')).exists());
  await Bun.write(join(directory, 'opencode.json'), JSON.stringify({ plugins: [installed], model: 'kiro/claude-sonnet-4.6' }));
  // Isolate OpenCode's configuration without changing Kiro's authentication paths.
  server = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: directory, env: { ...process.env, OPENCODE_CONFIG_DIR: join(directory, 'global-config') }, stdout: 'pipe', stderr: 'pipe' });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  let startup = '';
  while (!startup.includes('server password ')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Packaged OpenCode server exited');
    startup += new TextDecoder().decode(value);
  }
  void (async () => { while (!(await reader.read()).done) {} })();
  void new Response(server.stderr as ReadableStream).text();
  const baseUrl = startup.match(/server listening on (http:\/\/[^\s]+)/)![1]!;
  const password = startup.match(/server password ([^\s]+)/)![1]!;
  const client = OpenCode.make({ baseUrl, headers: { authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'), 'x-opencode-directory': directory } });
  const session = await client.session.create({ model: { providerID: 'kiro', id: 'claude-sonnet-4.6', variant: 'high' } });
  await client.session.prompt({ sessionID: session.id, text: 'Reply exactly PACKAGED_PLUGIN_OK. Do not use tools.' });
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(120_000) });
  const context = await client.session.context({ sessionID: session.id });
  const answer = context.findLast((message: any) => message.type === 'assistant') as any;
  assert.equal(answer.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''), 'PACKAGED_PLUGIN_OK');
  const plugins = await client.plugin.list({ location: { directory } });
  assert(plugins.data.some(plugin => plugin.source.type === 'local' && plugin.source.path.startsWith(installed) && plugin.state.status === 'active'), 'Packaged plugin must be active, rather than falling back to the source-tree installation');
  await client.session.remove({ sessionID: session.id });
  console.log('PASS installed tarball is the active plugin and generates with high effort');
} finally {
  server?.kill(); if (server) await server.exited;
  await rm(directory, { recursive: true, force: true });
}
