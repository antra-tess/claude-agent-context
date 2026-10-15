# claude-agent-context

TypeScript wrapper for the Claude Agent SDK, with editable wrapper-managed sessions, a single-generation API, and an optional Membrane provider adapter. The original agent-loop API has two awaited callbacks:

- `beforeRequest(context, info)`: inspect and mutate the fully assembled Messages API payload, or return a replacement.
- `onGeneration({ request, message, ...info })`: inspect and rewrite each completed model response before Claude Code receives it, stores it, or executes its tools.

`client.createSession()` maintains editable conversation history in your application. Each session generation uses a fresh SDK query with that history. This library does not patch, rewrite, or re-sign SDK files or Claude Code executables, and does not edit Claude Code's private transcript or caches.

Tested with `@anthropic-ai/claude-agent-sdk@0.3.283` and Node 20. Requires Node 20+ and the direct Anthropic Messages API transport.

## Install locally

Clone the repository and build it:

```sh
git clone git@github.com:antra-tess/claude-agent-context.git
cd claude-agent-context
npm install
npm run build
```

In your application:

```sh
npm install /path/to/claude-agent-context
```

## Wrapper-managed sessions

A session owns a logical conversation in your application. Its history is supplied to a fresh SDK query for every generation; tools are executed by your application. This API does not attach to an existing `agent.query()` or expose Claude Code's internal transcript.

```ts
import { createClaudeAgentSdk } from 'claude-agent-context';

const client = await createClaudeAgentSdk();
try {
  const session = client.createSession({
    request: { model: 'claude-sonnet-4-6', max_tokens: 4096 },
    // Runtime-only options are not included in saved snapshots:
    // generationOptions: { sdkOptions: { cwd, env: { ...process.env } } },
  });

  await session.generate({
    messages: [{ role: 'user', content: 'My project is called Alpha.' }],
  });
  await session.rewriteHistory(messages => {
    messages[0].content = 'My project is called Beta.';
    // Remove the old assistant response because it may refer to Alpha.
    messages.splice(1);
  });
  const result = await session.generate({
    messages: [{ role: 'user', content: 'What is my project called?' }],
  }, {
    onText: text => { process.stdout.write(text); },
  });
  console.log(result.message.usage);
} finally {
  await client.close();
}
```

`session.generate(request?, options?)` appends the supplied `messages` to the current history for that call. Other request fields override the session's defaults for that call only. A successful generation commits the new input messages and the final assistant response together. A failure, cancellation, or failed callback leaves the history and revision unchanged. Already emitted stream events, upstream charges, and any external callback effects cannot be rolled back. No automatic retries or tool execution are added.

Only one generation may run per session. Mutations, forks, and another generation fail with `SessionError.code === 'busy'` while it is active; other sessions continue independently. `getSnapshot()` returns a detached copy of the last committed state, including while generation is in progress and after the session closes. `session.close()` cancels and awaits only that session's generation. `client.close()` closes all its sessions, raw queries, and the gateway.

### Edit and append history

`rewriteHistory(editor)` accepts synchronous or asynchronous editors that mutate a detached array or return a replacement. A failed editor leaves history unchanged. The commit compares the original revision, so an intervening write causes a `conflict` instead of overwriting it. An editor racing an active generation can fail with `busy`.

For explicit compare-and-swap, including changes to persistent request defaults:

```ts
const snapshot = session.getSnapshot();
snapshot.request.messages[0].content = 'Updated user message';
snapshot.request.max_tokens = 2048;
session.replaceSnapshot(snapshot);
```

`replaceSnapshot()` requires the current session ID and revision. Both are opaque; a successful write issues a new revision even if the contents are identical. `SessionError.code` is `closed`, `busy`, `conflict`, or `invalid` for local session errors. Provider and generation failures retain the existing `GenerationError` behavior.

`session.appendMessages(messages)` commits messages without making a model request. For tool use, execute the returned tool calls in your host, then provide matching results on the next generation:

