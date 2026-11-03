import { appendFileSync } from 'node:fs';
// Opt-in diagnostics: KIRO_OPENCODE_DEBUG=/path/to/file.jsonl. Records timings,
// message roles/sizes/hashes and Kiro credit metering, never message content.
const path = process.env.KIRO_OPENCODE_DEBUG;
export const debugEnabled = Boolean(path);
export function debug(event: string, data: Record<string, unknown> = {}) {
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), event, ...data }) + '\n'); } catch {}
}
export function shape(messages: any[] = []) {
  return messages.map(message => {
    const text = JSON.stringify(message);
    return `${message.role}${message.tool_calls ? '+calls' : ''}:${text.length}:${Bun.hash(text).toString(36).slice(0, 6)}`;
  });
}
