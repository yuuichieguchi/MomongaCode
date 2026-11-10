import { describe, expect, it } from 'vitest';
import { isVerifiedSuccess } from '@momonga/memory';
import { bash, check, journal, read, reconciled, standing, write } from './verdict-journal.ts';
import type { Step } from './verdict-journal.ts';

const COMMANDS = ['npm test', 'pytest'];
const MANIFESTS = ['package.json', 'Makefile'];
const CONDITIONS = COMMANDS.map(standing);

const verdict = (steps: readonly Step[], status = 'COMPLETED'): boolean =>
  isVerifiedSuccess({ status, events: journal(CONDITIONS, steps), commands: COMMANDS, manifests: MANIFESTS });

const pass = (): Step[] => [check('npm test'), check('pytest')];

describe('isVerifiedSuccess', () => {
  it('accepts a completed run whose conditions passed after its last write', () => {
    expect(verdict([write('src/a.ts'), ...pass()])).toBe(true);
  });

  it.each(['FAILED', 'CANCELLED', 'STOPPED'])('refuses a run that ended %s, so a passing check cannot bless an unfinished run', (status) => {
    expect(verdict([write('src/a.ts'), ...pass()], status)).toBe(false);
  });

  it('refuses a passing check that a later write made out of date', () => {
    expect(verdict([write('src/a.ts'), ...pass(), write('src/b.ts')])).toBe(false);
  });

  it('refuses a run with no verdict at all', () => {
    expect(verdict([write('src/a.ts')])).toBe(false);
  });

  it('takes the latest verdict of a condition, so a fix after a failure counts and a failure after a pass does not', () => {
    expect(verdict([write('src/a.ts'), check('npm test', 'failed'), write('src/a.ts'), ...pass()])).toBe(true);
    expect(verdict([write('src/a.ts'), ...pass(), check('pytest', 'failed')])).toBe(false);
  });

  it('refuses a run that wrote a manifest, because a manifest can change what the command does', () => {
    expect(verdict([write('package.json'), ...pass()])).toBe(false);
    expect(verdict([write('Makefile'), write('src/a.ts'), ...pass()])).toBe(false);
  });

  it('matches a manifest by base name at any depth, because a nested one changes what the command does', () => {
    expect(verdict([write('packages/web/package.json'), ...pass()])).toBe(false);
    expect(verdict([write('tools/build/Makefile'), ...pass()])).toBe(false);
    expect(verdict([write('src/package.json.bak'), ...pass()])).toBe(true);
    expect(verdict([write('docs/my-package.json'), ...pass()])).toBe(true);
  });

  it('counts a reconciled write as a write, because its outcome is unknown and a later check is needed', () => {
    expect(verdict([write('src/a.ts'), ...pass(), reconciled(write('src/b.ts'), 'unknown')])).toBe(false);
    expect(verdict([write('src/a.ts'), ...pass(), reconciled(write('src/b.ts'), 'already_applied')])).toBe(false);
    expect(verdict([reconciled(write('src/b.ts'), 'unknown'), ...pass()])).toBe(true);
    expect(verdict([reconciled(write('src/b.ts'), 'already_applied'), ...pass()])).toBe(true);
  });

  it('does not count a reconciled write that was not applied', () => {
    expect(verdict([write('src/a.ts'), ...pass(), reconciled(write('src/b.ts'), 'not_applied')])).toBe(true);
  });

  it('refuses a run whose reconciled write may have changed a manifest', () => {
    expect(verdict([reconciled(write('package.json'), 'unknown'), ...pass()])).toBe(false);
  });

  it('accepts a run that only read a manifest', () => {
    expect(verdict([read('package.json'), write('src/a.ts'), ...pass()])).toBe(true);
  });

  it('does not let a read after the check count as a write', () => {
    expect(verdict([write('src/a.ts'), ...pass(), read('src/a.ts')])).toBe(true);
  });

  it('does not let a call the person rejected, which never started, count as a mutation', () => {
    expect(verdict([write('src/a.ts'), ...pass(), bash('git push', { basis: 'person', status: 'failed', rejected: true })])).toBe(true);
  });

  describe('a Bash call that is not read only', () => {
    const edit = (command = "sed -i 's/a/b/' package.json"): Step => bash(command, { basis: 'person' });

    it('counts as a write of unknown paths, so a check after it does not verify the run', () => {
      expect(verdict([edit(), ...pass()])).toBe(false);
      expect(verdict([write('src/a.ts'), edit(), ...pass()])).toBe(false);
    });

    it('does not matter for a read only call between the write and the check, nor after it', () => {
      expect(verdict([write('src/a.ts'), bash('git status'), ...pass()])).toBe(true);
      expect(verdict([write('src/a.ts'), ...pass(), bash('git status')])).toBe(true);
    });

    it.each(['rule', 'mode', 'hook', 'classifier', 'person'] as const)('counts when the approval basis is %s', (basis) => {
      expect(verdict([bash('rm -rf build', { basis }), ...pass()])).toBe(false);
    });

    it('counts when no approval basis was recorded, because the call cannot be shown to be read only', () => {
      expect(verdict([bash('git status', { basis: 'unrecorded' }), ...pass()])).toBe(false);
    });

    it('counts even when the call failed, because a failed command may have changed a file first', () => {
      expect(verdict([bash('sed -i s/a/b/ package.json', { basis: 'person', exitCode: 1 }), ...pass()])).toBe(false);
    });

    it('is a mutation but no write of a manifest when it is exactly a verification command, so the checks after it verify the run', () => {
      expect(verdict([write('src/a.ts'), bash('npm test', { basis: 'person' }), ...pass()])).toBe(true);
      expect(verdict([write('src/a.ts'), ...pass(), bash('npm test', { basis: 'person' })])).toBe(false);
    });

    it('counts when the command only contains a verification command', () => {
      expect(verdict([write('src/a.ts'), bash('sed -i s/a/b/ package.json && npm test', { basis: 'person' }), ...pass()])).toBe(false);
    });

    it('does not count when the permission was denied, because nothing ran', () => {
      expect(verdict([write('src/a.ts'), ...pass(), bash('rm -rf build', { basis: 'person', denied: true })])).toBe(true);
    });

    it('counts a reconciled call whose effect is unknown', () => {
      expect(verdict([reconciled(edit('rm -rf build'), 'unknown'), ...pass()])).toBe(false);
      expect(verdict([reconciled(edit('rm -rf build'), 'already_applied'), ...pass()])).toBe(false);
      expect(verdict([write('src/a.ts'), ...pass(), reconciled(edit('rm -rf build'), 'not_applied')])).toBe(true);
    });
  });

  it('verifies nothing with no declared condition', () => {
    expect(isVerifiedSuccess({ status: 'COMPLETED', events: journal([], [write('src/a.ts')]), commands: [], manifests: [] })).toBe(false);
  });
});
