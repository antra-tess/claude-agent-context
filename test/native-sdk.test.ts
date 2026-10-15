import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAgentSdk } from '../src/index.js';
import { body, serve, sse, streamEvents } from './helpers.js';

test('installed native Agent SDK sends rewritten context and emits completion before its result', { timeout: 60_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'claude-context-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixtureFile = join(home, 'fixture.txt');
  await writeFile(fixtureFile, 'ORIGINAL TOOL RESULT MUST NOT BE READ');
  const rewrittenFile = join(home, 'rewritten.txt');
  await writeFile(rewrittenFile, 'rewritten tool result');
  const requests: any[] = [];
  const originalContexts: any[] = [];
  const upstream = await serve(async (req, res) => {
    if (req.url?.split('?')[0] === '/v1/messages') {
      requests.push(await body(req));
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('request-id', 'req_local_test');
      if (requests.length === 1) {
        const events: any[] = streamEvents();
        events[2] = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_read', name: 'Read', input: {} } };
        events[3] = { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: fixtureFile }) } };
        events[5].delta.stop_reason = 'tool_use';
        res.end(sse(events));
      } else res.end(sse());
    } else { res.setHeader('content-type', 'application/json'); res.end('{}'); }
  });
  t.after(() => upstream.close());
  const completed: any[] = [];
  const wrapper = await createClaudeAgentSdk({
    upstreamUrl: upstream.url,
    beforeRequest(context) {
      originalContexts.push(structuredClone(context));
      context.messages[0] = { role: 'user', content: 'REWRITTEN BY CONTEXT CALLBACK' };
    },
    onGeneration(generation) {
      completed.push(generation);
      const tool = generation.message.content.find(block => block.type === 'tool_use');
      if (tool?.type === 'tool_use') tool.input = { file_path: rewrittenFile };
      else return { ...generation.message, content: [{ type: 'text', text: 'REWRITTEN FINAL COMPLETION' }] };
    },
  });
  t.after(() => wrapper.close());
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(ANTHROPIC|CLAUDE|AWS_|GOOGLE_|GCLOUD|AZURE_)/.test(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: home, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'sk-ant-local-test-only',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  });
  let result = false;
  let stderr = '';
  try {
    for await (const event of wrapper.query({
      prompt: 'original prompt',
      options: {
        cwd: home, env, model: 'claude-sonnet-4-6', tools: ['Read'], allowedTools: ['Read'], maxTurns: 3,
        settingSources: [], persistSession: false, permissionMode: 'dontAsk',
        stderr: chunk => { stderr += chunk; },
      },
    })) {
      if (event.type === 'result') {
        assert.equal(event.subtype, 'success', JSON.stringify(event));
        assert.ok(completed.length > 0);
        if (event.subtype === 'success') assert.equal(event.result, 'REWRITTEN FINAL COMPLETION');
        result = true;
      }
    }
  } catch (error) { throw new Error(`Native SDK integration failed: ${String(error)}\n${stderr}`, { cause: error }); }
  assert.ok(result);
  assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual(request.messages[0], { role: 'user', content: 'REWRITTEN BY CONTEXT CALLBACK' });
  assert.ok(originalContexts[1].messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result')));
  assert.equal(completed.length, requests.length);
  assert.equal(completed[0].message.stop_reason, 'tool_use');
  assert.equal(completed[0].message.content[0].input.file_path, rewrittenFile);
  assert.ok(JSON.stringify(requests[1].messages).includes('rewritten tool result'));
  assert.ok(!JSON.stringify(requests[1].messages).includes('ORIGINAL TOOL RESULT MUST NOT BE READ'));
  assert.ok(JSON.stringify(requests[1].messages).includes('rewritten.txt'));
  assert.equal(completed[1].message.content[0].text, 'REWRITTEN FINAL COMPLETION');
});
