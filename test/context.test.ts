import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { wrapAgentSdk, monkeypatchAgentSdk } from '../src/index.js';
import { MessageDecoder } from '../src/sse.js';
import { body, fakeSdk, message, serve, sse, streamEvents } from './helpers.js';

const collect = async (iterable: AsyncIterable<unknown>) => { const values = []; for await (const value of iterable) values.push(value); return values; };

test('modifies full payload on every turn, awaits callbacks, preserves query controls and caller options', async t => {
  const seen: any[] = [];
  const completed: any[] = [];
  const upstream = await serve(async (req, res) => {
    seen.push({ payload: await body(req), key: req.headers['x-api-key'], url: req.url });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message));
  });
  t.after(() => upstream.close());
  const fixture = fakeSdk({ turns: 2 });
  const wrapper = await wrapAgentSdk(fixture.sdk, {
    upstreamUrl: upstream.url + '/base',
    async beforeRequest(context, info) {
      await new Promise(resolve => setTimeout(resolve, 5));
      context.system = 'rewritten'; context.messages.push({ role: 'assistant', content: 'inserted' });
      assert.equal(info.sequence, seen.length + 1);
    },
    async onGeneration(generation) { await new Promise(resolve => setTimeout(resolve, 5)); completed.push(generation); },
  });
  t.after(() => wrapper.close());
  const params = { prompt: 'question', options: { env: { PATH: '/bin' } } };
  const query = wrapper.query(params);
  assert.deepEqual(await query.supportedModels(), []);
  assert.equal(query[Symbol.asyncIterator](), query);
  for await (const _ of query) assert.equal(completed.length, seen.length);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { payload: { model: 'test', system: 'rewritten', messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'inserted' }], stream: false }, key: 'test-secret', url: '/base/v1/messages?beta=true' });
  assert.deepEqual(completed[0].message, message);
  assert.deepEqual(completed[0].request, seen[0].payload);
  assert.notEqual(completed[0].requestId, completed[1].requestId);
  assert.equal(completed[0].queryId, completed[1].queryId);
  assert.deepEqual(params.options.env, { PATH: '/bin' });
  assert.equal(fixture.closes, 1);
});

test('concurrent queries isolate overrides and request snapshots', async t => {
  const upstream = await serve(async (req, res) => { await body(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); });
  t.after(() => upstream.close());
  const results: any[] = [];
  const wrapper = await wrapAgentSdk(fakeSdk().sdk, { upstreamUrl: upstream.url, onGeneration: g => { results.push(g); } });
  t.after(() => wrapper.close());
  await Promise.all(['one', 'two'].map(system => collect(wrapper.query({ prompt: system, callbacks: {
    beforeRequest: context => ({ ...context, system }),
  } }))));
  assert.deepEqual(results.map(g => g.request.system).sort(), ['one', 'two']);
  assert.equal(new Set(results.map(g => g.queryId)).size, 2);
});

test('streams exact bytes and reconstructs fragmented UTF-8, tool JSON, thinking, signatures, citations and usage', async t => {
  const events: any[] = streamEvents();
  events.splice(4, 0, { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'char_location', cited_text: 'hello', document_index: 0, document_title: 'source', start_char_index: 0, end_char_index: 5 } } });
  events.splice(6, 0,
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'thought' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool1', name: 'test', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"file"}' } },
    { type: 'content_block_stop', index: 2 },
  );
  const bytes = Buffer.from(sse(events));
  let reconstructed: any;
  const decoder = new MessageDecoder(async m => { reconstructed = m; });
  for (const byte of bytes) await decoder.push(Uint8Array.of(byte));
  await decoder.finish();
  assert.equal(reconstructed.content[0].text, 'hello 🌍');
  assert.equal(reconstructed.content[0].citations.length, 1);
  assert.deepEqual(reconstructed.content[1], { type: 'thinking', thinking: 'thought', signature: 'sig' });
  assert.deepEqual(reconstructed.content[2].input, { path: 'file' });
  assert.equal(reconstructed.usage.input_tokens, 10);
  assert.equal(reconstructed.usage.output_tokens, 4);
  const upstream = await serve((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(bytes); });
  t.after(() => upstream.close());
  const generations: any[] = [];
  const wrapper = await wrapAgentSdk(fakeSdk({ stream: true }).sdk, { upstreamUrl: upstream.url, onGeneration: g => { generations.push(g); } });
  t.after(() => wrapper.close());
  const values: any[] = await collect(wrapper.query({ prompt: 'hello' }));
  assert.equal(values[0].text, bytes.toString());
  assert.equal(generations.length, 1);
  assert.deepEqual(generations[0].message, reconstructed);
});

