import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';

type View = {
  model: string;
  key: { classifier: string; codeDigest: string; datasetDigest: string };
  measurement: 'passed' | 'did_not_pass' | 'not_measured';
  facts?: { recordedAt: string; falseAllows: number; total: number; upperBound: number; failedBound?: string };
};

const render = (view: View, surface: 'tui' | 'cli'): string => {
  const notice = (protocol as unknown as { autoModeNotice?: (input: { view: View; surface: 'tui' | 'cli' }) => string }).autoModeNotice;
  if (notice === undefined) throw new Error('@momonga/protocol does not export autoModeNotice');
  return notice({ view, surface });
};

const KEY = { classifier: 'classifier-identity', codeDigest: 'code', datasetDigest: 'dataset' };
const CAVEAT = 'auto reduces prompts but does not guarantee safety.';
const COMMAND = { tui: '/auto-mode check', cli: 'momonga auto-mode check' } as const;

describe('autoModeNotice renders the view for the client surface', () => {
  it.each(['tui', 'cli'] as const)('states a passed measurement with its date, false allows and upper bound (%s)', (surface) => {
    const line = render({ model: 'guard', key: KEY, measurement: 'passed', facts: { recordedAt: '2026-11-06T00:00:00.000Z', falseAllows: 0, total: 75, upperBound: 0.0487 } }, surface);
    expect(line.startsWith('auto: classifier guard measured on 2026-11-06: passed (false allows 0/75, upper bound ')).toBe(true);
    expect(line.endsWith(CAVEAT)).toBe(true);
  });

  it.each(['tui', 'cli'] as const)('states a failed measurement and names the command of the surface for the report (%s)', (surface) => {
    const line = render({ model: 'guard', key: KEY, measurement: 'did_not_pass', facts: { recordedAt: '2026-11-06T00:00:00.000Z', falseAllows: 1, total: 75, upperBound: 0.0721, failedBound: 'falseAllow' } }, surface);
    expect(line.startsWith('auto: classifier guard measured on 2026-11-06: did not pass (')).toBe(true);
    expect(line).toContain(`; run ${COMMAND[surface]} for the report`);
    expect(line.endsWith(CAVEAT)).toBe(true);
  });

  it.each(['tui', 'cli'] as const)('states a missing measurement and names the command of the surface (%s)', (surface) => {
    const line = render({ model: 'guard', key: KEY, measurement: 'not_measured' }, surface);
    expect(line.startsWith(`auto: classifier guard has not been measured for this version; run ${COMMAND[surface]}`)).toBe(true);
    expect(line.endsWith(CAVEAT)).toBe(true);
  });

  it('names only the command of its own surface', () => {
    expect(render({ model: 'guard', key: KEY, measurement: 'not_measured' }, 'tui')).not.toContain('momonga auto-mode check');
    expect(render({ model: 'guard', key: KEY, measurement: 'not_measured' }, 'cli')).not.toContain('/auto-mode check');
  });
});
