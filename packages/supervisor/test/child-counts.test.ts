import { describe, expect, it } from 'vitest';
import { countsOfHealthBody } from '../src/child-counts.ts';

describe('what the supervisor reads from the health of its children (20.13, 20.45, 20.75)', () => {
  it('reads the counts and the interrupted work the runtime names', () => {
    expect(
      countsOfHealthBody('runtime', {
        steps: 1,
        jobs: 1,
        interrupts: [
          { kind: 'run', id: 'run-a' },
          { kind: 'job', id: 'job-1', command: 'sleep 100' },
        ],
      }),
    ).toEqual({ steps: 1, jobs: 1, interrupts: [{ kind: 'run', id: 'run-a' }, { kind: 'job', id: 'job-1', command: 'sleep 100' }] });
  });

  it('reads no interrupted work from a list that is not the runtime contract', () => {
    expect(countsOfHealthBody('runtime', { steps: 1, jobs: 0, interrupts: [{ kind: 'run' }] })).toEqual({ steps: 1, jobs: 0 });
    expect(countsOfHealthBody('runtime', { steps: 1, jobs: 0, interrupts: 'run-a' })).toEqual({ steps: 1, jobs: 0 });
  });

  it('reads the calls in flight from the gateway and no interrupted work', () => {
    expect(countsOfHealthBody('gateway', { activeRequests: 3, interrupts: [{ kind: 'run', id: 'run-a' }] })).toEqual({ calls: 3 });
  });
});
