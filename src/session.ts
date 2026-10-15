import { randomUUID } from 'node:crypto';
import { GenerationError } from './errors.js';
import type { GenerationOptions, GenerationRequest, GenerationResult } from './generation-types.js';

export type SessionMessage = GenerationRequest['messages'][number];
export type HistoryEditor = (messages: SessionMessage[]) =>
  void | SessionMessage[] | Promise<void | SessionMessage[]>;
export type SessionErrorCode = 'closed' | 'busy' | 'conflict' | 'invalid';

export class SessionError extends Error {
  constructor(message: string, readonly code: SessionErrorCode) {
    super(message);
    this.name = 'SessionError';
  }
}

/** JSON-serializable wrapper state. Contains prompts and content, never SDK auth/options. */
export interface SessionSnapshot {
  version: 1;
  sessionId: string;
  /** Opaque compare-and-swap token, changed on every successful write. */
  revision: string;
  /** Request defaults plus the complete, committed wrapper-owned history. */
  request: GenerationRequest;
}

export interface SessionOptions {
  /** Initial history and request defaults; messages default to an empty array. */
  request?: Partial<GenerationRequest>;
  /** Restore saved history/defaults into a new session. Cannot be combined with request. */
  snapshot?: SessionSnapshot;
  /** Runtime-only callbacks, deadlines, and SDK options; excluded from snapshots. */
  generationOptions?: GenerationOptions;
}

export interface ContextSession {
  readonly id: string;
  /** Detached last-committed state, readable during generation and after close. */
  getSnapshot(): SessionSnapshot;
  /** Replace history and defaults only if sessionId/revision still match. Idle only. */
  replaceSnapshot(snapshot: SessionSnapshot): SessionSnapshot;
  /** Edit a detached history; async editors commit only if the revision is unchanged. */
  rewriteHistory(editor: HistoryEditor): Promise<SessionSnapshot>;
  appendMessages(messages: SessionMessage[]): SessionSnapshot;
  /**
   * Append request.messages for this turn; other fields override defaults for this call.
   * Commit new inputs and the final assistant response together on success only.
   * The host executes tools and supplies tool_result messages on the next call.
   */
  generate(request?: Partial<GenerationRequest>, options?: GenerationOptions): Promise<GenerationResult>;
  /** Independent copy of committed history/defaults with new identity/revision. Idle only. */
  fork(): ContextSession;
  /** Cancel this session's generation and wait for cleanup. Does not close the wrapper. */
  close(): Promise<void>;
}

interface SessionOwner {
  generate(request: GenerationRequest, options?: GenerationOptions): Promise<GenerationResult>;
  createSession(options?: SessionOptions): ContextSession;
}

function invalid(message: string): never { throw new SessionError(message, 'invalid'); }

/** Reject non-JSON values rather than silently corrupting a saved conversation. */
function cloneJson<T>(value: T): T {
  const ancestors = new Set<object>();
  function copy(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || ancestors.has(item)) invalid('Session state must contain finite, acyclic JSON values');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      invalid('Session state must contain plain JSON objects');
    }
    if (Object.getOwnPropertySymbols(item).length) invalid('Session state cannot contain symbol keys');
    ancestors.add(item);
    const result = Array.isArray(item) ? Array.from(item, copy) : Object.fromEntries(
      Object.entries(item).filter(([, child]) => child !== undefined).map(([key, child]) => [key, copy(child)]),
    );
    ancestors.delete(item);
    return result;
  }
  return copy(value) as T;
}

function validateHistory(messages: SessionMessage[], requireResults = false): void {
  if (!Array.isArray(messages)) invalid('Session messages must be an array');
  const seen = new Set<string>();
  const pending = new Set<string>();
  for (const message of messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) invalid('Session messages require user or assistant roles');
    if (message.role === 'assistant' && pending.size) invalid('Supply tool results before the next assistant message');
    if (typeof message.content === 'string') {
      if (pending.size) invalid('Supply pending tool results before new text');
      continue;
    }
    if (!Array.isArray(message.content)) invalid('Message content must be text or an array of blocks');
    for (const block of message.content) {
      if (!block || typeof block !== 'object' || typeof block.type !== 'string') invalid('Content blocks require a type');
      if (block.type === 'tool_result') {
        if (message.role !== 'user' || typeof block.tool_use_id !== 'string' || !pending.delete(block.tool_use_id)) {
          invalid('Tool results must match an outstanding tool_use exactly once');
        }
      } else if (message.role === 'user' && pending.size) {
        invalid('Pending tool results must precede other user content');
      } else if (block.type === 'tool_use') {
        if (message.role !== 'assistant' || typeof block.id !== 'string' || !block.id || seen.has(block.id) ||
            typeof block.name !== 'string' || !block.name || !block.input || typeof block.input !== 'object' || Array.isArray(block.input)) {
          invalid('Tool calls require unique IDs, names, and object inputs in assistant messages');
        }
        seen.add(block.id);
        pending.add(block.id);
      } else if (block.type === 'text' && typeof block.text !== 'string') {
        invalid('Text blocks require text');
      }
    }
  }
  if (requireResults && pending.size) invalid('Supply all pending tool results before generating');
}