test('beforeRequest failure prevents transmission and surfaces the original error', async t => {
  let requests = 0;
  const upstream = await serve((_req, res) => { requests++; res.end('{}'); });
  t.after(() => upstream.close());
  const error = new Error('callback failed');
  const fixture = fakeSdk();
  const wrapper = await wrapAgentSdk(fixture.sdk, { upstreamUrl: upstream.url, beforeRequest() { throw error; } });
  t.after(() => wrapper.close());
  await assert.rejects(collect(wrapper.query({ prompt: 'secret' })), e => e === error);
  assert.equal(requests, 0);
  assert.equal(fixture.closes, 1);
});

test('completion failure and timeout fail the query without silent retry', async t => {
  const upstream = await serve((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(sse()); });
  t.after(() => upstream.close());
  for (const timeout of [false, true]) {
    const error = new Error('completion failed');
    const wrapper = await wrapAgentSdk(fakeSdk({ stream: true }).sdk, {
      upstreamUrl: upstream.url, callbackTimeoutMs: 20,
      onGeneration() { if (timeout) return new Promise(() => {}); throw error; },
    });
    try { await assert.rejects(collect(wrapper.query({ prompt: 'test' })), timeout ? /exceeded 20ms/ : e => e === error); }
    finally { await wrapper.close(); }
  }
});

test('partial/error streams never emit completed generations', async t => {
  for (const events of [streamEvents().slice(0, -1), [...streamEvents().slice(0, 2), { type: 'error', error: { message: 'overloaded' } }]]) {
    let completed = 0;
    const upstream = await serve((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(sse(events as any)); });
    t.after(() => upstream.close());
    const wrapper = await wrapAgentSdk(fakeSdk({ stream: true }).sdk, { upstreamUrl: upstream.url, onGeneration() { completed++; } });
    try { await assert.rejects(collect(wrapper.query({ prompt: 'test' })), /without message_stop|overloaded/); }
    finally { await wrapper.close(); }
    assert.equal(completed, 0);
  }
});

test('non-generation endpoints bypass callbacks; HTTP failures retain status and body', async t => {
  const upstream = await serve((_req, res) => { res.writeHead(429, { 'retry-after': '1' }); res.end('rate limited'); });
  t.after(() => upstream.close());
  let calls = 0;
  const wrapper = await wrapAgentSdk(fakeSdk({ path: '/v1/messages/count_tokens' }).sdk, { upstreamUrl: upstream.url, beforeRequest() { calls++; }, onGeneration() { calls++; } });
  t.after(() => wrapper.close());
  await assert.rejects(collect(wrapper.query({ prompt: 'test' })), /rate limited/);
  assert.equal(calls, 0);
});

test('early exit, explicit close and wrapper disposal release routes', async t => {
  const upstream = await serve((_req, res) => res.end(JSON.stringify(message)));
  t.after(() => upstream.close());
  const fixture = fakeSdk({ turns: 2 });
  const wrapper = await wrapAgentSdk(fixture.sdk, { upstreamUrl: upstream.url });
  t.after(() => wrapper.close());
  for await (const _ of wrapper.query({ prompt: 'test' })) break;
  const stale = await fetch(`${fixture.calls[0].options!.env!.ANTHROPIC_BASE_URL}/v1/messages`);
  assert.equal(stale.status, 404);
  const query = wrapper.query({ prompt: 'unused' });
  query.close(); query.close();
  assert.equal(fixture.closes, 2);
  await wrapper.close(); await wrapper.close();
  assert.throws(() => wrapper.query({ prompt: 'test' }), /closed/);
});

test('monkeypatch restores mutable query and rejects read-only ESM namespaces cleanly', async t => {
  const fixture = fakeSdk(); const previous = fixture.sdk.query;
  const restore = await monkeypatchAgentSdk(fixture.sdk);
  assert.notEqual(fixture.sdk.query, previous);
  await restore(); await restore();
  assert.equal(fixture.sdk.query, previous);
  await assert.rejects(monkeypatchAgentSdk(sdk), /read-only/);
});

test('rejects unsupported transports, invalid payloads, and enforces request size limits', async t => {
  const wrapper = await wrapAgentSdk(fakeSdk().sdk, { maxBodyBytes: 10 });
  t.after(() => wrapper.close());
  assert.throws(() => wrapper.query({ prompt: '', options: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } }), /unsupported/);
  assert.throws(() => wrapper.query({ prompt: '', options: { spawnClaudeCodeProcess: (() => {}) as any } }), /unsupported/);
  await assert.rejects(collect(wrapper.query({ prompt: 'too big' })), /exceeds/);
});