```ts
await session.generate({ messages: [{
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: toolOutput }],
}] });
```

Snapshots may end in pending tool calls, but all pending client tool calls require results before another generation. Local validation rejects orphan or duplicate results, reused tool IDs, invalid message envelopes, and non-JSON state. It does not replace provider validation or verify thinking signatures. Preserve signed thinking and any opaque provider blocks when editing. Editing earlier messages does not automatically revise later replies or undo tool side effects; explicitly truncate or rewrite dependent messages when appropriate.

### Save, restore, and fork

```ts
const serialized = JSON.stringify(session.getSnapshot()); // Store using your application.
const restored = client.createSession({ snapshot: JSON.parse(serialized) });
const branch = session.fork();
await branch.rewriteHistory(messages => { messages[0].content = 'Try a different premise'; });
```

A version-1 snapshot contains `sessionId`, `revision`, and `request` (request defaults plus committed messages). Restore and fork create independent session IDs and revisions, so a snapshot cannot accidentally replace another session's history. `request` and `snapshot` are mutually exclusive creation options. Persistence is explicit: this library does not write snapshots to disk automatically.

Snapshots exclude `generationOptions`, including SDK credentials, callbacks, and deadlines; supply these again when restoring. Forks inherit the source session's runtime options in memory. Snapshots still contain the full prompt, tools, metadata, and conversation, which may be sensitive.

Session history records the caller's logical messages and the final, possibly rewritten assistant response. It does not absorb CLI-injected reminders or temporary `beforeRequest` transformations; inspect `GenerationResult.request` for the actual sent payload. Use the session editing API for persistent changes. Native Claude Code transcript metadata, caches, background tasks, and compaction state are not part of a managed session.

## Single generation (host owns tools and history)

```ts
import { createClaudeAgentSdk } from 'claude-agent-context';

const client = await createClaudeAgentSdk();
try {
  const result = await client.generate({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'Explain the design' }],
    // system, tools, thinking, stop_sequences, and other explicit API fields are supported.
  }, {
    onText: text => { process.stdout.write(text); },
    onContentBlock: (index, block) => { /* includes complete tool calls and signed thinking */ },
    timeoutMs: 600_000,
    firstEventTimeoutMs: 600_000,
    idleTimeoutMs: 120_000,
    // signal: abortController.signal,
    // sdkOptions: { cwd, env: { ...process.env } },
  });
  console.log(result.message.content, result.message.usage);
  // Execute any returned tool calls in your application, append the assistant
  // response and tool results to your history, and call generate() again.
} finally {
  await client.close();
}
```

`generate()` performs **at most one upstream model request**, including when it fails. It starts a fresh local SDK query with a unique sentinel prompt, binds the generation to the request containing that exact prompt, and handles auxiliary calls/competing SDK retries locally. It does not run its own retry loop. The full actual response goes only to the caller; the CLI receives an inert end-turn response. All genuine tool blocks are withheld from the CLI, including while streaming.

### Keep Claude Code's native request fields

The real SDK creates the request and authenticates it. The transport forwards its authentication, user agent, Anthropic version, beta flags, client headers, and other application headers. Native metadata, unknown body flags, request URL query parameters, system blocks/cache markers, and injected user reminders remain present. Only explicitly supplied generation fields override defaults. Object-valued fields merge at the first level, retaining unspecified native keys. Supplied `system` text/blocks are **appended to** the native Claude Code system scaffold; supplied history replaces the sentinel prompt while retaining surrounding native reminders. The native `stream` setting is retained even for buffered callers.

The transport necessarily replaces the upstream host and recalculates framing/content length; hop-by-hop headers are removed and compressed responses are decoded correctly. This preserves what the SDK emits for the configured session, rather than synthesizing Claude Code headers or promising an identical TLS/network fingerprint. Caller `beforeRequest` overrides can intentionally change these defaults. Adding host cache markers consumes API breakpoint capacity alongside retained native markers, so inspect the actual `onRequest` payload when configuring cache budgets.

