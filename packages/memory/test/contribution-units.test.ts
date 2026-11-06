import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@momonga/protocol';
import { measureContribution } from '@momonga/memory';
import type { InjectedItem } from '@momonga/memory';

const ENVELOPE = { id: 0, runId: 'run-1', sessionId: 'session-1', step: 1, leaseToken: 1, createdAt: 0 };

const longText = (chars: number): string => {
  const line = 'line src/module/file.ts handler 設定ファイルの読み込みに失敗しました。\n';
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
};

const responded = (seq: number, text: string): RunEvent =>
  ({
    ...ENVELOPE,
    seq,
    type: 'model.responded',
    attempt: 1,
    response: {
      status: 'completed',
      output: [{ type: 'message', id: `msg_${seq}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  }) as RunEvent;

const toolOutput = (seq: number, output: string): RunEvent => ({ ...ENVELOPE, seq, type: 'tool.completed', callId: `call_${seq}`, status: 'completed', output }) as RunEvent;

const INJECTED: InjectedItem[] = [{ kind: 'memory', id: 'm-zorpLauncher', text: 'launch with zorpLauncher', fromSeq: 1 }];

const unitsOf = (events: readonly RunEvent[]): number => {
  let units = 0;
  measureContribution({ events, task: 'do the work', injected: INJECTED, unit: () => (units += 1) });
  return units;
};

const SMALL_CHARS = 100_000;
const LARGE_CHARS = 16 * SMALL_CHARS;

describe('O1: the unit of contribution work is bounded by construction, not by the size of an event', () => {
  it('tokenizing one long step text crosses more unit boundaries the longer the text is, so no single unit grows with the event', () => {
    const small = unitsOf([responded(1, `${longText(SMALL_CHARS)} zorpLauncher`)]);
    const large = unitsOf([responded(1, `${longText(LARGE_CHARS)} zorpLauncher`)]);

    expect(large).toBeGreaterThan(small);
  });

  it('scanning one long earlier text for an identifier crosses more unit boundaries the longer the text is', () => {
    const small = unitsOf([toolOutput(1, longText(SMALL_CHARS)), responded(2, 'used zorpLauncher')]);
    const large = unitsOf([toolOutput(1, longText(LARGE_CHARS)), responded(2, 'used zorpLauncher')]);

    expect(large).toBeGreaterThan(small);
  });

  it('chunking changes nothing in the measure: an identifier that straddles any position is still found once', () => {
    const text = `${longText(LARGE_CHARS)} zorpLauncher`;
    let units = 0;
    const result = measureContribution({ events: [responded(1, text)], task: 'do the work', injected: INJECTED, unit: () => (units += 1) });

    expect(result).toEqual([{ kind: 'memory', id: 'm-zorpLauncher', contributed: true }]);
    expect(units).toBeGreaterThan(1);
  });
});
