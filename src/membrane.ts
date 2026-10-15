import { MembraneError, type ProviderAdapter, type ProviderRequest, type ProviderRequestOptions, type ProviderResponse, type StreamCallbacks } from '@animalabs/membrane';
import { createClaudeAgentSdk, type ContextAgentSdk } from './index.js';
import { GenerationError } from './errors.js';
import type { GenerationOptions, GenerationRequest } from './generation-types.js';
import type { WrapperOptions } from './types.js';

export interface ClaudeAgentSdkAdapterConfig extends WrapperOptions {
  sdkOptions?: GenerationOptions['sdkOptions'];
  /** Optional shared client. Its lifecycle remains the caller's responsibility. */
  client?: ContextAgentSdk;
}

/** Membrane owns history, tool execution, and retries. Claude Code supplies transport/auth. */
export class ClaudeAgentSdkAdapter implements ProviderAdapter {
  readonly name = 'claude-agent-sdk';
  private client?: Promise<ContextAgentSdk>;
  private closed = false;
  private active = new Set<AbortController>();

  constructor(private readonly config: ClaudeAgentSdkAdapterConfig = {}) {}

  supportsModel(modelId: string): boolean {
    return /^(?:claude-agent\/)?claude-/.test(modelId);
  }

  complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.run(request, undefined, options);
  }

  stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.run(request, callbacks, options);
  }

  private async run(request: ProviderRequest, callbacks?: StreamCallbacks, options: ProviderRequestOptions = {}): Promise<ProviderResponse> {
    if (this.closed) throw new Error('ClaudeAgentSdkAdapter is closed');
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    let rawRequest: unknown;
    let thinkingOpen = false;
    const closeThinking = () => {
      if (thinkingOpen) { callbacks?.onChunk('</thinking>\n'); thinkingOpen = false; }
    };
    try {
      if (!this.client) this.client = this.config.client ? Promise.resolve(this.config.client) : createClaudeAgentSdk(this.config);
      const client = await this.client;
      const generationRequest = {
        ...request.extra,
        model: request.model.replace(/^claude-agent\//, ''), messages: request.messages,
        system: request.system, tools: request.tools ?? [], max_tokens: request.maxTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.topK !== undefined ? { top_k: request.topK } : {}),
        ...(request.stopSequences !== undefined ? { stop_sequences: request.stopSequences } : {}),
        ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
      } as GenerationRequest;
      const result = await client.generate(generationRequest, {
        sdkOptions: this.config.sdkOptions,
        signal: controller.signal, timeoutMs: options.timeoutMs,
        firstEventTimeoutMs: options.firstEventTimeoutMs, idleTimeoutMs: options.idleTimeoutMs,
        onRequest(value) { rawRequest = value; options.onRequest?.(value); },
        ...(callbacks ? {
          onText(text: string) { closeThinking(); callbacks.onChunk(text); },
          onThinking(text: string) {
            if (options.wrapThinkingTags && !thinkingOpen) { callbacks.onChunk('<thinking>'); thinkingOpen = true; }
            callbacks.onChunk(text);
          },
          onEvent(event: Record<string, any>) {
            if (event.type === 'content_block_start') callbacks.onContentBlock?.(event.index, event.content_block);
            if (event.type === 'content_block_stop') closeThinking();
          },
          onContentBlock(index: number, block: unknown) { callbacks.onContentBlock?.(index, block); },
        } : {}),
      });
      closeThinking();
      const message = result.message;
      return {
        content: message.content, stopReason: message.stop_reason ?? 'end_turn',
        stopSequence: message.stop_sequence ?? undefined, model: message.model,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens,
          cacheCreationTokens: message.usage.cache_creation_input_tokens ?? undefined,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? undefined },
        rawRequest: result.request, raw: message,
      };
    } catch (error) {
      if (error instanceof MembraneError) throw error;
      const typed = error instanceof GenerationError ? error : undefined;
      const status = typed?.status;
      const type = typed?.kind === 'abort' || controller.signal.aborted ? 'abort'
        : typed?.kind === 'timeout' ? 'timeout'
        : typed?.kind === 'network' ? 'network'
        : status === 429 ? 'rate_limit'
        : status === 401 || status === 403 ? 'auth'
        : status === 400 && /context|too long/i.test(typed!.message) ? 'context_length'
        : status !== undefined && status >= 500 ? 'server'
        : status !== undefined && status >= 400 ? 'invalid_request' : 'unknown';
      throw new MembraneError({ type, message: error instanceof Error ? error.message : String(error),
        retryable: type !== 'abort' && (typed?.retryable ?? false), httpStatus: status,
        providerErrorCode: typed?.code, retryAfterMs: typed?.retryAfterMs,
        rawError: error, rawRequest: typed?.details.request ?? rawRequest,
      });
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.active.delete(controller);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active) controller.abort(new Error('Adapter closed'));
    if (this.client && !this.config.client) await (await this.client).close();
  }
}
