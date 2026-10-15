import type { BetaMessage as Message } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { apiError } from './errors.js';

type ObjectValue = Record<string, any>;

/** Incremental SSE decoder; never buffers the full response or delays text delivery. */
export class MessageDecoder {
  private buffer = '';
  private data: string[] = [];
  private message?: ObjectValue;
  private blocks = new Map<number, { block: ObjectValue; json: string }>();
  private completed = false;
  private decoder = new TextDecoder();

  constructor(
    private readonly complete: (message: Message) => Promise<void>,
    private readonly event?: (event: ObjectValue, completedBlock?: ObjectValue) => void | Promise<void>,
  ) {}

  async push(bytes: Uint8Array): Promise<void> {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    await this.lines(false);
  }

  async finish(): Promise<void> {
    this.buffer += this.decoder.decode();
    await this.lines(true);
    if (this.buffer) await this.line(this.buffer);
    this.buffer = '';
    await this.line('');
    if (!this.completed) throw new Error('Messages stream ended without message_stop');
  }

  private async lines(final: boolean): Promise<void> {
    for (;;) {
      const match = /\r\n|\r(?!$)|\n/.exec(this.buffer);
      if (!match) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      await this.line(line);
    }
    if (final && this.buffer.endsWith('\r')) {
      await this.line(this.buffer.slice(0, -1));
      this.buffer = '';
    }
  }

  private async line(line: string): Promise<void> {
    if (line !== '') {
      if (line === 'data') this.data.push('');
      else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
      return;
    }
    if (!this.data.length) return;
    const data = this.data.join('\n');
    this.data = [];
    if (data === '[DONE]') return;
    const event: ObjectValue = JSON.parse(data);
    if (event.type === 'error') throw apiError(event);
    if (event.type === 'message_start') {
      if (this.message) throw new Error('Duplicate message_start');
      this.message = event.message;
      this.message!.content = [];
    } else if (event.type === 'content_block_start') {
      this.blocks.set(event.index, { block: event.content_block, json: '' });
    } else if (event.type === 'content_block_delta') {
      const state = this.blocks.get(event.index);
      if (!state) throw new Error('Delta without content_block_start');
      const delta = event.delta;
      switch (delta.type) {
        case 'text_delta': state.block.text = (state.block.text ?? '') + delta.text; break;
        case 'thinking_delta': state.block.thinking = (state.block.thinking ?? '') + delta.thinking; break;
        case 'signature_delta': state.block.signature = (state.block.signature ?? '') + delta.signature; break;
        case 'input_json_delta': state.json += delta.partial_json; break;
        case 'citations_delta': (state.block.citations ??= []).push(delta.citation); break;
        case 'compaction_delta':
          state.block.content = delta.content;
          if ('encrypted_content' in delta) state.block.encrypted_content = delta.encrypted_content;
          break;
        default: throw new Error(`Unsupported Messages delta: ${delta.type}`);
      }
    } else if (event.type === 'content_block_stop') {
      const state = this.blocks.get(event.index);
      if (!state || !this.message) throw new Error('Invalid content_block_stop');
      if (state.json) state.block.input = JSON.parse(state.json);
      this.message.content[event.index] = state.block;
      this.blocks.delete(event.index);
    } else if (event.type === 'message_delta') {
      if (!this.message) throw new Error('Delta without message_start');
      Object.assign(this.message, event.delta);
      Object.assign(this.message.usage, event.usage);
    } else if (event.type === 'message_stop') {
      if (!this.message || this.completed || this.blocks.size) throw new Error('Invalid message_stop');
      this.completed = true;
      await this.complete(this.message as Message);
    }
    await this.event?.(structuredClone(event), event.type === 'content_block_stop'
      ? structuredClone(this.message?.content[event.index]) : undefined);
  }
}
