import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAgentSdk, wrapAgentSdk, SessionError, GenerationError } from '../src/index.js';
import { body, fakeSdk, message, serve, sse, streamEvents } from './helpers.js';

const user = (content: string) => ({ role: 'user' as const, content });
const errorCode = (code: string) => (error: unknown) => error instanceof SessionError && error.code === code;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function respond(res: ServerResponse, content = 'answer') {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: content }] }));
}
async function setup(t: TestContext, handler: (request: any, res: ServerResponse) => void | Promise<void> = (_req, res) => respond(res)) {
  const requests: any[] = [];
  const upstream = await serve(async (req, res) => {
    const request = await body(req);
    requests.push(request);
    await handler(request, res);
  });
  t.after(() => upstream.close());
  const fixture = fakeSdk({ stream: true });
  const client = await wrapAgentSdk(fixture.sdk, { upstreamUrl: upstream.url });
  t.after(() => client.close());
  return { client, requests, fixture };
}

test('session sends edited history on every call, isolates caller data, and retains request defaults', async t => {
  const { client, requests, fixture } = await setup(t);
  const initial = { model: 'default-model', max_tokens: 512, messages: [user('original')] };
  const session = client.createSession({ request: initial });
  initial.messages[0].content = 'caller mutation';
  const input = { messages: [user('first turn')], model: 'one-call-model' };
  const first = session.generate(input, { onGeneration(result) { result.content = [{ type: 'text', text: 'edited response' }]; } });
  input.messages[0].content = 'late mutation';
  const result = await first;
  assert.equal(requests[0].model, 'one-call-model');
  assert.deepEqual(requests[0].messages, [user('original'), user('first turn')]);
  assert.equal(session.getSnapshot().request.model, 'default-model');
  result.message.content.length = 0;
  assert.equal((session.getSnapshot().request.messages[2].content as any)[0].text, 'edited response');

  const before = session.getSnapshot();
  const edited = await session.rewriteHistory(messages => { messages[0].content = 'replacement'; });
  assert.notEqual(edited.revision, before.revision);
  edited.request.messages.length = 0;
  await session.generate({ messages: [user('second turn')] });
  assert.equal(requests[1].model, 'default-model');
  assert.equal(requests[1].max_tokens, 512);
  assert.deepEqual(requests[1].messages, [user('replacement'), user('first turn'),
    { role: 'assistant', content: [{ type: 'text', text: 'edited response' }] }, user('second turn')]);
  assert.equal(fixture.calls.length, 2);
  assert.notEqual(fixture.calls[0].prompt, fixture.calls[1].prompt);
  assert.equal(fixture.calls[0].options?.pathToClaudeCodeExecutable, undefined);
});

test('snapshot replacement and asynchronous history edits reject stale or foreign revisions without losing writes', async t => {
  const { client } = await setup(t);
  const session = client.createSession({ request: { messages: [user('base')] } });
  const original = session.getSnapshot();
  const candidate = session.getSnapshot();
  candidate.request.system = 'changed default';
  session.replaceSnapshot(candidate);
  assert.throws(() => session.replaceSnapshot(original), errorCode('conflict'));
  assert.throws(() => session.replaceSnapshot(session.fork().getSnapshot()), errorCode('conflict'));

  const paused = deferred();
  const editor = session.rewriteHistory(async messages => { await paused.promise; messages[0].content = 'stale edit'; });
  const rejected = assert.rejects(editor, errorCode('conflict'));
  session.appendMessages([user('concurrent write')]);
  paused.resolve();
  await rejected;
  assert.deepEqual(session.getSnapshot().request.messages, [user('base'), user('concurrent write')]);
  const stable = session.getSnapshot();
  await assert.rejects(session.rewriteHistory(messages => { messages.length = 0; throw new Error('editor failed'); }), /editor failed/);
  assert.deepEqual(session.getSnapshot(), stable);
  await session.rewriteHistory(() => [user('returned replacement')]);
  assert.deepEqual(session.getSnapshot().request.messages, [user('returned replacement')]);
});

