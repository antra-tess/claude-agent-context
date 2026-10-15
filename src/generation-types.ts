import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { GenerationMessage, RequestContext, RequestInfo } from './types.js';

/** Only supplied fields override CLI defaults. Native system text is retained and appended to. */
export type GenerationRequest = Partial<RequestContext> & { messages: RequestContext['messages'] };

export interface GenerationResult {
  message: GenerationMessage;
  request: RequestContext;
  requestId: string;
  /** Upstream response headers; request authentication headers are never exposed. */
  responseHeaders: Record<string, string>;
}

export interface GenerationOptions {
  signal?: AbortSignal;
  /** Overall deadline, including CLI startup. Default: 10 minutes. */
  timeoutMs?: number;
  /** Deadline from API dispatch to the first SSE event/JSON body. Default: 10 minutes. */
  firstEventTimeoutMs?: number;
  /** Maximum interval between SSE events, including ping. Default: 2 minutes. */
  idleTimeoutMs?: number;
  onRequest?: (request: RequestContext, info: RequestInfo) => void | Promise<void>;
  /** Raw API events reach the host live. They are never delivered to Claude Code. */
  onEvent?: (event: Record<string, any>) => void | Promise<void>;
  onText?: (text: string) => void | Promise<void>;
  onThinking?: (text: string) => void | Promise<void>;
  onContentBlock?: (index: number, block: GenerationMessage['content'][number]) => void | Promise<void>;
  /**
   * Optional final rewrite. With stream callbacks configured this is rejected:
   * already emitted host tokens cannot be retracted. Use buffered generation instead.
   */
  onGeneration?: (message: GenerationMessage) => void | GenerationMessage | Promise<void | GenerationMessage>;
  /** Local SDK environment/auth, cwd, model options. Agent behavior is locked down by generate(). */
  sdkOptions?: Pick<Options, 'env' | 'cwd' | 'stderr' | 'pathToClaudeCodeExecutable' | 'executable' | 'executableArgs' | 'betas'>;
}

/** Private per-query gateway state; never exposed to an SDK subprocess. */
export interface GenerationSession {
  marker: string;
  request: GenerationRequest;
  options: GenerationOptions;
  claimed: boolean;
  succeed(result: GenerationResult): void;
  fail(error: unknown): void;
}
