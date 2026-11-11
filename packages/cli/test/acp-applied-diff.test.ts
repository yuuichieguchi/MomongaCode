import { describe, expect, it } from 'vitest';
import { createMapperState, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures } from '../src/acp/events.ts';
import { frameOf } from './acp-harness.ts';
import type { EventPayload } from './acp-harness.ts';

const NONE: ClientFeatures = { notices: false, compaction: false, elicitation: { form: false, url: false } };

const map = (payload: EventPayload) => mapRunEvent(frameOf('run-1', 1, payload).data, 'live', createMapperState(), NONE);

const FILES = [{ path: '/work/a.txt', sha256: 'f'.repeat(64), access: 'write' as const }];

const contentOf = (payload: EventPayload): unknown => {
  const [effect] = map(payload);
  if (effect?.kind !== 'update' || effect.update.sessionUpdate !== 'tool_call_update') throw new Error('expected one tool call update');
  return effect.update.content;
};

describe('the diff of an edit in an ACP session', () => {
  it('is one diff block per hunk, built from the hunk lines of the event', () => {
    const hunks = [
      { oldStart: 1, newStart: 1, lines: [' keep', '-old', '+new 1', '+new 2', ' end'] },
      { oldStart: 40, newStart: 41, lines: [' before', '-gone'] },
    ];
    expect(contentOf({ type: 'tool.completed', callId: 'call-1', status: 'completed', output: 'edited', files: FILES, hunks, added: 2, removed: 2 })).toEqual([
      { type: 'diff', path: '/work/a.txt', oldText: 'keep\nold\nend\n', newText: 'keep\nnew 1\nnew 2\nend\n' },
      { type: 'diff', path: '/work/a.txt', oldText: 'before\ngone\n', newText: 'before\n' },
    ]);
  });

  it('has no old text for a file that did not exist', () => {
    const hunks = [{ oldStart: 1, newStart: 1, lines: ['+a', '+b'] }];
    expect(contentOf({ type: 'tool.completed', callId: 'call-1', status: 'completed', output: 'Created a.txt (2 lines)', files: FILES, hunks, added: 2, removed: 0 })).toEqual([
      { type: 'diff', path: '/work/a.txt', oldText: null, newText: 'a\nb\n' },
    ]);
  });

  it('is shown for an edit that had already been applied', () => {
    const hunks = [{ oldStart: 1, newStart: 1, lines: ['-value = 1', '+value = 2'] }];
    expect(contentOf({ type: 'tool.reconciled', callId: 'call-1', outcome: 'already_applied', output: 'Edit to a.txt had already been applied', files: FILES, hunks, added: 1, removed: 1 })).toEqual([
      { type: 'diff', path: '/work/a.txt', oldText: 'value = 1\n', newText: 'value = 2\n' },
    ]);
  });

  it('falls to the output text when the diff was omitted', () => {
    expect(contentOf({ type: 'tool.completed', callId: 'call-1', status: 'completed', output: 'Updated a.txt (9000 lines)', files: FILES, diffOmitted: 'file larger than 256 KiB' })).toEqual([
      { type: 'content', content: { type: 'text', text: 'Updated a.txt (9000 lines)' } },
    ]);
  });
});
