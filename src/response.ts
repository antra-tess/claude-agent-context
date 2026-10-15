import type { GenerationMessage } from './types.js';

export function validateMessage(value: unknown): asserts value is GenerationMessage {
  const message = value as GenerationMessage | undefined;
  if (!message || message.type !== 'message' || message.role !== 'assistant'
    || typeof message.id !== 'string' || typeof message.model !== 'string'
    || !Array.isArray(message.content) || !message.usage
    || typeof message.usage.input_tokens !== 'number' || typeof message.usage.output_tokens !== 'number'
    || message.content.some(block => !block || typeof block.type !== 'string')) {
    throw new Error('onGeneration must preserve a valid assistant Message envelope');
  }
}

/** Emit a complete replacement as ordinary API SSE, before the CLI sees any blocks. */
export function encodeMessage(message: GenerationMessage): Buffer {
  const events: Record<string, unknown>[] = [];
  events.push({ type: 'message_start', message: {
    ...message, content: [], stop_reason: null, stop_sequence: null,
    usage: { ...message.usage, output_tokens: 0 },
  } });
  message.content.forEach((block, index) => {
    let start: Record<string, unknown> = { ...block };
    const deltas: Record<string, unknown>[] = [];
    if (block.type === 'text') {
      start = { ...start, text: '' };
      if (block.citations) start.citations = [];
      deltas.push({ type: 'text_delta', text: block.text });
      for (const citation of block.citations ?? []) deltas.push({ type: 'citations_delta', citation });
    } else if (block.type === 'thinking') {
      start = { ...start, thinking: '', signature: '' };
      deltas.push({ type: 'thinking_delta', thinking: block.thinking });
      deltas.push({ type: 'signature_delta', signature: block.signature });
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
      start = { ...start, input: {} };
      deltas.push({ type: 'input_json_delta', partial_json: JSON.stringify(block.input) });
    }
    events.push({ type: 'content_block_start', index, content_block: start });
    for (const delta of deltas) events.push({ type: 'content_block_delta', index, delta });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: {
    stop_reason: message.stop_reason, stop_sequence: message.stop_sequence,
  }, usage: message.usage });
  events.push({ type: 'message_stop' });
  return Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
