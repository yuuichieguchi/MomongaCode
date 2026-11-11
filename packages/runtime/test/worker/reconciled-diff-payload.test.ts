import { describe, expect, it } from 'vitest';
import { outcomePayloads } from '../../src/worker/tool-step.ts';
import { expectSchema } from '../service/helpers.ts';

type Outcome = Parameters<typeof outcomePayloads>[0];

const FILES = [{ path: '/work/a.txt', sha256: 'f'.repeat(64), access: 'write' as const }];

const DIFF = { hunks: [{ oldStart: 1, newStart: 1, lines: [' keep', '-old', '+new'] }], added: 1, removed: 1 };

const publicEvent = (payload: object): Record<string, unknown> => ({ id: 1, runId: 'run-1', sessionId: 'session-1', seq: 5, step: 1, createdAt: 1_800_000_000_000, ...payload });

describe('the journal record of an edit that had already been applied', () => {
  it('carries the diff fields its completed form would carry', () => {
    const outcome: Outcome = { callId: 'c1', kind: 'result', idemKey: 'k1', reconciled: 'already_applied', result: { status: 'completed', output: 'Edit to a.txt had already been applied', files: FILES, ...DIFF } };
    const [settled] = outcomePayloads(outcome);
    expect(settled).toEqual({ type: 'tool.reconciled', callId: 'c1', outcome: 'already_applied', output: 'Edit to a.txt had already been applied', files: FILES, ...DIFF });
    expectSchema('PublicRunEvent', publicEvent(settled ?? {}));
    const [completed] = outcomePayloads({ callId: 'c1', kind: 'result', idemKey: 'k1', result: { status: 'completed', output: 'The file a.txt has been updated.', files: FILES, ...DIFF } });
    expect(completed).toMatchObject(DIFF);
  });

  it('carries the omission of the diff', () => {
    const outcome: Outcome = { callId: 'c1', kind: 'result', idemKey: 'k1', reconciled: 'already_applied', result: { status: 'completed', output: 'Write to a.txt had already been applied', files: FILES, diffOmitted: 'file larger than 256 KiB' } };
    const [settled] = outcomePayloads(outcome);
    expect(settled).toMatchObject({ type: 'tool.reconciled', diffOmitted: 'file larger than 256 KiB' });
    expectSchema('PublicRunEvent', publicEvent(settled ?? {}));
  });
});
