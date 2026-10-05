import { countTokens } from 'gpt-tokenizer';
// Kiro 2.x ACP does not expose exact native token counts. These BPE estimates
// support OpenCode's context accounting; they are not billing measurements.
export function estimatedUsage(messages: unknown, tools: unknown, output: string) {
  const input = JSON.stringify({ messages, tools }, (key, value) => ['image_url', 'file_data'].includes(key) ? '[attachment]' : value);
  const options = { disallowedSpecial: new Set<string>() };
  const prompt_tokens = countTokens(input, options);
  const completion_tokens = countTokens(output, options);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}
