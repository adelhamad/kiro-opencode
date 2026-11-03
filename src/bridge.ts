import { AcpPool, type AcpClient } from './acp';
import { forgetAuthentication, isAuthError } from './auth';
import { promptBlocks, toolResult } from './prompt';
import { estimatedUsage } from './usage';
import { debug, shape } from './debug';
import { fileURLToPath } from 'node:url';

type Json = Record<string, any>;
type Event = { type: 'text' | 'reasoning'; text: string } | { type: 'tool'; id: string; name: string; args: any } | { type: 'done' } | { type: 'error'; message: string };
class Queue {
  private items: Event[] = [];
  private waiting?: (value: Event) => void;
  push(item: Event) { if (this.waiting) { const next = this.waiting; this.waiting = undefined; next(item); } else this.items.push(item); }
  next(): Promise<Event> { const item = this.items.shift(); return item ? Promise.resolve(item) : new Promise(resolve => this.waiting = resolve); }
}
// One Kiro session for one OpenCode conversation (session ID + request kind).
// `history` holds digests of the OpenCode messages Kiro has already received,
// so a follow-up message can be sent alone instead of replaying the transcript.
interface Conversation {
  key: string; token: string; client: AcpClient; sessionId: string; effort: string; cwd: string; model?: string;
  tools: Json[]; toolsDigest: string; history: string[]; seen: string[]; reusable: boolean; turn?: Turn;
}
interface Turn {
  conversation: Conversation; queue: Queue; results: Map<string, (result: any) => void>;
  completed: boolean; stopped: boolean; published: Set<string>; timer?: ReturnType<typeof setTimeout>;
}
const digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(JSON.stringify(value) ?? '').digest('hex');

// Messages after the part Kiro already has, or undefined when the history was
// changed (undo, compaction, edited instructions) and a fresh session is needed.
export function followUp(history: string[], messages: Json[], hashes = messages.map(digest)) {
  if (!history.length || hashes.length <= history.length) return;
  for (let index = 0; index < history.length; index++) if (hashes[index] !== history[index]) return;
  let rest = messages.slice(history.length);
  // Kiro produced the final assistant reply itself; it is already in its session.
  if (rest[0]?.role === 'assistant' && !rest[0].tool_calls?.length) rest = rest.slice(1);
  if (!rest.length || rest.some(message => message.role !== 'user' && message.role !== 'system')) return;
  return rest;
}

