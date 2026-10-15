import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapAgentSdk, GenerationError } from '../src/index.js';
import { body, fakeSdk, message, serve, sse, streamEvents } from './helpers.js';

const request = { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user' as const, content: 'host prompt' }] };

test('single generation preserves native headers, flags, system scaffolding, metadata, and reminders', async t => {
  let sent: any;
  let original: any;
  let cliReceived = '';
  const headers = {
    'accept-encoding': 'gzip, br', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.283 (sdk-ts)',
    'anthropic-version': '2023-06-01', 'anthropic-beta': 'native-beta-1,native-beta-2',
    'x-stainless-lang': 'js', 'x-stainless-runtime': 'bun', 'x-app': 'cli',
    'authorization': 'Bearer fixture-native-auth', 'x-custom-native-flag': 'preserve-me',
  };
  const upstream = await serve(async (req, res) => {
    sent = { body: await body(req), headers: req.headers };
    res.setHeader('content-type', 'text/event-stream'); res.end(sse());
  });
  t.after(() => upstream.close());
  const sdk = { query(params: any) {
    original = { model: 'native-model', max_tokens: 8192, stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'native reminder before' }, { type: 'text', text: params.prompt }, { type: 'text', text: 'native reminder after' }] }],
      system: [{ type: 'text', text: 'native Claude Code system', cache_control: { type: 'ephemeral' } }],
      metadata: { user_id: 'native-user-session', unknown: 'keep' },
      context_management: { edits: [{ type: 'native_edit' }] },
      output_config: { effort: 'high', native_extra: true }, unknown_future_flag: { enabled: true },
    };
    const iterator = (async function* () {
      const result = await fetch(`${params.options.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: 'POST', headers, body: JSON.stringify(original) });
      cliReceived = await result.text();
      yield { type: 'result', subtype: 'success' } as any;
    })();
    return Object.assign(iterator, { close() {} }) as any;
  } };
  const client = await wrapAgentSdk(sdk, { upstreamUrl: upstream.url });
  t.after(() => client.close());
  const result = await client.generate({ ...request, system: 'host system', output_config: { effort: 'low' } });
  assert.deepEqual(result.message.content, message.content);
  for (const [key, value] of Object.entries(headers)) assert.equal(sent.headers[key], value, key);
  for (const key of ['metadata', 'context_management', 'unknown_future_flag']) assert.deepEqual(sent.body[key], original[key]);
  assert.deepEqual(sent.body.system[0], original.system[0]);
  assert.equal(sent.body.system[1].text, 'host system');
  assert.deepEqual(sent.body.output_config, { effort: 'low', native_extra: true });
  assert.equal(sent.body.max_tokens, 100);
  assert.deepEqual(sent.body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'native reminder before' }] },
    ...request.messages,
    { role: 'user', content: [{ type: 'text', text: 'native reminder after' }] },
  ]);
  assert.ok(!JSON.stringify(sent.body).includes('claude-agent-context-'));
  // Let the fixture consume the inert response; never give real tokens to the CLI.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(!cliReceived.includes('hello 🌍'));
});

test('live host text arrives before completion while the CLI receives only inert content', async t => {
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  t.after(() => unblock());
  const upstream = await serve(async (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write(sse(streamEvents().slice(0, 4)));
    await gate;
    res.end(sse(streamEvents().slice(4)));
  });
  t.after(() => upstream.close());
  const client = await wrapAgentSdk(fakeSdk({ stream: true }).sdk, { upstreamUrl: upstream.url });
  t.after(() => client.close());
  let sawText!: () => void;
  const received = new Promise<void>(resolve => { sawText = resolve; });
  let completed = false;
  const result = client.generate(request, { onText(text) { assert.equal(text, 'hello 🌍'); sawText(); } }).then(value => { completed = true; return value; });
  await received;
  assert.equal(completed, false);
  unblock();
  assert.equal((await result).message.stop_reason, 'end_turn');
});

test('auxiliary calls and competing retries cannot produce extra upstream generations', async t => {
  let calls = 0;
  const upstream = await serve((_req, res) => { calls++; res.setHeader('content-type', 'text/event-stream'); res.end(sse()); });
  t.after(() => upstream.close());
  const sdk = { query(params: any) {
    const iterator = (async function* () {
      const make = async (prompt: string) => {
        const response = await fetch(`${params.options.env.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST', body: JSON.stringify({ ...request, stream: true, messages: [{ role: 'user', content: prompt }] }),
        });
        return response.text();
      };
      await make('auxiliary model request');
      await Promise.all([make(params.prompt), make(params.prompt)]);
      yield { type: 'result', subtype: 'success' } as any;
    })();
    return Object.assign(iterator, { close() {} }) as any;
  } };
  const client = await wrapAgentSdk(sdk, { upstreamUrl: upstream.url });
  t.after(() => client.close());
  await client.generate(request);
  assert.equal(calls, 1);
});

