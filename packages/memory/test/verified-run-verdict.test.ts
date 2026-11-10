import { describe, expect, it } from 'vitest';
import { analyseVerifiedSuccess, isVerifiedSuccess } from '@momonga/memory';
import { bash, check, journal, requested, seqOfCheck, standing, write } from './verdict-journal.ts';
import type { Condition, Step } from './verdict-journal.ts';

const MANIFESTS = ['package.json'];
const TEST = requested('npm test');

const verdict = (conditions: readonly Condition[] | undefined, steps: readonly Step[], status = 'COMPLETED'): boolean =>
  isVerifiedSuccess({ status, events: journal(conditions, steps), commands: ['npm test'], manifests: MANIFESTS });

describe('the memory gate reads the run verdict', () => {
  it('accepts a completed run whose declared condition passed on the final state', () => {
    expect(verdict([TEST], [write('src/a.ts'), check('npm test')])).toBe(true);
  });

  it('refuses a run whose only evidence is a command the model ran, even when it equals a condition and exited 0', () => {
    expect(verdict([TEST], [write('src/a.ts'), bash('npm test')])).toBe(false);
  });

  it('refuses a run with no declaration, whatever the model ran', () => {
    expect(verdict(undefined, [write('src/a.ts'), bash('npm test')])).toBe(false);
    expect(verdict([], [write('src/a.ts'), bash('npm test')])).toBe(false);
  });

  it('refuses a run that stopped with unmet conditions', () => {
    expect(verdict([TEST], [write('src/a.ts'), check('npm test', 'failed')], 'STOPPED')).toBe(false);
  });

  it.each(['failed', 'timed_out', 'cancelled', 'spawn_error'])('refuses a completed run whose latest verdict of a condition is %s', (outcome) => {
    expect(verdict([TEST], [write('src/a.ts'), check('npm test'), check('npm test', outcome)])).toBe(false);
  });

  it('refuses a pass that a later write made stale', () => {
    expect(verdict([TEST], [check('npm test'), write('src/a.ts')])).toBe(false);
  });

  it('refuses a run in which one of two declared conditions has no verdict on the final state', () => {
    expect(verdict([TEST, requested('npm run lint')], [write('src/a.ts'), check('npm test')])).toBe(false);
    expect(verdict([TEST, requested('npm run lint')], [write('src/a.ts'), check('npm test'), check('npm run lint')])).toBe(true);
  });

  it('refuses a run whose standing conditions were not owed, because nothing was checked', () => {
    expect(verdict([standing('npm test')], [])).toBe(false);
  });

  it('accepts a passed condition whatever its source, also one that is not a command of the settings', () => {
    const events = journal([requested('make check')], [write('src/a.ts'), check('make check')]);
    expect(isVerifiedSuccess({ status: 'COMPLETED', events, commands: ['npm test'], manifests: MANIFESTS })).toBe(true);
  });

  it('keeps the manifest rule: a run that wrote a manifest is not verified', () => {
    expect(verdict([TEST], [write('package.json'), check('npm test')])).toBe(false);
  });

  it('names the passing runtime checks, not the model-run commands', () => {
    const events = journal([TEST], [write('src/a.ts'), bash('npm test'), check('npm test')]);
    const analysis = analyseVerifiedSuccess({ status: 'COMPLETED', events, commands: ['npm test'], manifests: MANIFESTS });
    expect(analysis.verified).toBe(true);
    expect(analysis.passingChecks).toEqual([{ command: 'npm test', conditionId: 'c:npm test', seq: seqOfCheck(events, 'npm test') }]);
  });
});