test('JSON snapshots restore defaults and history, forks diverge, and runtime options are never serialized', async t => {
  const { client, requests } = await setup(t);
  const session = client.createSession({ request: { model: 'saved-model', system: 'saved system', messages: [user('saved')] },
    generationOptions: { sdkOptions: { env: { ANTHROPIC_API_KEY: 'runtime-only-secret' } }, onText() {} },
  });
  const snapshot = session.getSnapshot();
  const json = JSON.stringify(snapshot);
  assert.ok(!json.includes('runtime-only-secret'));
  assert.ok(!json.includes('generationOptions'));
  const restored = client.createSession({ snapshot: JSON.parse(json) });
  const fork = session.fork();
  assert.notEqual(restored.id, session.id);
  assert.notEqual(fork.getSnapshot().revision, snapshot.revision);
  await fork.rewriteHistory(messages => { messages[0].content = 'fork only'; });
  await session.close();
  assert.deepEqual(session.getSnapshot(), snapshot);
  await restored.generate();
  await fork.generate();
  assert.deepEqual(requests.map(request => request.messages[0].content), ['saved', 'fork only']);
  assert.equal(requests[0].model, 'saved-model');
  assert.ok(JSON.stringify(requests[0].system).includes('saved system'));
  assert.throws(() => client.createSession({ snapshot, request: {} }), errorCode('invalid'));
  assert.throws(() => client.createSession({ snapshot: { ...snapshot, version: 9 } as any }), errorCode('invalid'));
});

test('a generation locks session writes while other sessions remain usable, then commits atomically', { timeout: 10_000 }, async t => {
  const arrived = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const { client } = await setup(t, async (request, res) => {
    if (request.messages[0].content === 'blocked') { arrived.resolve(); await release.promise; }
    respond(res);
  });
  const session = client.createSession();
  const initial = session.getSnapshot();
  const running = session.generate({ messages: [user('blocked')] });
  await arrived.promise;
  assert.deepEqual(session.getSnapshot(), initial);
  assert.throws(() => session.appendMessages([user('lost')]), errorCode('busy'));
  assert.throws(() => session.replaceSnapshot(initial), errorCode('busy'));
  assert.throws(() => session.fork(), errorCode('busy'));
  await assert.rejects(session.rewriteHistory(() => []), errorCode('busy'));
  await assert.rejects(session.generate(), errorCode('busy'));
  const sibling = client.createSession();
  await sibling.generate({ messages: [user('independent')] });
  release.resolve();
  await running;
  assert.equal(session.getSnapshot().request.messages.length, 2);
  assert.notEqual(session.getSnapshot().revision, initial.revision);
});

test('API failures, callback failures, and timeouts leave inputs and revisions uncommitted', { timeout: 10_000 }, async t => {
  const { client, requests } = await setup(t, (request, res) => {
    const prompt = request.messages.at(-1).content;
    if (prompt === 'fail') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'try later' } }));
    } else if (prompt !== 'timeout') respond(res);
  });
  const session = client.createSession({ request: { messages: [user('base')] } });
  const before = session.getSnapshot();
  await assert.rejects(session.generate({ messages: [user('fail')] }),
    error => error instanceof GenerationError && error.status === 429 && error.retryAfterMs === 2000);
  assert.deepEqual(session.getSnapshot(), before);
  await assert.rejects(session.generate({ messages: [user('callback')] }, { onGeneration() { throw new Error('callback failed'); } }), /callback failed/);
  assert.deepEqual(session.getSnapshot(), before);
  await assert.rejects(session.generate({ messages: [user('timeout')] }, { timeoutMs: 30 }),
    error => error instanceof GenerationError && error.kind === 'timeout');
  assert.deepEqual(session.getSnapshot(), before);
  await session.generate({ messages: [user('recovered')] });
  assert.deepEqual(requests.at(-1).messages, [user('base'), user('recovered')]);
});

