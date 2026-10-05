import { OpenCode } from '@opencode/client';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Runs its own private OpenCode server. Its generated password stays in memory.
const root = resolve(import.meta.dir, '..');
await mkdir(resolve(root, '.e2e'), { recursive: true });
const directory = await mkdtemp(join(root, '.e2e', 'workspace-'));
await Bun.write(resolve(directory, 'opencode.json'), JSON.stringify({ model: 'kiro/claude-sonnet-4.6', plugins: [process.env.KIRO_TEST_PLUGIN || root], mcp: { fixture: { type: 'local', command: ['bun', resolve(root, 'scripts/mcp-fixture.ts')] } } }));
await Bun.write(resolve(directory, 'e2e-red.png'), await Bun.file(resolve(root, 'tests/fixtures/red.png')).arrayBuffer());
const git = Bun.spawn(['git', 'init', '--quiet'], { cwd: directory, stdout: 'ignore', stderr: 'ignore' });
assert.equal(await git.exited, 0);
await Bun.write(resolve(directory, 'undo-e2e.txt'), 'BEFORE_UNDO\n');
assert.equal(await Bun.spawn(['git', 'add', '.'], { cwd: directory }).exited, 0);
assert.equal(await Bun.spawn(['git', '-c', 'user.name=Kiro E2E', '-c', 'user.email=kiro-e2e@example.invalid', 'commit', '--quiet', '-m', 'Test baseline'], { cwd: directory }).exited, 0);
const processServer = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
const reader = processServer.stdout.getReader();
let startup = '';
const decoder = new TextDecoder();
while (!startup.includes('server password ')) {
  const { value, done } = await reader.read();
  if (done) throw new Error('OpenCode server exited during startup');
  startup += decoder.decode(value);
}
void (async () => { while (!(await reader.read()).done) {} })();
void new Response(processServer.stderr).text();
const baseUrl = startup.match(/server listening on (http:\/\/[^\s]+)/)![1]!;
const password = startup.match(/server password ([^\s]+)/)![1]!;
const client = OpenCode.make({ baseUrl, headers: { authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'), 'x-opencode-directory': directory } });
const model = { providerID: 'kiro', id: 'claude-sonnet-4.6' };
const created: string[] = [];
async function session(permissions = [{ action: '*', resource: '*', effect: 'allow' as 'allow' | 'deny' | 'ask' }]) {
  const item = await client.session.create({ model, location: { directory }, permissions });
  created.push(item.id); return item.id;
}
function answer(context: any[]) { return context.findLast(message => message.type === 'assistant')?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') || ''; }
async function ask(sessionID: string, text: string) {
  await client.session.prompt({ sessionID, text });
  await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(120_000) });
  return client.session.context({ sessionID });
}
try {
  const id = await session();
  if (!process.env.UNDO_ONLY) {
  const first = await ask(id, 'Remember the secret word KIWI_ORBIT. Reply exactly CHAT_OK. No tools.');
  assert.equal(answer(first), 'CHAT_OK');
  console.log('PASS streaming chat');
  const second = await ask(id, 'What secret word did I ask you to remember? No tools.');
  assert(answer(second).includes('KIWI_ORBIT')); 
  console.log('PASS conversation continuation');
  await ask(id, 'Create e2e-native.txt containing exactly NATIVE_E2E_OK and a newline using the write tool, then read it back.');
  assert.equal(await Bun.file(resolve(directory, 'e2e-native.txt')).text(), 'NATIVE_E2E_OK\n');
  const context = JSON.stringify(await client.session.context({ sessionID: id }));
  assert(context.includes('"name":"write"') && context.includes('"name":"read"'));
  console.log('PASS OpenCode native write/read tools');
  const denyId = await session([{ action: '*', resource: '*', effect: 'deny' }]);
  const denied = await ask(denyId, 'Create forbidden-e2e.txt containing FORBIDDEN. If denied, report denial and do not retry or use another tool.');
  assert.equal(await Bun.file(resolve(directory, 'forbidden-e2e.txt')).exists(), false);
  console.log('PASS denied permissions prevent file changes');
  const bash = await ask(id, 'Use the bash tool to run printf TERMINAL_E2E_OK and report its output.');
  assert(bash.some((message: any) => message.content?.some((part: any) => part.type === 'tool' && part.state.status === 'completed' && JSON.stringify(part.state.content).includes('TERMINAL_E2E_OK'))));
  console.log('PASS native terminal tool');
  const mcp = await ask(id, 'Call the fixture MCP echo tool with marker MCP_E2E_OK and report its result.');
  assert(JSON.stringify(mcp).includes('MCP_REPLY:MCP_E2E_OK'));
  assert(mcp.some((message: any) => message.content?.some((part: any) => part.type === 'tool' && part.state.status === 'completed' && part.state.metadata?.toolCalls?.some((call: any) => call.tool === 'fixture.echo' && call.status === 'completed') && JSON.stringify(part.state.content).includes('MCP_REPLY:MCP_E2E_OK'))));
  console.log('PASS existing OpenCode MCP tool executes through relay');
  await client.session.prompt({ sessionID: id, text: 'What is the dominant color in the attached image? Reply exactly RED if it is red. Do not use tools.', files: [{ uri: 'file://' + resolve(directory, 'e2e-red.png') }] });
  await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(120_000) });
  const image = await client.session.context({ sessionID: id });
  const latest = image.findLast((m: any) => m.type === 'assistant');
  assert(JSON.stringify(latest).includes('RED'));
  console.log('PASS image attachment reaches Kiro');
  const imageReadId = await session();
  const imageRead = await ask(imageReadId, 'Use the read tool to inspect e2e-red.png, then reply with the dominant color. Do not use other tools.');
  assert(answer(imageRead).toUpperCase().includes('RED'));
  assert(imageRead.some((message: any) => message.content?.some((part: any) => part.type === 'tool' && part.name === 'read' && part.state.status === 'completed')));
  console.log('PASS image returned by native read tool reaches Kiro');
  await client.session.compact({ sessionID: id });
  await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(120_000) });
  const compacted = await client.session.context({ sessionID: id });
  assert(compacted.some((m: any) => m.type === 'compaction' && m.status === 'completed'));
  console.log('PASS native compaction');
  const cancelId = await session([{ action: '*', resource: '*', effect: 'ask' }]);
  await client.session.prompt({ sessionID: cancelId, text: 'Create cancelled-e2e.txt containing CANCELLED using the write tool.' });
  let permission: any;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const list = await client.permission.list({ sessionID: cancelId });
    permission = list[0];
    if (permission) break;
    await Bun.sleep(250);
  }
  assert(permission, 'Expected native OpenCode permission prompt');
  await client.session.interrupt({ sessionID: cancelId, resume: false });
  assert.equal(await Bun.file(resolve(directory, 'cancelled-e2e.txt')).exists(), false);
  console.log('PASS interruption while awaiting permission');
  const rejectId = await session([{ action: '*', resource: '*', effect: 'ask' }]);
  await client.session.prompt({ sessionID: rejectId, text: 'Create rejected-e2e.txt containing REJECTED using the write tool. If permission is rejected, report that and stop; do not retry.' });
  let rejection: any;
  const rejectDeadline = Date.now() + 60_000;
  while (Date.now() < rejectDeadline) {
    rejection = (await client.permission.list({ sessionID: rejectId }))[0];
    if (rejection) break;
    await Bun.sleep(250);
  }
  assert(rejection, 'Expected a real permission prompt before rejection');
  await client.permission.reply({ sessionID: rejectId, requestID: rejection.id, decision: 'reject', message: 'Rejected by integration test' });
  await client.session.wait({ sessionID: rejectId }, { signal: AbortSignal.timeout(120_000) });
  assert.equal(await Bun.file(resolve(directory, 'rejected-e2e.txt')).exists(), false);
  const rejectContext = await client.session.context({ sessionID: rejectId });
  assert(rejectContext.some((message: any) => message.content?.some((part: any) => part.type === 'tool' && part.state.status === 'error')));
  console.log('PASS rejected permission is returned to Kiro without execution');
  await ask(cancelId, 'Reply exactly RECOVERY_OK. Do not use tools.');
  assert.equal(answer(await client.session.context({ sessionID: cancelId })), 'RECOVERY_OK');
  console.log('PASS generation recovers after interruption');
  }
  const undoId = await session();
  const undoContext = await ask(undoId, 'Replace undo-e2e.txt contents with exactly UNDO_E2E_OK followed by a newline using the write tool.');
  assert.equal(await Bun.file(resolve(directory, 'undo-e2e.txt')).exists(), true);
  const message = undoContext.find((message: any) => message.type === 'user');
  assert(message);
  const diff = await client.session.diff({ sessionID: undoId, from: message.id });
  assert(diff.some(file => file.file.endsWith('undo-e2e.txt')));
  await client.session.revert.stage({ sessionID: undoId, messageID: message.id, files: true });
  assert.equal(await Bun.file(resolve(directory, 'undo-e2e.txt')).text(), 'BEFORE_UNDO\n');
  await client.session.revert.clear({ sessionID: undoId });
  assert.equal(await Bun.file(resolve(directory, 'undo-e2e.txt')).text(), 'UNDO_E2E_OK\n');
  console.log('PASS native session diff, undo and redo');
  const parallelA = await session(); const parallelB = await session();
  const [a, b] = await Promise.all([ask(parallelA, 'Reply exactly PARALLEL_ALPHA. No tools.'), ask(parallelB, 'Reply exactly PARALLEL_BETA. No tools.')]);
  assert.equal(answer(a), 'PARALLEL_ALPHA'); assert.equal(answer(b), 'PARALLEL_BETA');
  console.log('PASS simultaneous sessions remain isolated');
} finally {
  for (const sessionID of created) await client.session.remove({ sessionID }).catch(() => {});
  processServer.kill(); await processServer.exited;
  await rm(directory, { recursive: true, force: true });
}
