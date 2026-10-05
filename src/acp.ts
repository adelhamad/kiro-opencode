import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Rpc = Record<string, any>;
export class AcpClient {
  private child?: ReturnType<typeof Bun.spawn>;
  private directory?: string;
  private sequence = 0;
  private closed = false;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onUpdate: (params: Rpc) => void = () => {};
  async start(cli = 'kiro-cli', effort?: string) {
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
      cwd: this.directory, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
    });
    void this.read();
    return this.call('initialize', { protocolVersion: 1, clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false }, terminal: false,
    }, clientInfo: { name: 'opencode-kiro', version: '0.2.0' } });
  }
  send(message: Rpc) { (this.child?.stdin as import('bun').FileSink | undefined)?.write(JSON.stringify(message) + '\n'); }
  call(method: string, params: Rpc, timeout = 180_000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Kiro ${method} timed out`)); }, timeout);
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
          if (msg.method === 'session/update' || msg.method === '_kiro.dev/metadata') this.onUpdate(msg);
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
            msg.error ? item.reject(new Error(`Kiro: ${msg.error.message}${msg.error.data ? ' ' + JSON.stringify(msg.error.data) : ''}`)) : item.resolve(msg.result);
          }
        }
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    this.fail(new Error('Kiro process exited'));
  }
  private fail(error: Error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
  async stop() {
    this.closed = true;
    this.fail(new Error('Kiro connection closed'));
    this.child?.kill();
    if (this.child) await this.child.exited;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