### Streaming, errors, and cancellation

`onEvent` observes raw API SSE events; `onText`, `onThinking`, and `onContentBlock` provide convenience callbacks. Events arrive at the **host** during generation, while the CLI receives none of the generated content. `onRequest` receives the final payload just before dispatch. `GenerationResult` includes the actual sent request, full API message, correlation ID, and upstream response headers.

An optional `onGeneration(message)` in `generate()` can rewrite the final message for a buffered caller. It cannot be combined with live stream callbacks, including when a final rewrite is configured on the wrapper: already emitted host tokens cannot be retracted. Observational work after a streamed generation can simply read the resolved result.

`GenerationError` distinguishes API, network, timeout, abort, protocol, callback, and SDK failures. API failures retain `status`, `code`, `retryAfterMs`, and `details` containing the original response body, response headers, and request. HTTP and in-stream overload/rate-limit errors keep their provider classification. Total deadlines include CLI startup; first-event and idle deadlines cover upstream activity, with SSE pings refreshing the idle timer. Caller cancellation and `close()` terminate the owned query and its upstream request. `generate()` waits for its owned CLI to exit before settling; shutdown may add the SDK's grace period after a deadline. `agent.close()` also waits for owned CLI shutdown, and the original query API exposes `waitForClose()` after a synchronous `query.close()`. Your host owns retry policy, avoiding nested SDK/provider retry loops.

## Membrane provider adapter

Install Membrane separately if your application does not already have it:

```sh
npm install @animalabs/membrane
```

```ts
import { Membrane, NativeFormatter } from '@animalabs/membrane';
import { ClaudeAgentSdkAdapter } from 'claude-agent-context/membrane';

const adapter = new ClaudeAgentSdkAdapter({
  // sdkOptions: { cwd: process.cwd(), env: { ...process.env } },
});
const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
try {
  const response = await membrane.complete({
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'Hello' }] }],
    config: { model: 'claude-agent/claude-sonnet-4-6', maxTokens: 1024 },
  });
  console.log(response.content);
} finally {
  await adapter.close();
}
```

The adapter implements `complete()` and `stream()`, accepts either `claude-agent/claude-*` or bare `claude-*` model IDs, forwards stop sequences/thinking/sampling/extra parameters, and returns actual model identity, usage/cache counts, stop reasons, raw requests, and raw responses. Membrane owns tool execution, continuation history, and retries, so the adapter remains stateless and does not add a second managed-session history. Its abort/deadline options are forwarded, and structured failures become `MembraneError` instances with status and retry hints. Native tool mode with `NativeFormatter` is covered by the end-to-end test. Live streaming also supports Membrane's thinking-tag callback convention.

A supplied `client` can share an existing `ContextAgentSdk`; the adapter cancels its own generations on close but leaves that shared client's lifecycle to you. Otherwise it initializes the client lazily and closes it when `adapter.close()` is called.

Membrane is an **optional peer**, loaded only through the `/membrane` entry. The wrapper's pinned Agent SDK and newer Anthropic SDK are regular dependencies, allowing npm to isolate them from Membrane's Anthropic SDK 0.52 dependency. The integration tests run against published Membrane 0.5.79 with both SDK versions installed. No Membrane source changes are required.

## Use the original agent loop

```ts
import { createClaudeAgentSdk } from 'claude-agent-context';

const agent = await createClaudeAgentSdk({
  async beforeRequest(context, { queryId, sequence, signal }) {
    // Includes system prompt, full message history, tool results, tool definitions,
    // and generation options. In-place changes work; returning a new object also works.
    context.messages.unshift({ role: 'user', content: 'Use concise answers.' });
  },
  async onGeneration({ message, request, queryId, sequence }) {
    for (const block of message.content) {
      if (block.type === 'text') block.text = block.text.replaceAll('sensitive text', '[redacted]');
    }
    // Or return a replacement Message, keeping its required envelope fields.
  },
});

try {
  const query = agent.query({
    prompt: 'Explain this project',
    options: { cwd: process.cwd() }, // Normal SDK options, auth, tools, etc.
  });
  // query retains the SDK's iterator, interrupt(), close(), supportedModels(), etc.
  for await (const event of query) {
    if (event.type === 'result') console.log(event);
  }
} finally {
  await agent.close();
}
```

