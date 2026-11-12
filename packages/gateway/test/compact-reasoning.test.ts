import { TEST_FENCE } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { AdapterInputItem } from '@momonga/protocol';
import { summaryRequestOf } from '../src/adapters/shared/compact.ts';
import { textOfContent } from '../src/adapters/shared/input-text.ts';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { collect, makeAdapter, startFake, terminalOf, userText } from './cc-support.ts';

const REASONING = 'The cache key must include the locale.';

describe('compaction transcript and reasoning (R2b input rule)', () => {
  it('keeps the text of a reasoning item of the history in the transcript the summary request sends', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'stream', chunks: [{ delta: { role: 'assistant', reasoning: REASONING } }, { delta: { content: 'Noted.' } }, { delta: {}, finishReason: 'stop' }] }],
    });
    const { events } = await collect(makeAdapter(fake), { model: 'system', input: [userText('remember the cache rule')] });
    const output = terminalOf(events).response.output as AdapterInputItem[];
    expect(output.map((item) => item.type)).toEqual(['reasoning', 'message']);

    const summary = summaryRequestOf({ model: 'system', input: [userText('remember the cache rule'), ...output], momonga: { fence: TEST_FENCE } }, 256, EVERY_REASONING_IS_OWN);

    const transcript = summary.input[0];
    if (transcript?.type !== 'message') throw new Error('the summary request carries no transcript message');
    expect(textOfContent(transcript.content)).toContain(REASONING);
  });
});
