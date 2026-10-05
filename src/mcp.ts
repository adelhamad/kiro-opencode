export {};
// Private stdio MCP transport. Tool execution happens exclusively in OpenCode.
const endpoint = process.argv[2];
let buffer = '';
const decoder = new TextDecoder();
async function dispatch(line: string) {
  const message = JSON.parse(line);
  try {
    const response = await fetch(endpoint!, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    if (message.id !== undefined) process.stdout.write(JSON.stringify(await response.json()) + '\n');
  } catch (error) {
    if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } }) + '\n');
  }
}
for await (const bytes of Bun.stdin.stream()) {
  buffer += decoder.decode(bytes, { stream: true });
  let end: number;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (line.trim()) void dispatch(line);
  }
}
