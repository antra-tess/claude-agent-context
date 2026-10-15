import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeAgentSdk } from '../src/index.js';
import { body, serve, sse } from './helpers.js';

function inputQueue() {
  const messages: any[] = [];
  let finished = false;
  let wake: (() => void) | undefined;
  return {
    send(content: string) {
      messages.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' });
      wake?.();
    },
    end() { finished = true; wake?.(); },
    async *stream() {
      while (!finished || messages.length) {
        if (messages.length) yield messages.shift();
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    },
  };
}

test('patched native CLI replaces its actual in-memory transcript and rejects stale/busy writes', {
  timeout: 60_000,
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-transcript-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests: any[] = [];
  let releaseSecond: (() => void) | undefined;
  let secondArrived: (() => void) | undefined;
  const arrived = new Promise<void>(resolve => { secondArrived = resolve; });
  const pending = new Promise<void>(resolve => { releaseSecond = resolve; });
  const upstream = await serve(async (req, res) => {
    if (req.url?.split('?')[0] === '/v1/messages') {
      requests.push(await body(req));
      if (requests.length === 2) { secondArrived!(); await pending; }
      res.setHeader('content-type', 'text/event-stream'); res.end(sse());
    } else res.end('{}');
  });
  t.after(() => upstream.close());
  const wrapper = await createClaudeAgentSdk({
    upstreamUrl: upstream.url, enableTranscriptEditing: true,
    onGeneration({ message }) { message.content = [{ type: 'text', text: 'DELIVERED COMPLETION REWRITE' }]; },
  });
  t.after(() => wrapper.close());
  const input = inputQueue();
  t.after(() => input.end());
  const query = wrapper.query({ prompt: input.stream(), options: {
    cwd: home, settingSources: [], persistSession: false, tools: [], maxTurns: 2,
    model: 'claude-sonnet-4-6', permissionMode: 'dontAsk',
    env: {
      PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: 'sk-ant-local-test', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    },
  } });
  const empty = await query.getTranscript();
  assert.deepEqual(empty.messages, []);
  // Updating an empty transcript exercises the native CAS handler before any turn.
  assert.deepEqual(await query.replaceTranscript(empty), empty);
  input.send('ORIGINAL FIRST USER MESSAGE');
  let results = 0;
  for await (const event of query) {
    if (event.type !== 'result') continue;
    assert.equal(event.subtype, 'success');
    results++;
    if (results === 1) {
      const original = await query.getTranscript();
      assert.ok(JSON.stringify(original.messages).includes('ORIGINAL FIRST USER MESSAGE'));
      assert.ok(JSON.stringify(original.messages).includes('DELIVERED COMPLETION REWRITE'));
      assert.ok(!JSON.stringify(original.messages).includes('hello 🌍'));
      const edited = await query.rewriteTranscript(messages => {
        const user = messages.find(m => m.type === 'user' && m.message)!;
        user.message!.content = 'REWRITTEN INTERNAL USER MESSAGE';
        const assistant = messages.find(m => m.type === 'assistant' && m.message)!;
        assistant.message!.content = [{ type: 'text', text: 'REWRITTEN INTERNAL ASSISTANT MESSAGE' }];
      });
      assert.notEqual(edited.revision, original.revision);
      assert.deepEqual(await query.getTranscript(), edited);
      await assert.rejects(query.rewriteTranscript(async messages => {
        messages.length = 0;
        throw new Error('editor failed');
      }), /editor failed/);
      assert.deepEqual(await query.getTranscript(), edited);
      await assert.rejects(query.replaceTranscript(original), /changed since it was read/);
      const invalid = structuredClone(edited);
      invalid.messages.push(invalid.messages[0]);
      await assert.rejects(query.replaceTranscript(invalid), /Invalid transcript/);
      assert.deepEqual(await query.getTranscript(), edited);
      // No beforeRequest callback exists: the next payload must come from the
      // native CLI's modified array, not a gateway overlay or mirrored history.
      input.send('SECOND USER MESSAGE');
      await arrived;
      try {
        await assert.rejects(query.replaceTranscript(await query.getTranscript()), /busy/);
      } finally { releaseSecond!(); }
    } else { input.end(); }
  }
  assert.equal(results, 2);
  assert.equal(requests.length, 2);
  const next = JSON.stringify(requests[1].messages);
  assert.ok(next.includes('REWRITTEN INTERNAL USER MESSAGE'));
  assert.ok(next.includes('REWRITTEN INTERNAL ASSISTANT MESSAGE'));
  assert.ok(next.includes('SECOND USER MESSAGE'));
  assert.ok(!next.includes('ORIGINAL FIRST USER MESSAGE'));
  await assert.rejects(query.getTranscript(), /closed/);
});
