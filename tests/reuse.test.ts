import { test, expect } from 'bun:test';
import { createBridge, followUp } from '../src/bridge';
import { resolve } from 'node:path';

const tools = [{ type: 'function', function: { name: 'write', parameters: { type: 'object' } } }];
async function open() {
  const bridge = await createBridge(process.cwd(), { cli: resolve('tests/fixtures/kiro') });
  const ask = async (session: string, messages: any[], extra: Record<string, unknown> = {}) => {
    const response = await fetch(bridge.url + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${bridge.secret}`, 'x-opencode-session': session }, body: JSON.stringify({ model: 'test', stream: true, messages, tools, ...extra }) });
    const text = await response.text();
    const content = text.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6))).map(c => c.choices?.[0]?.delta?.content || '').join('');
    return { text, content, echo: content.startsWith('{') ? JSON.parse(content) : undefined };
  };
  return { bridge, ask };
}
const system = { role: 'system', content: 'You are OpenCode.' };

test('follow-up messages reuse the Kiro session and send only the new turn', async () => {
  const { bridge, ask } = await open();
  try {
    const history: any[] = [system, { role: 'user', content: 'Remember KIWI. ECHO' }];
    const first = await ask('reuse', history);
    expect(first.echo.prompts).toHaveLength(1);
    expect(first.echo.prompts[0]).toContain('You are OpenCode.');
    history.push({ role: 'assistant', content: first.content }, { role: 'user', content: 'Second question ECHO' });
    const second = await ask('reuse', history);
    expect(second.echo.sessionId).toBe(first.echo.sessionId);
    expect(second.echo.prompts).toHaveLength(2);
    expect(second.echo.prompts[1]).toBe('[user]\nSecond question ECHO');
    // Usage still reports the whole OpenCode context, not the short follow-up.
    const usage = second.text.split('\n').filter(l => l.includes('"usage"')).map(l => JSON.parse(l.slice(6)).usage)[0];
    expect(usage.prompt_tokens).toBeGreaterThan(20);
  } finally { await bridge.stop(); }
});

test('changed history, tools or cancellation start a fresh Kiro session', async () => {
  const { bridge, ask } = await open();
  try {
    const base: any[] = [system, { role: 'user', content: 'One ECHO' }];
    const first = await ask('fresh', base);
    // Undo: the earlier user message was replaced.
    const undone = await ask('fresh', [system, { role: 'user', content: 'Different ECHO' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'Next ECHO' }]);
    expect(undone.echo.sessionId).not.toBe(first.echo.sessionId);
    expect(undone.echo.prompts[0]).toContain('Different ECHO');
    expect(undone.echo.terminated).toContain(first.echo.sessionId);
    const followed = [system, { role: 'user', content: 'Different ECHO' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'Next ECHO' }, { role: 'assistant', content: undone.content }, { role: 'user', content: 'Again ECHO' }];
    const changedTools = await ask('fresh', followed, { tools: [...tools, { type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
    expect(changedTools.echo.sessionId).not.toBe(undone.echo.sessionId);
    await bridge.cancel('fresh');
    const afterCancel = await ask('fresh', [...followed.slice(0, -1), { role: 'assistant', content: changedTools.content }, { role: 'user', content: 'Later ECHO' }]);
    expect(afterCancel.echo.sessionId).not.toBe(changedTools.echo.sessionId);
    expect(afterCancel.echo.prompts).toHaveLength(1);
  } finally { await bridge.stop(); }
});

test('sessions share one warm process; effort levels get their own', async () => {
  const { bridge, ask } = await open();
  try {
    const [a, b] = await Promise.all([ask('a', [{ role: 'user', content: 'A ECHO' }]), ask('b', [{ role: 'user', content: 'B ECHO' }])]);
    expect(a.echo.pid).toBe(b.echo.pid);
    expect(a.echo.sessionId).not.toBe(b.echo.sessionId);
    const later = await ask('c', [{ role: 'user', content: 'C ECHO' }]);
    expect(later.echo.pid).toBe(a.echo.pid);
    const high = await ask('a', [{ role: 'user', content: 'A ECHO' }, { role: 'assistant', content: a.content }, { role: 'user', content: 'High ECHO' }], { reasoning_effort: 'high' });
    expect(high.echo.pid).not.toBe(a.echo.pid);
    expect(high.echo.prompts).toHaveLength(1);
  } finally { await bridge.stop(); }
});

test('follow-up detection accepts only appended user turns', () => {
  const m = (role: string, content: string, extra = {}) => ({ role, content, ...extra });
  const digest = (v: unknown) => new Bun.CryptoHasher('sha256').update(JSON.stringify(v)).digest('hex');
  const seen = [m('system', 's'), m('user', 'u1')];
  const history = seen.map(digest);
  expect(followUp(history, [...seen, m('assistant', 'a1'), m('user', 'u2')])).toEqual([m('user', 'u2')]);
  expect(followUp(history, [...seen, m('user', 'u2')])).toEqual([m('user', 'u2')]);
  expect(followUp(history, seen)).toBeUndefined();
  expect(followUp(history, [m('system', 'changed'), m('user', 'u1'), m('user', 'u2')])).toBeUndefined();
  expect(followUp(history, [...seen, m('assistant', '', { tool_calls: [{ id: 'x' }] }), m('tool', 'r')])).toBeUndefined();
  expect(followUp([], [m('user', 'u1')])).toBeUndefined();
});