`agent.query()` is synchronous and returns a normal SDK `Query` facade. Only wrapper initialization is asynchronous. `query.close()` closes one query; `agent.close()` closes every owned query, managed session, and the loopback listener. Breaking out of `for await` releases that query. Always close the wrapper when finished, including if a query was created but never iterated.

Callbacks can be overridden per query:

```ts
const query = agent.query({
  prompt: 'Hello',
  callbacks: {
    beforeRequest: context => ({ ...context, system: 'You are a concise assistant.' }),
    onGeneration: async generation => { /* query-specific handling */ },
  },
});
```

An omitted callback inherits the wrapper default; explicitly setting it to `undefined` disables it for that query.

## Migrating from 0.2

Version 0.3 removes the native transcript patch entirely. The `enableTranscriptEditing` option now throws a migration error if supplied, and `query.getTranscript()`, `query.rewriteTranscript()`, `query.replaceTranscript()`, and the native `Transcript*` types are removed. Use `client.createSession()` and its snapshot/history methods for wrapper-managed conversations. Old native transcript snapshots are not compatible with managed-session snapshots.

The stateless `generate()`, Membrane adapter, request/response callbacks, and ordinary SDK `query()` facade retain their behavior. Managed sessions do not edit or resume an existing native agent loop; the host owns their history and tool execution. Builds clean `dist/` so obsolete patching code is not included when upgrading an existing checkout.

## Monkeypatching existing integrations

For code that already calls a **mutable SDK facade**, replace its `query` method and restore it afterwards:

```ts
import * as originalSdk from '@anthropic-ai/claude-agent-sdk';
import { monkeypatchAgentSdk } from 'claude-agent-context';

const sdk = { ...originalSdk }; // Share this facade with your application.
const restore = await monkeypatchAgentSdk(sdk, {
  beforeRequest(context) { context.system = 'Your replacement system prompt'; },
  onGeneration(generation) { console.log(generation.message); },
});
try {
  for await (const event of sdk.query({ prompt: 'Hello' })) {
    // Existing application code.
  }
} finally {
  await restore(); // Restores query and closes owned resources.
}
```

ES module namespace bindings cannot be assigned to. Patching the facade does not replace functions already imported/destructured elsewhere. For an ESM namespace, use `await wrapAgentSdk(originalSdk, callbacks)` and call the returned `.query`. The `/core` SDK entry can also be passed to `wrapAgentSdk`; that path does not load the root SDK entry. Avoid stacking multiple monkeypatches on the same facade.

## How interception works

The Agent SDK launches Claude Code in a subprocess. The [current SDK ships a native CLI binary](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/README.md), so monkeypatching `globalThis.fetch` in your application cannot intercept its requests.

This library wraps/monkeypatches `query` and sets **only that query's subprocess** `ANTHROPIC_BASE_URL` to a loopback interceptor. Each query has an unguessable route and independent callbacks. The interceptor edits `/v1/messages` JSON immediately before forwarding it to the original upstream. Authentication headers are forwarded; credentials are not supplied to callbacks. SDK files, executables, and global environment variables are untouched.

Without `onGeneration`, responses stream back with backpressure. With `onGeneration`, **the entire response is buffered**, reconstructed, passed to the callback, and then delivered as a valid SSE stream (or JSON). No original text or tool arguments are delivered before the callback finishes. This adds full-generation latency even for an observer-only callback; leave it unset when you need live token delivery. Unchanged SSE responses retain their original bytes. Rewritten responses retain their message metadata and usage. Other API endpoints pass through without invoking callbacks.