test('HTTP and SSE errors retain status, provider type, retry hints, raw request and body without retries', async t => {
  for (const stream of [false, true]) {
    let calls = 0;
    const error = { type: 'error', error: { type: 'overloaded_error', message: 'capacity exhausted' } };
    const upstream = await serve((_req, res) => {
      calls++;
      res.writeHead(stream ? 200 : 529, { 'content-type': stream ? 'text/event-stream' : 'application/json', 'retry-after': '2', 'request-id': 'provider-trace' });
      res.end(stream ? `event: error\ndata: ${JSON.stringify(error)}\n\n` : JSON.stringify(error));
    });
    t.after(() => upstream.close());
    const client = await wrapAgentSdk(fakeSdk({ stream }).sdk, { upstreamUrl: upstream.url });
    t.after(() => client.close());
    await assert.rejects(client.generate(request), e => {
      assert.ok(e instanceof GenerationError);
      assert.equal(e.status, 529); assert.equal(e.code, 'overloaded_error');
      assert.equal(e.retryAfterMs, 2000); assert.equal(e.retryable, true);
      assert.deepEqual(e.details.body, error); assert.equal(e.details.headers?.['request-id'], 'provider-trace');
      assert.ok(e.details.request); return true;
    });
    assert.equal(calls, 1);
  }
});

test('total, first-event, and idle deadlines cancel stalled requests', async t => {
  for (const phase of ['total', 'first-event', 'idle']) {
    const upstream = await serve((_req, res) => {
      if (phase === 'idle') { res.setHeader('content-type', 'text/event-stream'); res.write(sse(streamEvents().slice(0, 1))); }
    });
    t.after(() => upstream.close());
    const client = await wrapAgentSdk(fakeSdk({ stream: true }).sdk, { upstreamUrl: upstream.url });
    t.after(() => client.close());
    await assert.rejects(client.generate(request, {
      timeoutMs: phase === 'total' ? 30 : 1000,
      firstEventTimeoutMs: phase === 'first-event' ? 30 : 1000,
      idleTimeoutMs: phase === 'idle' ? 30 : 1000,
    }), e => e instanceof GenerationError && e.kind === 'timeout' && e.details.phase === phase);
  }
});

test('user abort, wrapper close, and startup failure settle generation promises', async t => {
  const upstream = await serve(() => {});
  t.after(() => upstream.close());
  const client = await wrapAgentSdk(fakeSdk({ stream: true }).sdk, { upstreamUrl: upstream.url });
  t.after(() => client.close());
  const controller = new AbortController();
  const aborted = assert.rejects(client.generate(request, { signal: controller.signal }), e => e instanceof GenerationError && e.kind === 'abort');
  controller.abort(); await aborted;
  const closed = assert.rejects(client.generate(request), e => e instanceof GenerationError && e.kind === 'abort');
  await client.close(); await closed;
  const failure = new Error('spawn failed');
  const broken = await wrapAgentSdk({ query() { throw failure; } });
  t.after(() => broken.close());
  await assert.rejects(broken.generate(request), e => e === failure);
});

test('final rewrites are buffered and cannot contradict live host events', async t => {
  const upstream = await serve((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); });
  t.after(() => upstream.close());
  const client = await wrapAgentSdk(fakeSdk().sdk, { upstreamUrl: upstream.url });
  t.after(() => client.close());
  const result = await client.generate(request, { onGeneration(message) { message.content = [{ type: 'text', text: 'edited' }]; } });
  assert.equal((result.message.content[0] as any).text, 'edited');
  await assert.rejects(client.generate(request, { onText() {}, onGeneration() {} }), /cannot be combined/);
});
