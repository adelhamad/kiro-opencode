import { AcpClient } from './acp';
import { isAuthError } from './auth';
import { promptBlocks, toolResult } from './prompt';
import { estimatedUsage } from './usage';
import { fileURLToPath } from 'node:url';

type Json = Record<string, any>;
type Event = { type: 'text' | 'reasoning'; text: string } | { type: 'tool'; id: string; name: string; args: any } | { type: 'done' } | { type: 'error'; message: string };
class Queue {
  private items: Event[] = [];
  private waiting?: (value: Event) => void;
  push(item: Event) { if (this.waiting) { const next = this.waiting; this.waiting = undefined; next(item); } else this.items.push(item); }
  next(): Promise<Event> { const item = this.items.shift(); return item ? Promise.resolve(item) : new Promise(resolve => this.waiting = resolve); }
}
interface Turn {
  key: string; token: string; client: AcpClient; sessionId?: string; tools: Json[]; queue: Queue;
  results: Map<string, (result: any) => void>; completed: boolean; stopped: boolean; published: Set<string>; timer?: ReturnType<typeof setTimeout>;
}
export async function createBridge(directory: string, options: { cli?: string; model?: string } = {}) {
  const secret = crypto.randomUUID();
  const turns = new Map<string, Turn>();
  const tokens = new Map<string, Turn>();
  const stopTurn = async (turn: Turn) => {
    if (turn.stopped) return;
    turn.stopped = true;
    if (turn.timer) clearTimeout(turn.timer);
    for (const resolve of turn.results.values()) resolve({ content: [{ type: 'text', text: 'OpenCode cancelled this tool call.' }], isError: true });
    turn.results.clear(); tokens.delete(turn.token); if (turns.get(turn.key) === turn) turns.delete(turn.key);
    turn.queue.push({ type: 'error', message: 'Generation cancelled' });
    await turn.client.stop();
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/mcp/')) {
        const turn = tokens.get(url.pathname.slice(5));
        if (!turn) return Response.json({ error: 'Unknown MCP session' }, { status: 404 });
        const msg: Json = await request.json();
        let result: any = {};
        if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'opencode', version: '0.2.0' } };
        else if (msg.method === 'tools/list') result = { tools: turn.tools.map(tool => ({ name: tool.function.name, description: tool.function.description || '', inputSchema: tool.function.parameters || { type: 'object', properties: {} } })) };
        else if (msg.method === 'tools/call') {
          const name = msg.params.name;
          if (!turn.tools.some(tool => tool.function.name === name)) return Response.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } });
          const id = 'call_' + crypto.randomUUID().replaceAll('-', '');
          result = await new Promise(resolve => {
            turn.results.set(id, resolve);
            turn.queue.push({ type: 'tool', id, name, args: msg.params.arguments || {} });
          });
        }
        if (msg.id === undefined) return new Response(null, { status: 204 });
        return Response.json({ jsonrpc: '2.0', id: msg.id, result });
      }
      if (request.headers.get('authorization') !== `Bearer ${secret}`) return Response.json({ error: { message: 'Unauthorized' } }, { status: 401 });
      if (url.pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: options.model || 'claude-sonnet-4.6', object: 'model', owned_by: 'kiro', created: 0 }] });
      if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') return Response.json({ error: { message: 'Not found' } }, { status: 404 });
      let body: Json;
      try { body = await request.json(); } catch { return Response.json({ error: { message: 'Invalid JSON' } }, { status: 400 }); }
      const key = request.headers.get('x-opencode-session') || crypto.randomUUID();
      const kind = request.headers.get('x-opencode-kind') || 'primary';
      const turnKey = `${key}:${kind}`;
      let turn = turns.get(turnKey);
      const toolMessages = (body.messages || []).filter((m: Json) => m.role === 'tool');
      if (turn && turn.results.size) {
        // Set up the next response before unblocking Kiro's pending MCP request.
        const unresolved = [...turn.published];
        for (const id of unresolved) {
          const msg = toolMessages.findLast((m: Json) => m.tool_call_id === id);
          if (!msg) return Response.json({ error: { message: `Missing result for tool call ${id}` } }, { status: 400 });
        }
        for (const id of unresolved) {
          turn.results.get(id)!(toolResult(body.messages, id));
          turn.results.delete(id); turn.published.delete(id);
        }
      } else {
        if (turn) await stopTurn(turn);
        turn = { key: turnKey, token: crypto.randomUUID(), client: new AcpClient(), tools: body.tools || [], queue: new Queue(), results: new Map(), completed: false, stopped: false, published: new Set() };
        turns.set(turnKey, turn); tokens.set(turn.token, turn);
        const active = turn;
        active.client.onUpdate = msg => {
          const update = msg.params?.update;
          const content = update?.content;
          if (content?.type === 'text' && update.sessionUpdate === 'agent_message_chunk') active.queue.push({ type: 'text', text: content.text });
          if (content?.type === 'text' && update.sessionUpdate === 'agent_thought_chunk') active.queue.push({ type: 'reasoning', text: content.text });
        };
        const abortStartup = () => { void stopTurn(active); };
        request.signal.addEventListener('abort', abortStartup, { once: true });
        try {
          if (request.signal.aborted) await stopTurn(active);
          await active.client.start(options.cli, typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined);
        } catch (error) {
          await stopTurn(active);
          const message = String(error);
          return Response.json({ error: { message, type: isAuthError(message) ? 'authentication_error' : 'kiro_error' } }, { status: isAuthError(message) ? 401 : 502, headers: { 'x-should-retry': 'false' } });
        } finally { request.signal.removeEventListener('abort', abortStartup); }
        void (async () => {
          try {
            const session = await active.client.call('session/new', { cwd: request.headers.get('x-opencode-directory') || directory, mcpServers: [{ name: 'opencode', command: Bun.which('bun') || 'bun', args: [fileURLToPath(new URL('./mcp.ts', import.meta.url)), `${server.url}mcp/${active.token}`], env: [] }] });
            active.sessionId = session.sessionId;
            await active.client.call('session/set_model', { sessionId: active.sessionId, modelId: body.model === 'auto' ? (options.model || 'claude-sonnet-4.6') : body.model });
            const prompt = promptBlocks(body.messages || []);
            const result = await active.client.call('session/prompt', { sessionId: active.sessionId, prompt }, 900_000);
            if (!['end_turn', 'max_tokens'].includes(result.stopReason)) throw new Error(`Kiro stopped with ${result.stopReason}`);
            active.completed = true; active.queue.push({ type: 'done' });
          } catch (error) { active.completed = true; active.queue.push({ type: 'error', message: String(error) }); }
        })();
      }
      const active = turn;
      const abort = () => void stopTurn(active);
      request.signal.addEventListener('abort', abort, { once: true });
      if (active.timer) clearTimeout(active.timer);
      const id = 'chatcmpl-' + crypto.randomUUID();
      const created = Math.floor(Date.now() / 1000);
      const model = body.model;
      const chunk = (delta: Json, finish_reason: string | null = null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }] });
      const encoder = new TextEncoder(); let closed = false; let output = '';
      const usageChunk = () => ({ ...chunk({}), choices: [], usage: estimatedUsage(body.messages, body.tools, output), kiro_usage_estimated: true });
      const stream = new ReadableStream({
        start(controller) {
          const emit = (data: any) => { if (!closed) controller.enqueue(encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)); };
          const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n')); }, 10_000);
          emit(chunk({ role: 'assistant' }));
          void (async () => {
            while (!closed) {
              const event = await active.queue.next();
              if (event.type === 'text') { output += event.text; emit(chunk({ content: event.text })); }
              else if (event.type === 'reasoning') { output += event.text; emit(chunk({ reasoning_content: event.text })); }
              else if (event.type === 'tool') {
                active.published.add(event.id); output += event.name + JSON.stringify(event.args);
                emit(chunk({ tool_calls: [{ index: 0, id: event.id, type: 'function', function: { name: event.name, arguments: JSON.stringify(event.args) } }] }));
                emit(chunk({}, 'tool_calls')); emit(usageChunk()); emit('[DONE]'); break;
              } else if (event.type === 'done') { emit(chunk({}, 'stop')); emit(usageChunk()); emit('[DONE]'); break; }
              else if (event.type === 'error') { emit({ error: { message: event.message, type: isAuthError(event.message) ? 'authentication_error' : 'kiro_error', ...(isAuthError(event.message) ? { code: 401 } : {}) } }); emit('[DONE]'); break; }
            }
          })().finally(() => {
            clearInterval(heartbeat); request.signal.removeEventListener('abort', abort);
            if (!closed) { closed = true; controller.close(); }
            if (active.completed) void stopTurn(active);
            else if (!active.stopped) active.timer = setTimeout(() => void stopTurn(active), 300_000);
          });
        },
        cancel() { closed = true; void stopTurn(active); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    },
  });
  return { url: `${server.url}v1`, secret, async cancel(sessionID: string) { await Promise.all([...turns.values()].filter(turn => turn.key.startsWith(sessionID + ':')).map(stopTurn)); }, async stop() { await Promise.all([...turns.values()].map(stopTurn)); await server.stop(true); } };
}