test('caller abort, session close, and wrapper close cancel generations without affecting committed history', { timeout: 10_000 }, async t => {
  const arrivals = new Map(['abort', 'close', 'close parent'].map(prompt => [prompt, deferred()]));
  const { client } = await setup(t, (request, res) => {
    const prompt = request.messages.at(-1).content;
    arrivals.get(prompt)?.resolve();
    if (prompt === 'ok') respond(res);
  });
  const session = client.createSession();
  const before = session.getSnapshot();
  const controller = new AbortController();
  const cancelled = assert.rejects(session.generate({ messages: [user('abort')] }, { signal: controller.signal }),
    error => error instanceof GenerationError && error.kind === 'abort');
  await arrivals.get('abort')!.promise;
  controller.abort();
  await cancelled;
  assert.deepEqual(session.getSnapshot(), before);
  const closing = assert.rejects(session.generate({ messages: [user('close')] }),
    error => error instanceof GenerationError && error.kind === 'abort');
  await arrivals.get('close')!.promise;
  await session.close();
  await closing;
  assert.deepEqual(session.getSnapshot(), before);
  await assert.rejects(session.generate(), errorCode('closed'));
  assert.throws(() => session.appendMessages([]), errorCode('closed'));
  assert.throws(() => session.fork(), errorCode('closed'));

  const sibling = client.createSession();
  await sibling.generate({ messages: [user('ok')] });
  const committed = sibling.getSnapshot();
  const parentClosed = assert.rejects(sibling.generate({ messages: [user('close parent')] }),
    error => error instanceof GenerationError && error.kind === 'abort');
  await arrivals.get('close parent')!.promise;
  await client.close();
  await parentClosed;
  assert.deepEqual(sibling.getSnapshot(), committed);
  assert.throws(() => client.createSession(), /closed/);
});

