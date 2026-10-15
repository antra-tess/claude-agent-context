import { randomUUID } from 'node:crypto';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryParams } from './index.js';
import type { GenerationOptions, GenerationRequest, GenerationResult, GenerationSession } from './generation-types.js';
import { GenerationError } from './errors.js';

export function hasStreamObservers(options: GenerationOptions): boolean {
  return !!(options.onEvent || options.onText || options.onThinking || options.onContentBlock);
}

export async function runGeneration(
  request: GenerationRequest,
  options: GenerationOptions,
  start: (params: QueryParams, session: GenerationSession) => Query,
): Promise<GenerationResult> {
  for (const key of ['timeoutMs', 'firstEventTimeoutMs', 'idleTimeoutMs'] as const) {
    if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key]! <= 0)) throw new Error(`${key} must be a positive integer`);
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) throw new Error('generate() requires at least one message');
  if (hasStreamObservers(options) && options.onGeneration) throw new Error('Final response rewriting cannot be combined with live stream observers');
  if (options.signal?.aborted) throw new GenerationError('Generation aborted', 'abort', { cause: options.signal.reason });
  let resolve!: (result: GenerationResult) => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const result = new Promise<GenerationResult>((yes, no) => { resolve = yes; reject = no; });
  const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
  const marker = `claude-agent-context-${randomUUID()}`;
  const session: GenerationSession = {
    marker, request: structuredClone(request), options, claimed: false, fail,
    succeed(value) { if (!settled) { settled = true; resolve(value); } },
  };
  let query: Query | undefined;
  const abort = () => {
    fail(new GenerationError('Generation aborted', 'abort', { cause: options.signal?.reason }));
    query?.close();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    fail(new GenerationError('Generation total deadline exceeded', 'timeout', { phase: 'total' }));
    query?.close();
  }, options.timeoutMs ?? 600_000);
  timer.unref();
  try {
    query = start({ prompt: marker, options: {
      ...options.sdkOptions,
      model: request.model,
      // Keep the real Claude Code system scaffolding and request construction.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: [], settingSources: [], persistSession: false, maxTurns: 1,
      permissionMode: 'dontAsk',
      // Defense in depth: all tool responses are withheld by the gateway too.
      canUseTool: async () => ({ behavior: 'deny', message: 'Tools are owned by the generation caller' }),
    } }, session);
    const reader = async () => {
      for await (const event of query!) {
        if (event.type === 'result' && event.subtype !== 'success') {
          fail(new GenerationError(`Claude Code generation failed: ${event.subtype}`, 'sdk', { body: event }));
        }
      }
      if (!settled) fail(new GenerationError('Claude Code exited without the requested generation', 'sdk'));
    };
    void reader().catch(fail);
    return await result;
  } catch (error) {
    fail(error);
    return await result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    query?.close();
    await (query as Query & { waitForClose?(): Promise<void> } | undefined)?.waitForClose?.();
  }
}
