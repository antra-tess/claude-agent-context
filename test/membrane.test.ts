import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Membrane, NativeFormatter, MembraneError } from '@animalabs/membrane';
import { createClaudeAgentSdk, wrapAgentSdk } from '../src/index.js';
import { ClaudeAgentSdkAdapter } from '../src/membrane.js';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { body, fakeSdk, message, serve, sse, streamEvents } from './helpers.js';

function toolEvents(name: string, input: unknown) {
  const events: any[] = streamEvents();
  events[2] = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_host', name, input: {} } };
  events[3] = { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } };
  events[5].delta.stop_reason = 'tool_use';
  return events;
}

function nativeOptions(home: string) {
  return { cwd: home, env: {
    PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_API_KEY: 'sk-ant-local-test-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
  } };
}

test('native single-generation API returns tool calls without executing them and retains CLI wire fields', { timeout: 20_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-generation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const output = join(home, 'MUST_NOT_BE_WRITTEN.txt');
  const received: any[] = [];
  const upstream = await serve(async (req, res) => {
    if (req.url?.split('?')[0] === '/v1/messages') {
      received.push({ body: await body(req), headers: req.headers });
      res.setHeader('content-type', 'text/event-stream');
      res.end(sse(toolEvents('Write', { file_path: output, content: 'unexpected CLI execution' })));
    } else res.end('{}');
  });
  t.after(() => upstream.close());
  const client = await createClaudeAgentSdk({ upstreamUrl: upstream.url });
  t.after(() => client.close());
  const result = await client.generate({ model: 'claude-sonnet-4-6', max_tokens: 1024,
    messages: [{ role: 'user', content: 'Host-owned generation' }],
    tools: [{ name: 'Write', description: 'Host-owned write', input_schema: { type: 'object' } }],
  }, { sdkOptions: nativeOptions(home), timeoutMs: 10_000 });
  assert.equal(result.message.stop_reason, 'tool_use');
  assert.equal(result.message.content[0].type, 'tool_use');
  assert.equal(received.length, 1);
  assert.ok(received[0].headers['user-agent'].includes('claude'));
  assert.ok(received[0].headers['anthropic-beta']);
  assert.ok(received[0].body.metadata.user_id);
  assert.ok(received[0].body.system.length > 0);
  assert.ok(JSON.stringify(received[0].body.messages).includes('Host-owned generation'));
  assert.ok(!JSON.stringify(received[0].body.messages).includes('claude-agent-context-'));
  await assert.rejects(access(output));
});

test('real Membrane and native SDK perform a host-owned two-round tool loop', { timeout: 20_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'membrane-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests: any[] = [];
  const upstream = await serve(async (req, res) => {
    if (req.url?.split('?')[0] === '/v1/messages') {
      requests.push(await body(req));
      res.setHeader('content-type', 'text/event-stream');
      res.end(sse(requests.length === 1 ? toolEvents('host_echo', { text: 'echo me' }) : streamEvents('host loop finished')));
    } else res.end('{}');
  });
  t.after(() => upstream.close());
  const adapter = new ClaudeAgentSdkAdapter({ upstreamUrl: upstream.url, sdkOptions: nativeOptions(home) });
  t.after(() => adapter.close());
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter(), retry: { maxRetries: 0, overloaded: { maxRetries: 0 } } });
  let executions = 0;
  let streamed = '';
  const response = await membrane.stream({
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'Use the host echo tool' }] }],
    config: { model: 'claude-agent/claude-sonnet-4-6', maxTokens: 1024 },
    tools: [{ name: 'host_echo', description: 'Runs in Membrane', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
  }, {
    onChunk: text => { streamed += text; },
    onToolCalls: async calls => {
      executions++; assert.equal(calls.length, 1); assert.equal(calls[0].name, 'host_echo');
      return [{ toolUseId: calls[0].id, content: 'MEMBRANE_TOOL_RESULT' }];
    },
  });
  assert.equal(executions, 1);
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1].messages).includes('MEMBRANE_TOOL_RESULT'));
  assert.equal(streamed, 'host loop finished');
  assert.equal(response.stopReason, 'end_turn');
  assert.equal(response.usage.inputTokens, 20);
});

test('adapter preserves response accounting, traces and Membrane error classification', async t => {
  const upstream = await serve(async (req, res) => {
    const request = await body(req);
    if (request.messages[0].content === 'fail') {
      res.writeHead(429, { 'retry-after-ms': '1500', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...message, stop_reason: 'stop_sequence', stop_sequence: 'STOP',
        usage: { ...message.usage, cache_read_input_tokens: 31, cache_creation_input_tokens: 9 } }));
    }
  });
  t.after(() => upstream.close());
  const client = await wrapAgentSdk(fakeSdk().sdk, { upstreamUrl: upstream.url });
  t.after(() => client.close());
  const adapter = new ClaudeAgentSdkAdapter({ client });
  t.after(() => adapter.close());
  let wire: any;
  const response = await adapter.complete({ model: 'claude-agent/claude-sonnet-4-6', maxTokens: 10, messages: [{ role: 'user', content: 'ok' }] }, { onRequest: value => { wire = value; } });
  assert.equal(response.model, message.model); assert.equal(response.stopSequence, 'STOP');
  assert.deepEqual(response.rawRequest, wire);
  assert.equal(response.usage.cacheReadTokens, 31); assert.equal(response.usage.cacheCreationTokens, 9);
  await assert.rejects(adapter.complete({ model: 'claude-sonnet-4-6', maxTokens: 10, messages: [{ role: 'user', content: 'fail' }] }), e => {
    assert.ok(e instanceof MembraneError); assert.equal(e.type, 'rate_limit');
    assert.equal(e.httpStatus, 429); assert.equal(e.retryAfterMs, 1500); assert.equal(e.retryable, true);
    return true;
  });
});