test('host-owned tool turns preserve signed content and reject unmatched, duplicated, or missing results', async t => {
  const thinking = { type: 'thinking', thinking: 'opaque thought', signature: 'preserve-this-signature' };
  let turn = 0;
  const { client, requests } = await setup(t, (_request, res) => {
    if (turn++ === 0) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...message, stop_reason: 'tool_use', content: [thinking,
        { type: 'tool_use', id: 'tool-a', name: 'host_echo', input: { text: 'a' } },
        { type: 'tool_use', id: 'tool-b', name: 'host_echo', input: { text: 'b' } },
      ] }));
    } else respond(res, 'tools completed');
  });
  const session = client.createSession();
  await session.generate({ messages: [user('use tools')] });
  const pending = session.getSnapshot();
  await assert.rejects(session.generate(), errorCode('invalid'));
  assert.equal(requests.length, 1);
  assert.throws(() => session.appendMessages([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wrong', content: 'x' }] }]), errorCode('invalid'));
  assert.deepEqual(session.getSnapshot(), pending);
  const resultA = { type: 'tool_result' as const, tool_use_id: 'tool-a', content: 'a result' };
  const resultB = { type: 'tool_result' as const, tool_use_id: 'tool-b', content: 'b result' };
  await assert.rejects(session.generate({ messages: [{ role: 'user', content: [resultA, resultA] }] }), errorCode('invalid'));
  await assert.rejects(session.generate({ messages: [{ role: 'user', content: [resultA] }] }), errorCode('invalid'));
  await session.generate({ messages: [{ role: 'user', content: [resultA, resultB] }] });
  assert.deepEqual(requests[1].messages[1].content[0], thinking);
  assert.deepEqual(requests[1].messages[2].content, [resultA, resultB]);
  const stable = session.getSnapshot();
  await assert.rejects(session.rewriteHistory(messages => { messages.splice(1, 1); }), errorCode('invalid'));
  assert.deepEqual(session.getSnapshot(), stable);
});

test('streaming exposes live text but commits history only after completion; failed streams roll back', { timeout: 10_000 }, async t => {
  const streamed = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const { client } = await setup(t, async (_request, res) => {
    const events = streamEvents('live text');
    res.setHeader('content-type', 'text/event-stream');
    res.write(sse(events.slice(0, -1)));
    await release.promise;
    res.end(sse(events.slice(-1)));
  });
  const session = client.createSession();
  const before = session.getSnapshot();
  let text = '';
  const running = session.generate({ messages: [user('stream')] }, { onText(chunk) { text += chunk; streamed.resolve(); } });
  await streamed.promise;
  assert.equal(text, 'live text');
  assert.deepEqual(session.getSnapshot(), before);
  release.resolve();
  await running;
  const committed = session.getSnapshot();
  assert.equal((committed.request.messages[1].content as any)[0].text, 'live text');
  const failure = new Error('stream callback failed');
  await assert.rejects(session.generate({ messages: [user('stream failure')] }, { onText() { throw failure; } }),
    error => error instanceof GenerationError && error.kind === 'callback' && error.cause === failure);
  assert.deepEqual(session.getSnapshot(), committed);
});

test('invalid persisted state and non-JSON values are rejected without modifying history', async t => {
  const { client } = await setup(t);
  const session = client.createSession();
  const before = session.getSnapshot();
  for (const bad of [
    { messages: [{ role: 'system', content: 'bad role' }] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 10 }] }] },
    { messages: [], temperature: NaN },
    { messages: [], metadata: { date: new Date() } },
    { messages: [], metadata: { function() {} } },
  ]) {
    assert.throws(() => session.replaceSnapshot({ ...before, request: bad as any }), errorCode('invalid'));
    assert.deepEqual(session.getSnapshot(), before);
  }
  const cycle: any = {}; cycle.self = cycle;
  assert.throws(() => client.createSession({ request: { messages: [], metadata: cycle } }), errorCode('invalid'));
  await assert.rejects(session.generate(), /at least one message/);
  assert.deepEqual(session.getSnapshot(), before);
});

test('real unmodified SDK uses rewritten session history across fresh queries without replaying native scaffolding', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: any[] = [];
  const upstream = await serve(async (req, res) => {
    if (req.url?.split('?')[0] === '/v1/messages') {
      requests.push(await body(req));
      res.setHeader('content-type', 'text/event-stream');
      res.end(sse(streamEvents('native response')));
    } else res.end('{}');
  });
  t.after(() => upstream.close());
  const client = await createClaudeAgentSdk({ upstreamUrl: upstream.url });
  t.after(() => client.close());
  const session = client.createSession({
    request: { model: 'claude-sonnet-4-6', max_tokens: 256 },
    generationOptions: { sdkOptions: { cwd: directory, env: {
      PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_API_KEY: 'sk-ant-local-test-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    } } },
  });
  await session.generate({ messages: [user('ORIGINAL SESSION MESSAGE')] });
  await session.rewriteHistory(messages => { messages[0].content = 'EDITED SESSION MESSAGE'; });
  await session.generate({ messages: [user('CONTINUATION')] });
  assert.equal(requests.length, 2);
  const next = JSON.stringify(requests[1].messages);
  assert.ok(next.includes('EDITED SESSION MESSAGE'));
  assert.ok(next.includes('native response'));
  assert.ok(next.includes('CONTINUATION'));
  assert.ok(!next.includes('ORIGINAL SESSION MESSAGE'));
  assert.ok(!next.includes('claude-agent-context-'));
  assert.deepEqual(session.getSnapshot().request.messages, [user('EDITED SESSION MESSAGE'),
    { role: 'assistant', content: [{ type: 'text', text: 'native response' }] }, user('CONTINUATION'),
    { role: 'assistant', content: [{ type: 'text', text: 'native response' }] }]);
});
