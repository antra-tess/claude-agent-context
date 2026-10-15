import type { GenerationRequest } from './generation-types.js';
import type { RequestContext } from './types.js';

export function isGenerationRequest(context: RequestContext, marker: string): boolean {
  return context.messages.some(message => message.role === 'user' && (message.content === marker ||
    (Array.isArray(message.content) && message.content.some(block => block.type === 'text' && block.text === marker))));
}

/** Replace only the sentinel prompt, retaining CLI-injected reminders and unknown wire fields. */
export function mergeGenerationRequest(native: RequestContext, supplied: GenerationRequest, marker: string): RequestContext {
  const context = structuredClone(native);
  let replaced = false;
  context.messages = native.messages.flatMap(message => {
    if (message.role !== 'user') return [structuredClone(message)];
    if (message.content === marker) { replaced = true; return structuredClone(supplied.messages); }
    if (!Array.isArray(message.content)) return [structuredClone(message)];
    const index = message.content.findIndex(block => block.type === 'text' && block.text === marker);
    if (index === -1) return [structuredClone(message)];
    if (replaced) throw new Error('Ambiguous generation sentinel in native request');
    replaced = true;
    const before = message.content.slice(0, index);
    const after = message.content.slice(index + 1);
    return [
      ...(before.length ? [{ ...structuredClone(message), content: structuredClone(before) }] : []),
      ...structuredClone(supplied.messages),
      ...(after.length ? [{ ...structuredClone(message), content: structuredClone(after) }] : []),
    ];
  });
  if (!replaced) throw new Error('Native request did not contain the generation sentinel');
  for (const [key, value] of Object.entries(supplied)) {
    if (value === undefined || key === 'messages' || key === 'system' || key === 'stream') continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && context[key] && typeof context[key] === 'object' && !Array.isArray(context[key])) {
      context[key] = { ...(context[key] as object), ...structuredClone(value) };
    } else context[key] = structuredClone(value);
  }
  if (supplied.system !== undefined) {
    const blocks = (value: RequestContext['system']) => typeof value === 'string' ? [{ type: 'text' as const, text: value }] : value ?? [];
    context.system = [...blocks(native.system), ...structuredClone(blocks(supplied.system))];
  }
  // Use the CLI's native streaming transport regardless of complete()/stream().
  context.stream = native.stream;
  return context;
}
