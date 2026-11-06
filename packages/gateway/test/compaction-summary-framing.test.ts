import { describe, expect, it } from 'vitest';
import { RECORDED_DATA_MARKER, compactionSummaryMessage } from '@momonga/protocol';
import type { AdapterInputItem } from '@momonga/protocol';
import { messagesOf } from '../src/adapters/anthropic/request.ts';
import { nativeHistoryOf } from '../src/adapters/chat-completions/plain-history.ts';
import { ollamaHistoryOf } from '../src/adapters/ollama/history.ts';
import { buildResponsesBody } from '../src/adapters/open-responses/request.ts';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';

const SUMMARY = 'GOAL: keep the parser green';
const input: AdapterInputItem[] = [{ type: 'compaction_summary', summary: SUMMARY } as AdapterInputItem];

const ADAPTERS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['chat-completions', () => nativeHistoryOf(input, EVERY_REASONING_IS_OWN)],
  ['anthropic', () => messagesOf(input, EVERY_REASONING_IS_OWN)],
  ['ollama', () => ollamaHistoryOf(input, EVERY_REASONING_IS_OWN)],
  ['open-responses', () => buildResponsesBody({ model: 'm', input }, EVERY_REASONING_IS_OWN).input],
];

describe('every adapter renders the recorded-data framing of a compaction summary', () => {
  it.each(ADAPTERS)('%s renders the marker and the model framing with the summary', (_name, render) => {
    const wire = JSON.stringify(render());
    expect(wire).toContain(RECORDED_DATA_MARKER);
    expect(wire).toContain(JSON.stringify(String(compactionSummaryMessage(SUMMARY, 'model').content)).slice(1, -1));
  });
});