export async function createBridge(directory: string, options: { cli?: string; model?: string; idleMs?: number } = {}) {
  const secret = crypto.randomUUID();
  const pool = new AcpPool(options.cli, options.idleMs);
  const conversations = new Map<string, Conversation>();
  const tokens = new Map<string, Conversation>();
  // Ending the Kiro session also stops its MCP relay process.
  const forget = (conversation: Conversation) => {
    tokens.delete(conversation.token);
    if (conversations.get(conversation.key) === conversation) conversations.delete(conversation.key);
    conversation.reusable = false;
    if (!conversation.sessionId) return;
    conversation.client.onUpdate(conversation.sessionId);
    conversation.client.terminate(conversation.sessionId);
    conversation.sessionId = '';
  };
  // Cancel only this Kiro session: the process is shared. A cancelled Kiro
  // session can answer later prompts with an immediate cancellation, so drop it.
  const stopTurn = async (turn: Turn) => {
    if (turn.stopped) return;
    turn.stopped = true;
    if (turn.timer) clearTimeout(turn.timer);
    for (const resolve of turn.results.values()) resolve({ content: [{ type: 'text', text: 'OpenCode cancelled this tool call.' }], isError: true });
    turn.results.clear();
    turn.queue.push({ type: 'error', message: 'Generation cancelled' });
    const conversation = turn.conversation;
    if (!turn.completed) conversation.client.notify('session/cancel', { sessionId: conversation.sessionId });
    if (conversation.turn === turn) conversation.turn = undefined;
    forget(conversation);
    if (!turn.completed) { turn.completed = true; pool.release(conversation.client); }
  };
  // Stdio relay: Kiro's HTTP MCP client gives up on a tool call after about two
  // minutes, which is shorter than an OpenCode permission prompt may wait.
  const mcpServer = (token: string) => ({ name: 'opencode', command: Bun.which('bun') || 'bun', args: [fileURLToPath(new URL('./mcp.ts', import.meta.url)), `${server.url}mcp/${token}`], env: [] });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/mcp/')) {
        const conversation = tokens.get(url.pathname.slice(5));
        if (!conversation) return Response.json({ error: 'Unknown MCP session' }, { status: 404 });
        let msg: Json;
        try { msg = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
        let result: any = {};
        if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'opencode', version: '0.3.0' } };
        else if (msg.method === 'tools/list') result = { tools: conversation.tools.map(tool => ({ name: tool.function.name, description: tool.function.description || '', inputSchema: tool.function.parameters || { type: 'object', properties: {} } })) };
        else if (msg.method === 'tools/call') {
          const name = msg.params.name;
          const turn = conversation.turn;
          if (!conversation.tools.some(tool => tool.function.name === name)) return Response.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } });
          if (!turn || turn.stopped) return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'OpenCode cancelled this tool call.' }], isError: true } });
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
      const received = Date.now();
      const messages: any[] = body.messages || [];
      const key = request.headers.get('x-opencode-session') || crypto.randomUUID();
      const kind = request.headers.get('x-opencode-kind') || 'primary';
      const conversationKey = `${key}:${kind}`;
      const existing = conversations.get(conversationKey);
      const continuing = existing?.turn && existing.turn.results.size ? existing.turn : undefined;
      debug('request', { key: conversationKey, model: body.model, effort: body.reasoning_effort, tools: (body.tools || []).length, continuation: Boolean(continuing), messages: shape(messages) });
      let turn: Turn;
      if (continuing) {
        turn = continuing;
        // Set up the next response before unblocking Kiro's pending MCP request.
        const toolMessages = messages.filter(m => m.role === 'tool');
        const unresolved = [...turn.published];
        for (const id of unresolved) {
          const msg = toolMessages.findLast(m => m.tool_call_id === id);
          if (!msg) return Response.json({ error: { message: `Missing result for tool call ${id}` } }, { status: 400 });
        }
        turn.conversation.seen = messages.map(digest);
        for (const id of unresolved) {
          turn.results.get(id)!(toolResult(messages, id));
          turn.results.delete(id); turn.published.delete(id);
        }
      } else {
        if (existing?.turn) await stopTurn(existing.turn);
        const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : '';
        const cwd = request.headers.get('x-opencode-directory') || directory;
        const tools: Json[] = body.tools || [];
        const toolsDigest = digest(tools);
        const model = body.model === 'auto' ? (options.model || 'claude-sonnet-4.6') : body.model;
        const hashes = messages.map(digest);
        let client: AcpClient;
        try { client = await pool.acquire(effort || undefined); }
        catch (error) {
          const message = String(error);
          return Response.json({ error: { message, type: isAuthError(message) ? 'authentication_error' : 'kiro_error' } }, { status: isAuthError(message) ? 401 : 502, headers: { 'x-should-retry': 'false' } });
        }
        debug('started', { key: conversationKey, ms: Date.now() - received });
        const reuse = existing && conversations.get(conversationKey) === existing && existing.reusable && existing.client === client && client.alive
          && existing.effort === effort && existing.cwd === cwd && existing.toolsDigest === toolsDigest ? followUp(existing.history, messages, hashes) : undefined;
        if (existing && !reuse) forget(existing);
        const conversation: Conversation = reuse ? existing! : { key: conversationKey, token: crypto.randomUUID(), client, sessionId: '', effort, cwd, tools, toolsDigest, history: [], seen: [], reusable: false };
        conversation.seen = hashes;
        turn = { conversation, queue: new Queue(), results: new Map(), completed: false, stopped: false, published: new Set() };
        conversation.turn = turn;
        const active = turn;
        const listen = (msg: Json) => {
          if (conversation.turn !== active) return;
          const update = msg.params?.update;
          const content = update?.content;
          if (content?.type === 'text' && update.sessionUpdate === 'agent_message_chunk') active.queue.push({ type: 'text', text: content.text });
          if (content?.type === 'text' && update.sessionUpdate === 'agent_thought_chunk') active.queue.push({ type: 'reasoning', text: content.text });
          if (msg.params?.meteringUsage) debug('metering', { key: conversation.key, credits: msg.params.meteringUsage.reduce((sum: number, item: Json) => sum + (item.value || 0), 0), turnDurationMs: msg.params.turnDurationMs, context: msg.params.contextUsagePercentage });
        };
        const abortStartup = () => { void stopTurn(active); };
        request.signal.addEventListener('abort', abortStartup, { once: true });
        if (request.signal.aborted) void stopTurn(active);
        void (async () => {
          try {
            if (!reuse) {
              // Kiro initializes the MCP server during session/new.
              tokens.set(conversation.token, conversation);
              conversations.set(conversationKey, conversation);
              const session = await client.call('session/new', { cwd, mcpServers: tools.length ? [mcpServer(conversation.token)] : [] });
              conversation.sessionId = session.sessionId;
            }
            if (active.stopped) { if (!reuse) forget(conversation); throw new Error('Generation cancelled'); }
            client.onUpdate(conversation.sessionId, listen);
            if (conversation.model !== model) {
              await client.call('session/set_model', { sessionId: conversation.sessionId, modelId: model });
              conversation.model = model;
            }
            const prompt = promptBlocks(reuse || messages);
            debug('prompt', { key: conversationKey, ms: Date.now() - received, chars: prompt[0]!.text.length, fresh: !reuse, sent: (reuse || messages).length, of: messages.length });
            if (active.stopped) throw new Error('Generation cancelled');
            const result = await client.call('session/prompt', { sessionId: conversation.sessionId, prompt }, 900_000);
            if (!['end_turn', 'max_tokens'].includes(result.stopReason)) throw new Error(`Kiro stopped with ${result.stopReason}`);
            if (active.stopped) return;
            active.completed = true;
            if (active.timer) clearTimeout(active.timer);
            conversation.turn = undefined;
            // Only primary conversations continue; titles and summaries are one-shot.
            conversation.history = conversation.seen;
            conversation.reusable = kind === 'primary' && result.stopReason === 'end_turn';
            if (!conversation.reusable) forget(conversation);
            pool.release(client);
            active.queue.push({ type: 'done' });
          } catch (error) {
            const message = String(error);
            if (active.stopped) return;
            active.stopped = true;
            if (active.timer) clearTimeout(active.timer);
            if (conversation.sessionId) client.notify('session/cancel', { sessionId: conversation.sessionId });
            active.completed = true;
            if (conversation.turn === active) conversation.turn = undefined;
            forget(conversation);
            pool.release(client);
            // A new process re-checks authentication after the user signs in again.
            if (isAuthError(message)) { forgetAuthentication(); void pool.discard(client); }
            active.queue.push({ type: 'error', message });
          } finally { request.signal.removeEventListener('abort', abortStartup); }
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
      // Usage describes the full OpenCode context, not the shorter follow-up
      // prompt, because OpenCode uses it for context accounting and compaction.
      const usageChunk = () => ({ ...chunk({}), choices: [], usage: estimatedUsage(messages, body.tools, output), kiro_usage_estimated: true });
      const stream = new ReadableStream({
        start(controller) {
          const emit = (data: any) => { if (!closed) controller.enqueue(encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)); };
          const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n')); }, 10_000);
          emit(chunk({ role: 'assistant' }));
          let first = true;
          void (async () => {
            while (!closed) {
              const event = await active.queue.next();
              if (first) { first = false; debug('first_event', { key: active.conversation.key, type: event.type, ms: Date.now() - received }); }
              if (event.type === 'done' || event.type === 'error' || event.type === 'tool') debug('response_end', { key: active.conversation.key, type: event.type, ms: Date.now() - received });
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
            // A published tool call waits for OpenCode's result in the next request.
            if (!active.completed && !active.stopped) active.timer = setTimeout(() => void stopTurn(active), 300_000);
          });
        },
        cancel() { closed = true; void stopTurn(active); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    },
  });
  const stopAll = (filter: (conversation: Conversation) => boolean) => Promise.all([...conversations.values(), ...tokens.values()].filter(filter).map(conversation => {
    if (conversation.turn) return stopTurn(conversation.turn);
    forget(conversation);
  }));
  return {
    url: `${server.url}v1`, secret,
    // Start the default Kiro process ahead of the first message. No model request is made.
    async prewarm() { await pool.prewarm(directory); },
    async cancel(sessionID: string) { await stopAll(conversation => conversation.key.startsWith(sessionID + ':')); },
    async stop() { await stopAll(() => true); await pool.stop(); await server.stop(true); },
  };
}