function cloneRequest(request: GenerationRequest): GenerationRequest {
  const copy = cloneJson(request);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) invalid('Session request must be an object');
  validateHistory(copy.messages);
  return copy;
}

function validateSnapshot(snapshot: SessionSnapshot): void {
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.sessionId !== 'string' || !snapshot.sessionId ||
      typeof snapshot.revision !== 'string' || !snapshot.revision) invalid('Invalid or unsupported session snapshot');
}

function copyOptions(options: GenerationOptions = {}): GenerationOptions {
  return { ...options, ...(options.sdkOptions ? { sdkOptions: {
    ...options.sdkOptions,
    ...(options.sdkOptions.env ? { env: { ...options.sdkOptions.env } } : {}),
    ...(options.sdkOptions.betas ? { betas: [...options.sdkOptions.betas] } : {}),
    ...(options.sdkOptions.executableArgs ? { executableArgs: [...options.sdkOptions.executableArgs] } : {}),
  } } : {}) };
}

export function createContextSession(owner: SessionOwner, options: SessionOptions, onClose: () => void): ContextSession {
  if (options.snapshot !== undefined && options.request !== undefined) invalid('Use either snapshot or request to create a session');
  if (options.snapshot !== undefined) validateSnapshot(options.snapshot);
  let request = cloneRequest(options.snapshot !== undefined ? options.snapshot.request : {
    ...options.request, messages: options.request?.messages ?? [],
  });
  const defaults = copyOptions(options.generationOptions);
  const id = randomUUID();
  let revision = randomUUID();
  let closed = false;
  let active: AbortController | undefined;
  let pending: Promise<GenerationResult> | undefined;
  let closing: Promise<void> | undefined;

  function assertIdle(): void {
    if (closed) throw new SessionError('Session is closed', 'closed');
    if (active) throw new SessionError('Session is busy generating; wait for it to finish before changing history', 'busy');
  }
  function commit(next: GenerationRequest): SessionSnapshot {
    request = cloneRequest(next);
    revision = randomUUID();
    return session.getSnapshot();
  }

  const session: ContextSession = {
    id,
    getSnapshot() { return { version: 1, sessionId: id, revision, request: structuredClone(request) }; },
    replaceSnapshot(snapshot) {
      assertIdle();
      validateSnapshot(snapshot);
      if (snapshot.sessionId !== id || snapshot.revision !== revision) {
        throw new SessionError('Session changed since this snapshot was read, or snapshot belongs to another session', 'conflict');
      }
      return commit(snapshot.request);
    },
    async rewriteHistory(editor) {
      assertIdle();
      const snapshot = session.getSnapshot();
      const replacement = await editor(snapshot.request.messages);
      if (replacement !== undefined) snapshot.request.messages = replacement;
      return session.replaceSnapshot(snapshot);
    },
    appendMessages(messages) {
      assertIdle();
      if (!Array.isArray(messages)) invalid('appendMessages requires an array');
      return commit({ ...request, messages: [...request.messages, ...messages] });
    },
    async generate(overrides = {}, settings = {}) {
      assertIdle();
      const inputs = overrides.messages ?? [];
      if (!Array.isArray(inputs)) invalid('Generation messages must be an array');
      const next = cloneRequest({ ...request, messages: [...request.messages, ...inputs] });
      const outgoing = cloneRequest({ ...next, ...overrides, messages: next.messages });
      validateHistory(outgoing.messages, true);
      const runtime = copyOptions({ ...defaults, ...settings,
        sdkOptions: { ...defaults.sdkOptions, ...settings.sdkOptions },
      });
      const controller = new AbortController();
      const abort = () => controller.abort(runtime.signal?.reason);
      runtime.signal?.addEventListener('abort', abort, { once: true });
      if (runtime.signal?.aborted) abort();
      const checkAbort = () => {
        if (controller.signal.aborted) throw new GenerationError('Session generation aborted', 'abort', { cause: controller.signal.reason });
      };
      active = controller;
      const operation = Promise.resolve().then(() => {
        checkAbort();
        return owner.generate(outgoing, { ...runtime, signal: controller.signal });
      }).then(result => {
        checkAbort();
        // Keep the caller's logical history, not CLI scaffolding or temporary
        // beforeRequest edits. The final (possibly rewritten) response is retained.
        commit({ ...next, messages: [...next.messages, {
          role: 'assistant', content: result.message.content as SessionMessage['content'],
        }] });
        return result;
      }).finally(() => {
        runtime.signal?.removeEventListener('abort', abort);
        active = undefined;
        pending = undefined;
      });
      pending = operation;
      return operation;
    },
    fork() {
      assertIdle();
      return owner.createSession({ snapshot: session.getSnapshot(), generationOptions: defaults });
    },
    close() {
      if (!closing) {
        closed = true;
        active?.abort(new Error('Session closed'));
        onClose();
        closing = pending ? pending.then(() => {}, () => {}) : Promise.resolve();
      }
      return closing;
    },
  };
  return session;
}
