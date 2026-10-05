export {};
// Read-only MCP fixture used by the live end-to-end suite.
function handle(message: any) {
  if (message.id === undefined) return;
  let result: any = {};
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a supplied marker for integration testing.', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } }] };
  if (message.method === 'tools/call') result = { content: [{ type: 'text', text: `MCP_REPLY:${message.params.arguments.marker}` }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
let buffer = '';
for await (const bytes of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(bytes); let end: number;
  while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) handle(JSON.parse(line)); }
}
