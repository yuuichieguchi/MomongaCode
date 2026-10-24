import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { MessageInputItem } from '@momonga/protocol';
import { TASK, assistant, capabilitiesFor, harness, idsOf, inputFor, sourcesWith, user } from './helpers.ts';

describe('plain-message summary', () => {
  const plainSummary: MessageInputItem = { type: 'message', role: 'user', content: '<conversation_summary>\nearlier work\n</conversation_summary>' };
  const history = [user(1, 'q1'), assistant(2, 'a1'), user(3, 'q2'), assistant(4, 'a2'), user(5, 'q3')];

  it('is emitted in the summary position, after the layers and before the task and the retained history', async () => {
    const capabilities = capabilitiesFor(200000);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history, summary: { item: plainSummary, replacedThroughSeq: 2 } }) }),
      harness(capabilities).ports,
    );
    expect(result.input[1]).toEqual(plainSummary);
    expect(result.input[2]).toEqual(TASK);
    expect(idsOf(result.input.slice(3))).toEqual(['h3', 'h4', 'h5']);
  });
});
