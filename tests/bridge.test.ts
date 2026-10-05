import { test, expect } from 'bun:test';
import { createBridge } from '../src/bridge';
import { promptBlocks } from '../src/prompt';
import { resolve } from 'node:path';

test('history preserves tool identities and image bytes', () => {
  const blocks = promptBlocks([
    { role: 'assistant', content: null, tool_calls: [{ id: 'call1', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'call1', content: 'result' },
    { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
  ]);
  expect(blocks[0].text).toContain('tool_call id=call1 name=read');
  expect(blocks[0].text).toContain('[tool id=call1]');
  expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'YQ==' });
});
test('unsupported attachments fail explicitly', () => {
  expect(() => promptBlocks([{ role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,YQ==' } }] }])).toThrow('Binary document');
});
test('private bridge authenticates and streams text', async () => {
  const bridge = await createBridge(process.cwd(), { cli: resolve('tests/fixtures/kiro') });
  try {
    expect((await fetch(bridge.url + '/models')).status).toBe(401);
    const response = await fetch(bridge.url + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${bridge.secret}` }, body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: true }) });
    const text = await response.text();
    expect(text).toContain('FAKE_OK'); expect(text).toContain('[DONE]');
  } finally { await bridge.stop(); }
});
test('tool runs in caller and result resumes the suspended Kiro turn', async () => {
  const bridge = await createBridge(process.cwd(), { cli: resolve('tests/fixtures/kiro') });
  const request = async (messages: any[]) => fetch(bridge.url + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${bridge.secret}`, 'x-opencode-session': 'tool-test' }, body: JSON.stringify({ model: 'test', stream: true, messages, tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object' } } }] }) });
  try {
    const first = await (await request([{ role: 'user', content: 'TOOL' }])).text();
    const chunks = first.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
    const call = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls || [])[0];
    expect(call.function.name).toBe('write');
    expect(first).toContain('"finish_reason":"tool_calls"');
    const second = await (await request([{ role: 'tool', tool_call_id: call.id, content: 'permission denied' }])).text();
    expect(second).toContain('permission denied'); expect(second).toContain('"finish_reason":"stop"');
  } finally { await bridge.stop(); }
});
test('cancellation releases a suspended tool and next turn succeeds', async () => {
  const bridge = await createBridge(process.cwd(), { cli: resolve('tests/fixtures/kiro') });
  const request = async (content: string) => fetch(bridge.url + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${bridge.secret}`, 'x-opencode-session': 'cancel-test' }, body: JSON.stringify({ model: 'test', stream: true, messages: [{ role: 'user', content }], tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object' } } }] }) });
  try {
    await (await request('TOOL')).text();
    await bridge.cancel('cancel-test');
    expect(await (await request('hi')).text()).toContain('FAKE_OK');
  } finally { await bridge.stop(); }
});

test('parallel upstream tool calls are delivered without requiring unpublished results', async () => {
  const bridge = await createBridge(process.cwd(), { cli: resolve('tests/fixtures/kiro') });
  const messages: any[] = [{ role: 'user', content: 'PARALLEL_TOOL' }];
  const ids: string[] = [];
  try {
    for (let round = 0; round < 3; round++) {
      const response = await fetch(bridge.url + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${bridge.secret}`, 'x-opencode-session': 'parallel-test' }, body: JSON.stringify({ model: 'test', stream: true, messages, tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object' } } }] }) });
      expect(response.status).toBe(200);
      const text = await response.text();
      const chunks = text.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
      const call = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls || [])[0];
      if (call) {
        ids.push(call.id); messages.push({ role: 'tool', tool_call_id: call.id, content: `result-${round}` });
      } else { expect(text).toContain('result-0'); expect(text).toContain('result-1'); expect(text).toContain('"finish_reason":"stop"'); }
    }
    expect(new Set(ids).size).toBe(2);
  } finally { await bridge.stop(); }
});

test('image tool outputs survive the synthetic OpenAI user-turn conversion', async () => {
  const { toolResult } = await import('../src/prompt');
  const result = toolResult([
    { role: 'tool', tool_call_id: 'image1', content: 'Image attached' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
  ], 'image1');
  expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'YQ==' });
});
