import type { BetaMessage as Message, MessageCreateParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** Fully assembled Messages API payload, including system, tools, and history. */
export type RequestContext = MessageCreateParams & Record<string, unknown>;
export type GenerationMessage = Message;

/** Claude Code's internal transcript entry, including its UUID and metadata. */
export interface TranscriptMessage {
  type: string;
  uuid: string;
  message?: {
    role?: string;
    content: string | Record<string, unknown>[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TranscriptSnapshot {
  /** SHA-256 of the live transcript; used for an atomic compare-and-swap write. */
  revision: string;
  messages: TranscriptMessage[];
}

export type TranscriptEditor = (messages: TranscriptMessage[]) =>
  void | TranscriptMessage[] | Promise<void | TranscriptMessage[]>;

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
  /**
   * Opt in to patching a private native CLI copy for live transcript access.
   * Currently pinned to SDK 0.3.283 on macOS arm64. Installed binaries are untouched.
   */
  enableTranscriptEditing?: boolean;
  /** Override ANTHROPIC_BASE_URL. Defaults to the query env or api.anthropic.com. */
  upstreamUrl?: string;
  /** Timeout for each callback (not generation time). Default: 30 seconds. */
  callbackTimeoutMs?: number;
  /** Maximum buffered request/response size (including rewrite-mode SSE). Default: 32 MiB. */
  maxBodyBytes?: number;
}
