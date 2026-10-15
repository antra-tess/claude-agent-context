import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Query, query } from '@anthropic-ai/claude-agent-sdk';

export const message = {
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'hello 🌍' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};
export function streamEvents(text = 'hello 🌍') {
  return [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } },
    { type: 'ping' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
}
export function sse(events = streamEvents(), newline = '\r\n') {
  return events.map(e => `event: ${e.type}${newline}data: ${JSON.stringify(e)}${newline}${newline}`).join('');
}
export async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(error => res.destroy(error)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
export async function body(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

/** SDK-shaped fixture still makes real HTTP requests through the interception boundary. */
export function fakeSdk(options: { stream?: boolean; turns?: number; path?: string } = {}) {
  const calls: Parameters<typeof query>[0][] = [];
  let closes = 0;
  const sdk = {
    query(params: Parameters<typeof query>[0]): Query {
      calls.push(params);
      const generator = (async function* () {
        for (let turn = 0; turn < (options.turns ?? 1); turn++) {
          const response = await fetch(`${params.options!.env!.ANTHROPIC_BASE_URL}${options.path ?? '/v1/messages?beta=true'}`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-secret' },
            body: JSON.stringify({ model: 'test', system: 'original', messages: [{ role: 'user', content: params.prompt }], stream: options.stream ?? false }),
          });
          const text = await response.text();
          if (!response.ok) throw new Error(text);
          yield { type: 'fixture', text } as any;
        }
      })();
      return Object.assign(generator, {
        close() { closes++; },
        async supportedModels() { if (this !== generator) throw new Error('lost receiver'); return []; },
      }) as unknown as Query;
    },
  };
  return { sdk, calls, get closes() { return closes; } };
}
