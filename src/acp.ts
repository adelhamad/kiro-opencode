import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAuthenticated, forgetAuthentication, isAuthError, loginInstruction, killCli } from './auth';

type Rpc = Record<string, any>;
// One `kiro-cli acp` process. It hosts many concurrent Kiro sessions, so a
// cancelled or failed conversation cancels its session instead of the process.
export class AcpClient {
  private child?: ReturnType<typeof Bun.spawn>;
  private directory?: string;
  private sequence = 0;
  private closed = false;
  private failure?: Error;
  private cli = 'kiro-cli';
  private controller = new AbortController();
  private diagnostics = Promise.resolve('');
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, (msg: Rpc) => void>();
  get alive() { return !this.failure && !this.closed; }
  onUpdate(sessionId: string, listener?: (msg: Rpc) => void) {
    if (listener) this.listeners.set(sessionId, listener); else this.listeners.delete(sessionId);
  }
  async start(cli = 'kiro-cli', effort?: string) {
    this.cli = cli;
    await ensureAuthenticated(cli, this.controller.signal);
    this.directory = await mkdtemp(join(tmpdir(), 'opencode-kiro-'));
    await mkdir(join(this.directory, '.kiro/agents'), { recursive: true });
    await writeFile(join(this.directory, '.kiro/agents/opencode.json'), JSON.stringify({
      name: 'opencode', description: 'OpenCode-controlled tool execution',
      prompt: 'You are the model behind OpenCode. Use only tools from the opencode MCP server. OpenCode owns tool execution and permissions. Follow the supplied conversation and system instructions.',
      tools: ['@opencode'], allowedTools: ['@opencode'], includeMcpJson: false,
      resources: [], hooks: {}, model: 'claude-sonnet-4.6',
    }));
    if (this.closed) { await rm(this.directory, { recursive: true, force: true }); throw new Error('Kiro connection closed'); }
    this.child = Bun.spawn([cli, 'acp', '--agent-engine', 'v2', '--agent', 'opencode', ...(effort ? ['--effort', effort] : [])], {
      cwd: this.directory, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: process.platform !== 'win32',
    });
    this.diagnostics = (async () => {
      let tail = '';
      const decoder = new TextDecoder();
      for await (const bytes of this.child!.stderr as ReadableStream<Uint8Array>) {
        tail = (tail + decoder.decode(bytes, { stream: true })).slice(-8192);
      }
      return tail;
    })().catch(() => '');
    void this.read();
    return this.call('initialize', { protocolVersion: 1, clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false }, terminal: false,
    }, clientInfo: { name: 'opencode-kiro', version: '0.3.0' } }, 30_000);
  }
  send(message: Rpc) { (this.child?.stdin as import('bun').FileSink | undefined)?.write(JSON.stringify(message) + '\n'); }
  notify(method: string, params: Rpc) { if (this.alive) this.send({ jsonrpc: '2.0', method, params }); }
  terminate(sessionId: string) {
    this.listeners.delete(sessionId);
    if (this.alive) void this.call('_kiro.dev/session/terminate', { sessionId }, 10_000).catch(() => {});
  }
  call(method: string, params: Rpc, timeout = 180_000): Promise<any> {
    if (this.failure || this.closed) return Promise.reject(this.failure || new Error('Kiro connection closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Kiro ${method} timed out. Check the CLI in a terminal, then retry.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  private async read() {
    let buffer = ''; const decoder = new TextDecoder();
    try {
      for await (const bytes of this.child!.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
        if (buffer.length > 32 * 1024 * 1024) throw new Error('Kiro ACP frame exceeds 32 MiB');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          const msg: Rpc = JSON.parse(line);
          if (msg.method === 'session/update' || msg.method === '_kiro.dev/metadata') this.listeners.get(msg.params?.sessionId)?.(msg);
          else if (msg.method && msg.id !== undefined) {
            // Only MCP tools are approved: their execution is relayed to OpenCode.
            if (msg.method === 'session/request_permission') {
              const title = String(msg.params?.toolCall?.title || '');
              const mcp = title.includes('opencode') || String(msg.params?.toolCall?.rawInput?.name || '').startsWith('opencode');
              const option = msg.params.options?.find((o: Rpc) => o.kind === (mcp ? 'allow_once' : 'reject_once'));
              this.send({ jsonrpc: '2.0', id: msg.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
            } else this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unsupported client capability' } });
          } else {
            const item = this.pending.get(msg.id);
            if (!item) continue;
            this.pending.delete(msg.id); clearTimeout(item.timer);
            msg.error ? item.reject(new Error(isAuthError(JSON.stringify(msg.error)) ? loginInstruction(this.cli) : `Kiro: ${msg.error.message}${msg.error.data ? ' ' + JSON.stringify(msg.error.data) : ''}`)) : item.resolve(msg.result);
          }
        }
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    const diagnostics = await this.diagnostics;
    this.fail(new Error(isAuthError(diagnostics) ? loginInstruction(this.cli) : 'Kiro process exited. Check kiro-cli in a terminal and retry.'));
  }
  private fail(error: Error) {
    if (!this.failure && isAuthError(error.message)) forgetAuthentication();
    this.failure ??= error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  async stop() {
    this.closed = true;
    this.controller.abort();
    this.fail(new Error('Kiro connection closed'));
    if (this.child) killCli(this.child);
    if (this.child) await this.child.exited;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

// Warm processes keyed by reasoning effort, which Kiro only accepts at launch.
// A process stops after it has been idle, on authentication failure and on unload.
export class AcpPool {
  private entries = new Map<string, { client: AcpClient; ready: Promise<unknown>; users: number; idle?: ReturnType<typeof setTimeout> }>();
  constructor(private cli = 'kiro-cli', private idleMs = 15 * 60_000) {}
  async acquire(effort?: string) {
    const key = effort || '';
    let entry = this.entries.get(key);
    if (entry && !entry.client.alive) { this.entries.delete(key); void entry.client.stop(); entry = undefined; }
    if (!entry) {
      const client = new AcpClient();
      entry = { client, ready: client.start(this.cli, effort), users: 0 };
      this.entries.set(key, entry);
    }
    const current = entry;
    if (current.idle) { clearTimeout(current.idle); current.idle = undefined; }
    current.users++;
    try { await current.ready; return current.client; }
    catch (error) { this.release(current.client); await this.discard(current.client); throw error; }
  }
  release(client: AcpClient) {
    for (const entry of this.entries.values()) {
      if (entry.client !== client) continue;
      entry.users = Math.max(0, entry.users - 1);
      if (entry.users || entry.idle) continue;
      if (this.idleMs <= 0) void this.discard(client);
      else entry.idle = setTimeout(() => void this.discard(client), this.idleMs);
    }
  }
  async discard(client: AcpClient) {
    for (const [key, entry] of this.entries) if (entry.client === client) { if (entry.idle) clearTimeout(entry.idle); this.entries.delete(key); }
    await client.stop();
  }
  // Launch the default process early. Kiro's first session in a process takes
  // about a second longer than later ones, so open and end one empty session.
  async prewarm(cwd: string) {
    try {
      const client = await this.acquire();
      try {
        if (this.warmed.has(client)) return;
        this.warmed.add(client);
        const { sessionId } = await client.call('session/new', { cwd, mcpServers: [] });
        client.terminate(sessionId);
      } finally { this.release(client); }
    } catch {}
  }
  private warmed = new WeakSet<AcpClient>();
  async stop() { await Promise.all([...this.entries.values()].map(entry => this.discard(entry.client))); }
}
