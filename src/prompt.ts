type Message = { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string };
export function promptBlocks(messages: Message[]) {
  const images: any[] = [];
  const transcript = messages.map(message => {
    const content = typeof message.content === 'string' ? message.content : (message.content || []).map((part: any) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image_url') {
        const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(part.image_url.url);
        if (!match) throw new Error('Image attachments must use base64 data URLs');
        images.push({ type: 'image', mimeType: match[1], data: match[2] });
        return `[image ${images.length}]`;
      }
      if (part.type === 'file') {
        const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(part.file.file_data);
        if (!match || !match[1]!.startsWith('text/')) throw new Error('Binary document attachments are not supported by Kiro ACP');
        return `[file ${part.file.filename}]\n${Buffer.from(match[2]!, 'base64').toString('utf8')}`;
      }
      throw new Error(`Unsupported content part: ${part.type}`);
    }).join('\n');
    const calls = message.tool_calls?.map(call => `[tool_call id=${call.id} name=${call.function.name}] ${call.function.arguments}`).join('\n');
    return `[${message.role}${message.tool_call_id ? ` id=${message.tool_call_id}` : ''}]\n${content}${calls ? '\n' + calls : ''}`;
  }).join('\n\n');
  return [{ type: 'text', text: transcript }, ...images];
}

export function toolResult(messages: Message[], id: string) {
  const index = messages.findLastIndex(message => message.role === 'tool' && message.tool_call_id === id);
  if (index < 0) throw new Error(`Missing result for tool call ${id}`);
  const message = messages[index]!;
  const text = typeof message.content === 'string' ? message.content : (message.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
  // OpenAI Chat lowering places image tool outputs in synthetic user turns
  // after the matching tool result. Carry their bytes back through MCP.
  const candidates = [...(Array.isArray(message.content) ? message.content : []), ...messages.slice(index + 1).flatMap(message => Array.isArray(message.content) ? message.content : [])];
  const images = candidates.filter((part: any) => part.type === 'image_url').map((part: any) => {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(part.image_url.url);
    if (!match) throw new Error('Tool images must use base64 data URLs');
    return { type: 'image', mimeType: match[1], data: match[2] };
  });
  return { content: [{ type: 'text', text }, ...images] };
}
