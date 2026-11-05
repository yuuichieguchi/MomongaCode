import { parseOutsideJson } from '@momonga/foundation';
import { UpstreamProtocolError } from '../shared/failures.ts';
import type { AnthropicContentBlock, AnthropicDelta } from './events.ts';

type Recorded = { block: Record<string, unknown>; partialJson: string };

export class AssistantRecorder {
  private readonly open = new Map<number, Recorded>();
  private readonly finished = new Map<number, Record<string, unknown>>();

  start(index: number, block: AnthropicContentBlock): void {
    this.open.set(index, { block: structuredClone(block.raw), partialJson: '' });
  }

  apply(index: number, delta: AnthropicDelta): void {
    const recorded = this.open.get(index);
    if (recorded === undefined) return;
    const { block } = recorded;
    switch (delta.kind) {
      case 'text':
        block['text'] = `${typeof block['text'] === 'string' ? block['text'] : ''}${delta.text}`;
        return;
      case 'input_json':
        recorded.partialJson += delta.partialJson;
        return;
      case 'thinking':
        block['thinking'] = `${typeof block['thinking'] === 'string' ? block['thinking'] : ''}${delta.thinking}`;
        return;
      case 'signature':
        block['signature'] = delta.signature;
        return;
      case 'citation':
        block['citations'] = [...(Array.isArray(block['citations']) ? block['citations'] : []), delta.citation];
        return;
      case 'other':
        return;
    }
  }

  stop(index: number): void {
    const recorded = this.open.get(index);
    if (recorded === undefined) return;
    this.open.delete(index);
    if (recorded.partialJson !== '') {
      try {
        recorded.block['input'] = parseOutsideJson(recorded.partialJson);
      } catch (error) {
        throw new UpstreamProtocolError(`the upstream streamed tool input that is not valid JSON: ${(error as Error).message}`);
      }
    }
    this.finished.set(index, recorded.block);
  }

  get unfinished(): number {
    return this.open.size;
  }

  content(): Record<string, unknown>[] {
    return [...this.finished.entries()].sort(([left], [right]) => left - right).map(([, block]) => block);
  }
}
