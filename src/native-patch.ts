import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// This deliberately fails closed on every other build. Private minified bindings
// and Bun's container layout are implementation details, not an SDK ABI.
const BINARY_SHA256 = 'd8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e';
const MODULE_SHA256 = '86ac2e24ca71815caf67af250b38a4d7583d5a9159497b20f16627d6198f15d8';
const ANCHOR = 'else if(T.request.subtype==="export_conversation"){';
const TRAILER = Buffer.from('\n---- Bun! ----\n');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// Bindings in the fingerprinted runHeadless module:
// T = control request, Ze = live main-thread transcript array, Je/je = reply/error,
// Fe/Oe/q = execution/permission/queue state, h = app state, Xt = read-file cache.
// No await between revision comparison and splice: this write is atomic within
// the CLI's JS event loop. The array identity is retained for existing references.
const HANDLER = `else if(T.request.subtype==="context_transcript"){
try {
 const req=T.request;
 const revision=()=>new Bun.CryptoHasher("sha256").update(JSON.stringify(Ze)).digest("hex");
 if(req.operation!=="read"&&req.operation!=="replace") {je(T,"Unknown transcript operation");continue}
 if(req.operation==="replace") {
  if(Fe.running||Oe()||r.sessionState.getState()==="requires_action"||q.getDrainableMainThreadQueueLength()>0||Object.values(h().tasks).some(task=>task.status==="running")) {
   je(T,"Transcript is busy; wait for the current turn and background tasks to finish");continue
  }
  if(typeof req.revision!=="string"||req.revision!==revision()) {je(T,"Transcript changed since it was read; read it again before rewriting");continue}
  const next=req.messages;
  if(!Array.isArray(next)||next.length>10000||next.some(m=>!m||typeof m.type!=="string"||typeof m.uuid!=="string"||!m.uuid||((m.type==="user"||m.type==="assistant")&&(!m.message||!(typeof m.message.content==="string"||Array.isArray(m.message.content)))))||new Set(next.map(m=>m.uuid)).size!==next.length) {
   je(T,"Invalid transcript: preserve unique UUIDs and valid message envelopes (maximum 10000 entries)");continue
  }
  Ze.splice(0,Ze.length,...next);
  Xt.clear();
 }
 Je(T,{context_patch_version:1,revision:revision(),messages:Ze});
}catch(error){je(T,String(error))}
}`;

/** Patch only the exact tested native binary, preserving every existing control. */
export function patchNativeTranscript(bytes: Buffer): Buffer {
  if (digest(bytes) !== BINARY_SHA256) {
    throw new Error('Unsupported CLI binary for transcript editing; expected unmodified SDK 0.3.283 macOS arm64');
  }
  const end = bytes.lastIndexOf(TRAILER);
  if (end < 32) throw new Error('Missing Bun module graph trailer');
  const offsets = end - 32;
  const size = Number(bytes.readBigUInt64LE(offsets));
  const base = offsets - size;
  const table = base + bytes.readUInt32LE(offsets + 8);
  const tableSize = bytes.readUInt32LE(offsets + 12);
  const flags = bytes.readUInt32LE(offsets + 28);
  if (base < 0 || table < base || table + tableSize > offsets || tableSize % 52 !== 0 || flags !== 0x1fff) {
    throw new Error('Unsupported Bun module graph layout');
  }
  const anchor = bytes.indexOf(ANCHOR, base);
  if (anchor < 0 || bytes.indexOf(ANCHOR, anchor + 1) !== -1) throw new Error('Transcript patch anchor is not unique');
  for (let index = 0; index < tableSize / 52; index++) {
    const row = table + index * 52;
    const source = base + bytes.readUInt32LE(row + 8);
    const sourceSize = bytes.readUInt32LE(row + 12);
    if (anchor < source || anchor >= source + sourceSize) continue;
    const module = bytes.subarray(source, source + sourceSize);
    if (digest(module) !== MODULE_SHA256) throw new Error('Unsupported Claude Code transcript implementation');
    const rewritten = Buffer.from(module.toString('utf8').replace(ANCHOR, HANDLER + ANCHOR));
    const bytecode = bytes.readUInt32LE(row + 24);
    const bytecodeSize = bytes.readUInt32LE(row + 28);
    if (rewritten.length + 1 > bytecodeSize || base + bytecode + bytecodeSize > table) {
      throw new Error('Insufficient isolated bytecode space for transcript patch');
    }
    // The original source is retained. Repurpose this module's private bytecode
    // region for the modified source and disable ONLY its compiled bytecode.
    // Editing embedded source without this step has no effect on this build.
    rewritten.copy(bytes, base + bytecode);
    bytes[base + bytecode + rewritten.length] = 0;
    bytes.writeUInt32LE(bytecode, row + 8);
    bytes.writeUInt32LE(rewritten.length, row + 12);
    bytes.fill(0, row + 24, row + 32);
    bytes.writeUInt32LE(0, table + tableSize + index * 4); // Recompute source hash.
    bytes.writeUInt32LE(flags & ~0x10, offsets + 28); // Sources are no longer contiguous.
    return bytes;
  }
  throw new Error('Could not locate the native transcript module');
}

export async function prepareTranscriptExecutable(): Promise<{ path: string; dispose(): Promise<void> }> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Native transcript editing currently supports SDK 0.3.283 on macOS arm64 only');
  }
  const require = createRequire(import.meta.url);
  const source = require.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
  const bytes = patchNativeTranscript(await readFile(source));
  const directory = await mkdtemp(join(tmpdir(), 'claude-transcript-'));
  const path = join(directory, 'claude');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await writeFile(path, bytes, { mode: 0o700 });
    // macOS invalidates the vendor signature after a byte change. Ad-hoc sign
    // our private copy so the OS can execute it; never touch the installed CLI.
    await promisify(execFile)('/usr/bin/codesign', ['--force', '--sign', '-', path]);
    return { path, dispose };
  } catch (error) { await dispose(); throw error; }
}