## Callback semantics and limits

- `beforeRequest` edits the outgoing API payload. With `query()`, `onGeneration` edits what the CLI receives and subsequently stores. With `generate()` and managed sessions, it edits the response returned to the host. `session.rewriteHistory()` edits the wrapper's committed history for future generations. Preserve tool-use/tool-result pairing, signed thinking blocks, and valid API structures.
- A generation is one complete API response, not the entire agent run. A tool loop can produce several callbacks. To observe completion of the whole run, consume SDK `result` events. Auxiliary model calls and retries also pass through; `queryId`, `requestId`, and per-query `sequence` identify individual requests. Concurrent model calls may invoke callbacks concurrently.
- Returning `void` from `beforeRequest` keeps in-place edits. Returning an object replaces the request. Throwing fails the query before transmission. `onGeneration` supports in-place edits to `generation.message`, assignment of a replacement to that property, or returning a replacement Message. Its edited content, tool names/inputs, and stop reason affect what the CLI stores and executes. Keep stop reason consistent with the content. Usage is the original API usage unless you explicitly change it; rewriting text does not recalculate token accounting.
- Both callbacks are awaited. Exceptions/timeouts close the query and surface the original error through iteration. A failed completion callback occurs **after** the upstream generated its response; it cannot undo that generation. Incomplete/error streams do not produce a completion callback. Interceptor protocol/transport errors fail the query rather than silently bypassing interception.
- Callbacks default to a 30-second timeout, configurable with `callbackTimeoutMs`. Callback code cannot be forcibly stopped; honor the supplied `signal` for cancellation. Completed-generation signals are valid during the callback and aborted when request processing ends.
- HTTP API error responses are forwarded as-is, allowing SDK retry behavior. A successful retry is a separate intercepted request. Streaming protocol errors fail the query.
- `upstreamUrl` overrides the query's `env.ANTHROPIC_BASE_URL`, which otherwise defaults to `https://api.anthropic.com`. Custom base paths are supported. Requests and buffered responses (including SSE when `onGeneration` is configured) default to a 32 MiB limit (`maxBodyBytes`). Unbuffered responses stream with backpressure.
- Bedrock, Vertex, Foundry, custom/remote `spawnClaudeCodeProcess`, compressed request bodies, and Messages API redirects are rejected. The original wrapper targets `query()`; `generate()` uses it internally. Other SDK session APIs are not wrapped. Keep provider/base URL settings stable inside the CLI; custom CLI behavior that replaces the configured transport can bypass this boundary.
- The loopback listener and its route must stay reachable from the local CLI. Existing outbound proxy settings for the CLI-to-loopback hop are bypassed with `NO_PROXY`; upstream forwarding uses Node's built-in fetch and does not configure an enterprise outbound proxy or custom TLS agent.
- Compatibility is tested against the pinned SDK version. New API streaming event formats or SDK transport changes may require an update.

## Verify

```sh
npm run check
```

The tests cover native request/header/flag preservation, single-generation isolation, live host streaming, all three deadlines, cancellation, structured HTTP/SSE errors, published Membrane integration, request replacement/mutation, tool-loop requests, concurrent query isolation, SSE parsing across individual UTF-8 bytes, completion ordering, failures/timeouts, cancellation/cleanup, monkeypatch restoration, response rewriting (including an actual rewritten `Read` tool call), and the **actual unmodified native SDK** talking to a local mock Messages API. Managed-session tests verify that edits reach subsequent model requests, failed or cancelled generations leave no partial history, snapshots round-trip through JSON, branches remain isolated, tool-result pairs and signed content survive continuation, and stale/busy/invalid writes are rejected. No test patches or re-signs executables. Native SDK tests use a temporary Claude home and a fake API key; no paid model requests are made. Live Anthropic-service authentication, real model output, and deployment-specific networking are not tested.
