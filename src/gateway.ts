import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { BetaMessage as Message } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ContextCallbacks, RequestContext, RequestInfo, WrapperOptions } from './types.js';
import { MessageDecoder } from './sse.js';
import { encodeMessage, validateMessage } from './response.js';
import type { GenerationSession } from './generation-types.js';
import { isGenerationRequest, mergeGenerationRequest } from './request-merge.js';
import { apiError, GenerationError } from './errors.js';

export interface Session extends ContextCallbacks {
  id: string;
  upstream: URL;
  sequence: number;
  controllers: Set<AbortController>;
  generation?: GenerationSession;
  fail(error: unknown): void;
}

function inertMessage(): Message {
  return { id: 'msg_context_transport', type: 'message', role: 'assistant', model: 'transport',
    content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as Message;
}

const hopHeaders = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

function cleanHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of (headers.get('connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim());
  for (const name of hopHeaders) headers.delete(name);
  return headers;
}

async function readBody(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error(`API body exceeds ${limit} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function callback<T>(run: () => T | Promise<T>, signal: AbortSignal, timeout: number): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error(`Context callback exceeded ${timeout}ms`)), timeout);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function createGateway(options: WrapperOptions) {
  const sessions = new Map<string, Session>();
  const maxBody = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const timeout = options.callbackTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(maxBody) || maxBody <= 0 || !Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error('maxBodyBytes and callbackTimeoutMs must be positive integers');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const incoming = new URL(req.url ?? '/', 'http://localhost');
    const [, token] = incoming.pathname.split('/');
    const session = sessions.get(token);
    if (!session) { res.writeHead(404).end(); return; }
    const controller = new AbortController();
    session.controllers.add(controller);
    const abort = () => controller.abort(new Error('API connection closed'));
    req.once('aborted', abort);
    res.once('close', abort);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, phase: 'first-event' | 'idle') => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => session.fail(new GenerationError(`Generation ${phase} deadline exceeded`, 'timeout', { phase })), ms);
      watchdog.unref();
    };
    try {
      const path = incoming.pathname.slice(token.length + 1);
      const url = new URL(session.upstream.href);
      url.pathname = url.pathname.replace(/\/$/, '') + path;
      url.search = incoming.search;
      const intercepted = req.method === 'POST' && /^\/v1\/messages\/?$/.test(path);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach(v => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const outgoingHeaders = cleanHeaders(headers);
      let body = await readBody(req, maxBody);
      let context: RequestContext | undefined;
      let info: RequestInfo | undefined;
      if (intercepted) {
        if (headers.get('content-encoding') && headers.get('content-encoding') !== 'identity') {
          throw new Error('Compressed API request bodies are not supported');
        }
        context = JSON.parse(body.toString('utf8'));
        if (session.generation) {
          const generation = session.generation;
          if (generation.claimed || !isGenerationRequest(context!, generation.marker)) {
            // Auxiliary calls and SDK retries never reach the upstream. The real
            // generation is owned by the host; the CLI only sees inert content.
            res.writeHead(200, { 'content-type': context?.stream ? 'text/event-stream' : 'application/json' });
            res.end(context?.stream ? encodeMessage(inertMessage()) : JSON.stringify(inertMessage()));
            return;
          }
          generation.claimed = true;
          context = mergeGenerationRequest(context!, generation.request, generation.marker);
        }
        info = {
          queryId: session.id, requestId: randomUUID(), sequence: ++session.sequence,
          url: url.href, signal: controller.signal,
        };
        const replacement = session.beforeRequest && await callback(
          () => session.beforeRequest!(context!, info!), controller.signal, timeout,
        );
        if (replacement !== undefined) context = replacement;
        if (!context || !Array.isArray(context.messages) || typeof context.model !== 'string') {
          throw new Error('beforeRequest must preserve a Messages payload with model and messages');
        }
        body = Buffer.from(JSON.stringify(context));
        if (body.length > maxBody) throw new Error(`Modified API body exceeds ${maxBody} bytes`);
        // Isolate the sent payload from references retained by the callback.
        context = JSON.parse(body.toString('utf8'));
        outgoingHeaders.set('content-type', 'application/json');
        if (session.generation?.options.onRequest) await callback(
          () => session.generation!.options.onRequest!(structuredClone(context!), info!), controller.signal, timeout,
        );
        if (session.generation) arm(session.generation.options.firstEventTimeoutMs ?? 600_000, 'first-event');
      }
      const response = await fetch(url, {
        method: req.method,
        headers: outgoingHeaders,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(body),
        signal: controller.signal,
        redirect: 'manual',
      }).catch(error => {
        if (session.generation && !controller.signal.aborted) throw new GenerationError('Messages API connection failed', 'network', { cause: error, request: context });
        throw error;
      });
      if (intercepted && response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('Messages API redirects are unsupported; configure the canonical upstreamUrl');
      }
      const responseHeaders = cleanHeaders(response.headers);
      // Node fetch decompresses upstream bodies automatically.
      responseHeaders.delete('content-encoding');
      if (session.generation && intercepted) {
        const responseHeaderRecord = Object.fromEntries(response.headers);
        if (!response.ok) {
          const bytes = response.body ? await readBody(response.body as unknown as AsyncIterable<Uint8Array>, maxBody) : Buffer.alloc(0);
          let errorBody: unknown;
          try { errorBody = JSON.parse(bytes.toString()); } catch { errorBody = { message: bytes.toString() }; }
          throw apiError(errorBody, response.status, responseHeaderRecord, context);
        }
        let message: Message | undefined;
        const settings = session.generation.options;
        const hostCallback = async <T>(run: () => T | Promise<T>): Promise<T> => {
          try { return await callback(run, controller.signal, timeout); }
          catch (error) { throw new GenerationError('Generation callback failed', 'callback', { cause: error, request: context }); }
        };
        const observe = async (event: Record<string, any>, block?: Record<string, any>) => {
          arm(settings.idleTimeoutMs ?? 120_000, 'idle');
          await hostCallback(async () => {
            await settings.onEvent?.(event);
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') await settings.onText?.(event.delta.text);
            if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') await settings.onThinking?.(event.delta.thinking);
            if (block) await settings.onContentBlock?.(event.index, block as Message['content'][number]);
          });
        };
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const decoder = new MessageDecoder(async value => { message = value; }, observe);
          let size = 0;
          try {
            if (response.body) for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
              size += bytes.length;
              if (size > maxBody) throw new GenerationError(`Generation response exceeds ${maxBody} bytes`, 'protocol');
              await decoder.push(bytes);
            }
            await decoder.finish();
          } catch (error) {
            if (error instanceof GenerationError && error.kind === 'api') throw apiError(error.details.body, error.status, responseHeaderRecord, context);
            if (error instanceof GenerationError || controller.signal.aborted) throw error;
            throw new GenerationError(error instanceof Error ? error.message : String(error),
              error instanceof TypeError || (error instanceof Error && /without message_stop/.test(error.message)) ? 'network' : 'protocol',
              { cause: error, request: context, headers: responseHeaderRecord });
          }
        } else {
          const bytes = response.body ? await readBody(response.body as unknown as AsyncIterable<Uint8Array>, maxBody) : Buffer.alloc(0);
          message = JSON.parse(bytes.toString());
          arm(settings.idleTimeoutMs ?? 120_000, 'idle');
          validateMessage(message);
          await hostCallback(async () => {
            for (const [index, block] of message!.content.entries()) {
              if (block.type === 'text') await settings.onText?.(block.text);
              if (block.type === 'thinking') await settings.onThinking?.(block.thinking);
              await settings.onContentBlock?.(index, structuredClone(block));
            }
          });
        }
        clearTimeout(watchdog);
        validateMessage(message);
        const generation = { ...info!, request: structuredClone(context!), message };
        if (session.onGeneration) {
          const replacement = await hostCallback(() => session.onGeneration!(generation));
          if (replacement !== undefined) generation.message = replacement;
        }
        if (settings.onGeneration) {
          const replacement = await hostCallback(() => settings.onGeneration!(generation.message));
          if (replacement !== undefined) generation.message = replacement;
        }
        validateMessage(generation.message);
        // Only the host sees the actual response. Never give tool blocks to the CLI.
        res.writeHead(200, { 'content-type': context?.stream ? 'text/event-stream' : 'application/json' });
        res.end(context?.stream ? encodeMessage(inertMessage()) : JSON.stringify(inertMessage()));
        session.generation.succeed({ message: structuredClone(generation.message), request: context!, requestId: info!.requestId, responseHeaders: responseHeaderRecord });
        return;
      }
      const finish = async (message: Message): Promise<Message> => {
        const generation = { ...info!, request: structuredClone(context!), message };
        if (session.onGeneration) {
          const replacement = await callback(
            () => session.onGeneration!(generation), controller.signal, timeout,
          );
          if (replacement !== undefined) generation.message = replacement;
        }
        validateMessage(generation.message);
        // Detach references retained by the callback before serializing/storing.
        return structuredClone(generation.message);
      };
      const isMessage = intercepted && response.ok;
      const isStream = response.headers.get('content-type')?.includes('text/event-stream');
      if (isMessage && !isStream) {
        const bytes = response.body ? await readBody(response.body as unknown as AsyncIterable<Uint8Array>, maxBody) : Buffer.alloc(0);
        const message = JSON.parse(bytes.toString('utf8')) as Message;
        validateMessage(message);
        const rewritten = Buffer.from(JSON.stringify(await finish(message)));
        if (rewritten.length > maxBody) throw new Error(`Modified API response exceeds ${maxBody} bytes`);
        responseHeaders.delete('etag');
        responseHeaders.delete('content-md5');
        res.writeHead(response.status, Object.fromEntries(responseHeaders));
        res.end(rewritten);
      } else if (isMessage && isStream && session.onGeneration) {
        // Never expose original text or tool blocks: the CLI can execute a tool
        // as soon as its block ends, well before message_stop.
        const bytes = response.body ? await readBody(response.body as unknown as AsyncIterable<Uint8Array>, maxBody) : Buffer.alloc(0);
        let message: Message | undefined;
        const decoder = new MessageDecoder(async value => { message = value; });
        await decoder.push(bytes);
        await decoder.finish();
        const original = JSON.stringify(message);
        const rewritten = await finish(message!);
        const outgoing = JSON.stringify(rewritten) === original ? bytes : encodeMessage(rewritten);
        if (outgoing.length > maxBody) throw new Error(`Modified API response exceeds ${maxBody} bytes`);
        responseHeaders.delete('etag');
        responseHeaders.delete('content-md5');
        res.writeHead(response.status, Object.fromEntries(responseHeaders));
        res.end(outgoing);
      } else {
        res.writeHead(response.status, Object.fromEntries(responseHeaders));
        const decoder = isMessage && isStream ? new MessageDecoder(async message => { await finish(message); }) : undefined;
        if (response.body) {
          for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
            await decoder?.push(bytes);
            if (!res.write(bytes)) await once(res, 'drain', { signal: controller.signal });
          }
        }
        await decoder?.finish();
        res.end();
      }
    } catch (error) {
      // Disconnections are cancellations; callback/parser/transport failures fail the query.
      if (!controller.signal.aborted || (error !== controller.signal.reason && !(error instanceof Error && error.name === 'AbortError'))) session.fail(error);
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Context interceptor failed' } }));
      } else res.destroy();
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      session.controllers.delete(controller);
      req.off('aborted', abort);
      res.off('close', abort);
    }
  }

  const server = createServer((req, res) => { void handle(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    add(session: Session): string {
      const token = randomUUID();
      sessions.set(token, session);
      return `${address}/${token}`;
    },
    remove(session: Session): void {
      for (const [token, value] of sessions) if (value === session) sessions.delete(token);
      for (const controller of session.controllers) controller.abort();
    },
    async close(): Promise<void> {
      for (const session of sessions.values()) for (const controller of session.controllers) controller.abort();
      sessions.clear();
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