test('compaction deltas preserve final and encrypted content, including null', async () => {
  for (const content of ['summary', null]) {
    let actual: any;
    const events: any[] = streamEvents();
    events[2] = { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: '' } };
    events[3] = { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content, encrypted_content: 'opaque' } };
    const decoder = new MessageDecoder(async message => { actual = message; });
    await decoder.push(Buffer.from(sse(events)));
    await decoder.finish();
    assert.deepEqual(actual.content[0], { type: 'compaction', content, encrypted_content: 'opaque' });
  }
});

test('Messages redirects cannot bypass interception', async t => {
  let escaped = 0;
  const destination = await serve((_req, res) => { escaped++; res.end(JSON.stringify(message)); });
  t.after(() => destination.close());
  const upstream = await serve((_req, res) => { res.writeHead(307, { location: destination.url + '/v1/messages' }); res.end(); });
  t.after(() => upstream.close());
  const wrapper = await wrapAgentSdk(fakeSdk().sdk, { upstreamUrl: upstream.url });
  t.after(() => wrapper.close());
  await assert.rejects(collect(wrapper.query({ prompt: 'test' })), /redirects are unsupported/);
  assert.equal(escaped, 0);
});

test('JSON completions support in-place edits, return replacement, and message reassignment', async t => {
  const upstream = await serve((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); });
  t.after(() => upstream.close());
  for (const mode of ['mutate', 'return', 'reassign']) {
    const wrapper = await wrapAgentSdk(fakeSdk().sdk, { upstreamUrl: upstream.url, onGeneration(generation) {
      const changed = { ...generation.message, content: [{ type: 'text' as const, text: mode }] };
      if (mode === 'return') return changed;
      if (mode === 'reassign') generation.message = changed;
      else generation.message.content = changed.content;
    } });
    try {
      const values: any[] = await collect(wrapper.query({ prompt: 'test' }));
      assert.equal(JSON.parse(values[0].text).content[0].text, mode);
    } finally { await wrapper.close(); }
  }
});

test('rewritten SSE contains only replacement blocks and retains metadata/usage', async t => {
  const upstream = await serve((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(sse()); });
  t.after(() => upstream.close());
  const wrapper = await wrapAgentSdk(fakeSdk({ stream: true }).sdk, { upstreamUrl: upstream.url, onGeneration({ message }) {
    message.content = [
      { type: 'thinking', thinking: 'replaced thought', signature: 'signature' },
      { type: 'text', text: 'REPLACEMENT TEXT', citations: [{ type: 'char_location', cited_text: 'quoted', document_index: 0, document_title: 'title', start_char_index: 0, end_char_index: 6 }] },
      { type: 'tool_use', id: 'new_tool', name: 'Read', input: { file_path: 'rewritten.txt' }, caller: { type: 'direct' } },
    ];
    message.stop_reason = 'tool_use';
  } });
  t.after(() => wrapper.close());
  const values: any[] = await collect(wrapper.query({ prompt: 'test' }));
  assert.ok(!values[0].text.includes('hello 🌍'));
  let actual: any;
  const decoder = new MessageDecoder(async value => { actual = value; });
  await decoder.push(Buffer.from(values[0].text)); await decoder.finish();
  assert.equal(actual.content[0].thinking, 'replaced thought');
  assert.equal(actual.content[0].signature, 'signature');
  assert.equal(actual.content[1].text, 'REPLACEMENT TEXT');
  assert.equal(actual.content[1].citations.length, 1);
  assert.deepEqual(actual.content[2].input, { file_path: 'rewritten.txt' });
  assert.equal(actual.stop_reason, 'tool_use');
  assert.deepEqual(actual.usage, message.usage);
  assert.equal(actual.id, message.id);
});

test('invalid completion replacements fail before delivery; transcript access requires opt-in', async t => {
  const upstream = await serve((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(sse()); });
  t.after(() => upstream.close());
  const wrapper = await wrapAgentSdk(fakeSdk({ stream: true }).sdk, {
    upstreamUrl: upstream.url, onGeneration: () => ({ content: [] }) as any,
  });
  t.after(() => wrapper.close());
  const query = wrapper.query({ prompt: 'test' });
  await assert.rejects(query.getTranscript(), /enableTranscriptEditing/);
  await assert.rejects(collect(query), /valid assistant Message/);
});
