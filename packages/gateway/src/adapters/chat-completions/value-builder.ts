import type { JsonEvent } from './incremental-json.ts';

type Frame = { kind: 'object'; value: Record<string, unknown>; key: string | undefined } | { kind: 'array'; value: unknown[] };

export class ValueBuilder {
  private readonly frames: Frame[] = [];
  private text = '';
  private finished = false;
  private built: unknown;

  get done(): boolean {
    return this.finished;
  }

  get value(): unknown {
    if (!this.finished) throw new Error('the JSON value is not complete');
    return this.built;
  }

  accept(event: JsonEvent): void {
    if (this.finished) throw new Error('the JSON value is already complete');
    switch (event.type) {
      case 'object-start':
        this.frames.push({ kind: 'object', value: Object.create(null) as Record<string, unknown>, key: undefined });
        return;
      case 'array-start':
        this.frames.push({ kind: 'array', value: [] });
        return;
      case 'object-end':
      case 'array-end': {
        const frame = this.frames.pop();
        if (frame === undefined) throw new Error('unbalanced JSON container end');
        this.place(frame.value);
        return;
      }
      case 'key': {
        const frame = this.frames.at(-1);
        if (frame?.kind !== 'object') throw new Error('a JSON key outside an object');
        frame.key = event.key;
        return;
      }
      case 'string-start':
        this.text = '';
        return;
      case 'string-delta':
        this.text += event.text;
        return;
      case 'string-end': {
        const text = this.text;
        this.text = '';
        this.place(text);
        return;
      }
      case 'scalar':
        this.place(event.value);
        return;
    }
  }

  private place(value: unknown): void {
    const frame = this.frames.at(-1);
    if (frame === undefined) {
      this.built = value;
      this.finished = true;
    } else if (frame.kind === 'array') {
      frame.value.push(value);
    } else {
      if (frame.key === undefined) throw new Error('a JSON object value without a key');
      frame.value[frame.key] = value;
      frame.key = undefined;
    }
  }
}
