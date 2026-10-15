import type * as sdk from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { createGateway, type Session } from './gateway.js';
import type { ContextCallbacks, WrapperOptions } from './types.js';
import { createContextSession, type ContextSession, type SessionOptions } from './session.js';
import type { GenerationOptions, GenerationRequest, GenerationResult, GenerationSession } from './generation-types.js';
import { hasStreamObservers, runGeneration } from './generation.js';
import { GenerationError } from './errors.js';

export { GenerationError } from './errors.js';
export type { GenerationErrorKind } from './errors.js';
export type { GenerationOptions, GenerationRequest, GenerationResult } from './generation-types.js';
export { SessionError } from './session.js';
export type { ContextSession, SessionOptions, SessionSnapshot, SessionMessage, HistoryEditor, SessionErrorCode } from './session.js';

export type {
  RequestContext, RequestInfo, CompletedGeneration, GenerationMessage, ContextCallbacks,
  WrapperOptions,
} from './types.js';
export type QueryParams = Parameters<typeof sdk.query>[0] & { callbacks?: ContextCallbacks };
const GENERATION = Symbol('generation');
type InternalQueryParams = QueryParams & { [GENERATION]?: GenerationSession };

export interface ContextQuery extends sdk.Query {
  /** Wait for the owned CLI to exit after close()/iterator completion. */
  waitForClose(): Promise<void>;
}

export interface ContextAgentSdk {
  query(params: QueryParams): ContextQuery;
  /** Exactly one upstream generation; native CLI tools never execute. No internal retries. */
  generate(request: GenerationRequest, options?: GenerationOptions): Promise<GenerationResult>;
  /** Create editable wrapper-owned history. Each generation uses a fresh SDK query. */
  createSession(options?: SessionOptions): ContextSession;
  /** Closes all owned queries and the local interceptor. Always call in finally. */
  close(): Promise<void>;
}

/** Wrap the default SDK. Initialization binds a loopback listener; query stays synchronous. */
export async function createClaudeAgentSdk(options: WrapperOptions = {}): Promise<ContextAgentSdk> {
  return wrapAgentSdk(await import('@anthropic-ai/claude-agent-sdk'), options);
}

/** Wrap an SDK entry point (root OR /core). Does not mutate global SDK state. */
export async function wrapAgentSdk(
  original: Pick<typeof sdk, 'query'>,
  options: WrapperOptions = {},
): Promise<ContextAgentSdk> {
  if ('enableTranscriptEditing' in options) {
    throw new Error('enableTranscriptEditing was removed; use createSession() for wrapper-managed history');
  }
  const originalQuery = original.query.bind(original);
  const gateway = await createGateway(options);
  const active = new Set<() => void>();
  const sessions = new Set<ContextSession>();
  const closingQueries = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const client: ContextAgentSdk = {
    createSession(settings = {}) {
      if (closed) throw new Error('Context SDK wrapper is closed');
      const session = createContextSession(client, settings, () => sessions.delete(session));
      sessions.add(session);
      return session;
    },
    generate(request, settings = {}) {
      if (closed) return Promise.reject(new Error('Context SDK wrapper is closed'));
      if (options.onGeneration && hasStreamObservers(settings)) return Promise.reject(new Error('Wrapper onGeneration rewriting cannot be combined with live stream observers'));
      return runGeneration(request, settings, (params, session) => client.query({ ...params, [GENERATION]: session } as InternalQueryParams));
    },
    query({ callbacks, [GENERATION]: generation, ...params }: InternalQueryParams): ContextQuery {
      if (closed) throw new Error('Context SDK wrapper is closed');
      const env = { ...(params.options?.env ?? process.env) };
      for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
        if (env[key] && env[key] !== '0' && env[key] !== 'false') {
          throw new Error(`${key} is unsupported: interception requires the Anthropic Messages API transport`);
        }
      }
      if (params.options?.spawnClaudeCodeProcess) {
        throw new Error('Custom spawnClaudeCodeProcess is unsupported: the interceptor requires a local CLI');
      }
      const upstream = new URL(options.upstreamUrl ?? env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');
      if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
        throw new Error('upstreamUrl must be an HTTP(S) base URL without credentials, query, or fragment');
      }
      let underlying: sdk.Query | undefined;
      let failure: unknown;
      let failed = false;
      let released = false;
      let exited: Promise<void> | undefined;
      const session: Session = {
        ...options, ...callbacks, generation, id: randomUUID(), upstream, sequence: 0, controllers: new Set(),
        fail(error) { if (!failed) { failed = true; failure = error; } generation?.fail(error); release(); },
      };
      function release() {
        if (released) return;
        released = true;
        generation?.fail(new GenerationError('Generation query closed', 'abort'));
        gateway.remove(session);
        active.delete(release);
        underlying?.close();
        // Query.close() initiates a graceful shutdown; it does not await child
        // exit. Retain the SDK transport's exit promise for lifecycle cleanup.
        const transport = (underlying as unknown as { transport?: { waitForExit?(): Promise<void> } })?.transport;
        exited = (transport?.waitForExit?.() ?? Promise.resolve()).catch(() => {});
        closingQueries.add(exited);
        void exited.then(() => closingQueries.delete(exited!));
      }
      env.ANTHROPIC_BASE_URL = gateway.add(session);
      // Proxy variables must not divert the CLI's loopback connection.
      env.NO_PROXY = [env.NO_PROXY, env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
      env.no_proxy = env.NO_PROXY;
      active.add(release);
      try { underlying = originalQuery({ ...params, options: { ...params.options, env } }); }
      catch (error) { generation?.fail(error); release(); throw error; }

      const query = underlying;
      const proxy = new Proxy(query, {
        get(target, property) {
          if (property === 'waitForClose') return () => exited ?? Promise.resolve();
          if (property === Symbol.asyncIterator) return () => proxy;
          if (property === 'close') return release;
          if (property === Symbol.asyncDispose) return async () => release();
          if (property === 'next' || property === 'return' || property === 'throw') {
            return async (...args: unknown[]) => {
              if (failed) throw failure;
              try {
                const result = await (target[property] as Function).apply(target, args);
                if (failed) throw failure;
                if (result.done) release();
                return result;
              } catch (error) { release(); throw failed ? failure : error; }
              finally { if (property !== 'next') release(); }
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return proxy as ContextQuery;
    },
    close() {
      if (!closing) {
        closed = true;
        const sessionClosures = [...sessions].map(session => session.close());
        for (const release of active) release();
        closing = Promise.all([gateway.close(), ...sessionClosures])
          .then(() => Promise.all([...closingQueries])).then(() => {});
      }
      return closing;
    },
  };
  return client;
}

/**
 * Monkeypatch a mutable SDK facade's query function. Native ESM namespace imports
 * are read-only: use wrapAgentSdk() for those. Restore also closes owned queries.
 */
export async function monkeypatchAgentSdk(
  target: Pick<typeof sdk, 'query'>,
  options: WrapperOptions = {},
): Promise<() => Promise<void>> {
  const previous = target.query;
  const wrapper = await wrapAgentSdk(target, options);
  try { target.query = wrapper.query; }
  catch (error) { await wrapper.close(); throw new Error('SDK namespace is read-only; use wrapAgentSdk(sdk, callbacks)', { cause: error }); }
  return async () => {
    try { if (target.query === wrapper.query) target.query = previous; }
    finally { await wrapper.close(); }
  };
}
