import type { BetaMessage as Message, MessageCreateParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** Fully assembled Messages API payload, including system, tools, and history. */
export type RequestContext = MessageCreateParams & Record<string, unknown>;
export type GenerationMessage = Message;

export interface RequestInfo {
  queryId: string;
  requestId: string;
  /** Monotonic per query; includes retries and auxiliary model requests. */
  sequence: number;
  url: string;
  signal: AbortSignal;
}

export interface CompletedGeneration extends RequestInfo {
  /** Snapshot of the payload actually sent, after beforeRequest. */
  request: RequestContext;
  message: Message;
}

export interface ContextCallbacks {
  /** Mutate in place and return void, or return a replacement payload. */
  beforeRequest?: (
    context: RequestContext,
    info: RequestInfo,
  ) => void | RequestContext | Promise<void | RequestContext>;
  /**
   * Mutate generation.message in place or return a replacement. The edited
   * response is delivered to the CLI and retained in its conversation history.
   * Configuring this callback buffers each generation until it completes.
   */
  onGeneration?: (generation: CompletedGeneration) => void | Message | Promise<void | Message>;
}

export interface WrapperOptions extends ContextCallbacks {
  /** Override ANTHROPIC_BASE_URL. Defaults to the query env or api.anthropic.com. */
  upstreamUrl?: string;
  /** Timeout for each callback (not generation time). Default: 30 seconds. */
  callbackTimeoutMs?: number;
  /** Maximum buffered request/response size (including rewrite-mode SSE). Default: 32 MiB. */
  maxBodyBytes?: number;
}
