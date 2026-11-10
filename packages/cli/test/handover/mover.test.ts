import { describe, expect, it } from 'vitest';
import { createMover } from '../../src/handover/mover.ts';
import type { MoveSurface } from '../../src/handover/mover.ts';
import { HANDOVER_FORMAT, HANDOVER_RECORD_MAX_BYTES, parseRecord } from '../../src/handover/record.ts';
import type { StreamRecord } from '../../src/handover/record.ts';
import type { ReplaceTarget } from '../../src/handover/replace-process.ts';
import { handoverFailedText, recordTooLargeText, restartingText, restoreRefusedText } from '../../src/handover/texts.ts';

const FILE = '/home/u/.momonga/run/handover/session-1.json';

const recordFor = (toVersion: string, text = ''): StreamRecord => ({ format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion, session: 'session-1', lastSeq: { 'run-1': 4 }, kind: 'attach', runId: `run-1${text}`, output: 'text', verbose: false });

type Faults = { write?: Error; replace?: Error; quietAfterSuspend?: boolean };

const setup = (faults: Faults = {}) => {
  const log: string[] = [];
  const written: { file: string; text: string }[] = [];
  const targets: ReplaceTarget[] = [];
  const said: string[] = [];
  const state = { quiet: true, padding: '', file: FILE as string | undefined };
  const mover = createMover({
    version: '1.2.3',
    pid: 4242,
    write: (file, text) => {
      log.push('write');
      if (faults.write !== undefined) throw faults.write;
      written.push({ file, text });
    },
    remove: () => {
      log.push('remove');
    },
    target: (recordFile, terminal) => ({ file: '/opt/momonga', args: ['--handover', recordFile], env: terminal === undefined ? {} : { MOMONGA_HANDOVER_TERMINAL: JSON.stringify(terminal) } }),
    replace: (target, hooks) => {
      log.push('replace');
      targets.push(target);
      if (faults.replace !== undefined) return Promise.reject(faults.replace);
      hooks.release();
      return new Promise(() => undefined);
    },
  });
  const surface: MoveSurface = {
    recordFile: () => state.file,
    quiet: () => state.quiet,
    snapshot: (toVersion) => {
      log.push('snapshot');
      return recordFor(toVersion, state.padding);
    },
    terminal: () => ({ screen: 'fullscreen', modes: ['alt-screen', 'kitty-keys'] }),
    suspend: async () => {
      log.push('suspend');
      if (faults.quietAfterSuspend === false) state.quiet = false;
    },
    release: () => {
      log.push('release');
    },
    resume: () => {
      log.push('resume');
    },
    say: (text) => {
      log.push('say');
      said.push(text);
    },
  };
  mover.attach(surface);
  return { mover, log, written, targets, said, state };
};

const MOVE = ['snapshot', 'suspend', 'say', 'snapshot', 'write', 'replace', 'release'];

const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

describe('the texts of section 7 and 16.4', () => {
  it('are the texts of the design', () => {
    expect(restartingText('1.2.4')).toBe('Restarting into momonga v1.2.4. Your session and unsent input are kept.');
    expect(handoverFailedText({ toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'disk full', session: 'session-1' })).toBe(
      'Could not restart into v1.2.4 (disk full). This session stays on v1.2.3 and keeps working until that version finishes its tasks. Your tasks keep running; open them with `momonga attach session-1`. Your unsent input is still in the prompt.',
    );
    expect(recordTooLargeText({ toVersion: '1.2.4', fromVersion: '1.2.3' })).toBe(
      'Could not restart into v1.2.4: the unsent input and notes are larger than 1 MiB. This session stays on v1.2.3; send or clear the input and it will restart.',
    );
    expect(restoreRefusedText({ reason: 'the record is not JSON', session: 'session-1' })).toBe('Could not restore the session (the record is not JSON). Your session is kept: run `momonga attach session-1`.');
  });
});

describe('a session client moves at a quiet point (16.5, 16.8)', () => {
  it('writes the record and replaces the process in one step, the mode set travelling in the environment', async () => {
    const { mover, log, written, targets, said } = setup();
    void mover.learned('1.2.4');
    await settled();
    expect(log).toEqual(MOVE);
    expect(said).toEqual([restartingText('1.2.4')]);
    expect(written.map((entry) => entry.file)).toEqual([FILE]);
    expect(parseRecord(written[0]?.text ?? '')).toEqual({ kind: 'record', record: recordFor('1.2.4') });
    expect(targets).toEqual([{ file: '/opt/momonga', args: ['--handover', FILE], env: { MOMONGA_HANDOVER_TERMINAL: '{"screen":"fullscreen","modes":["alt-screen","kitty-keys"]}' } }]);
  });

  it('does not move for its own version, an older one or one it cannot order', async () => {
    const { mover, log } = setup();
    await mover.learned('1.2.3');
    await mover.learned('1.2.2');
    await mover.learned('nightly');
    await mover.check();
    expect(log).toEqual([]);
  });

  it('does not move while something is pending, and moves at the event that ends it (red tests 12 and 28)', async () => {
    const { mover, log, state } = setup();
    state.quiet = false;
    await mover.learned('1.2.4');
    await mover.check();
    expect(log).toEqual([]);
    state.quiet = true;
    void mover.check();
    await settled();
    expect(log).toEqual(MOVE);
  });

  it('does not move before a session is open', async () => {
    const { mover, log, state } = setup();
    state.file = undefined;
    await mover.learned('1.2.4');
    expect(log).toEqual([]);
  });

  it('goes back to waiting when the quiet point ended while it prepared', async () => {
    const { mover, log, state } = setup({ quietAfterSuspend: false });
    await mover.learned('1.2.4');
    expect(log).toEqual(['snapshot', 'suspend', 'resume']);
    state.quiet = true;
    await mover.check();
    expect(log).toEqual(['snapshot', 'suspend', 'resume', 'snapshot', 'suspend', 'resume']);
  });

  it('makes one attempt at a time', async () => {
    const { mover, log } = setup();
    void mover.learned('1.2.4');
    void mover.check();
    void mover.check();
    await settled();
    expect(log.filter((step) => step === 'replace')).toHaveLength(1);
  });
});

describe('a move that fails (16.4, M4)', () => {
  it('stays, says why and makes one attempt per newer generation when the record cannot be written (red test 15)', async () => {
    const { mover, log, said } = setup({ write: new Error('ENOSPC: no space left on device') });
    await mover.learned('1.2.4');
    expect(log).toEqual(['snapshot', 'suspend', 'say', 'snapshot', 'write', 'resume', 'say']);
    expect(said.at(-1)).toBe(handoverFailedText({ toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'ENOSPC: no space left on device', session: 'session-1' }));
    await mover.check();
    await mover.learned('1.2.4');
    expect(log.filter((step) => step === 'write')).toHaveLength(1);
    await mover.learned('1.2.5');
    expect(log.filter((step) => step === 'write')).toHaveLength(2);
  });

  it('stays, removes the record, says why and makes one attempt when the exec fails (red test 16)', async () => {
    const { mover, log, said } = setup({ replace: new Error('execve EACCES') });
    await mover.learned('1.2.4');
    expect(log).toEqual(['snapshot', 'suspend', 'say', 'snapshot', 'write', 'replace', 'remove', 'resume', 'say']);
    expect(said.at(-1)).toBe(handoverFailedText({ toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'execve EACCES', session: 'session-1' }));
    await mover.check();
    expect(log.filter((step) => step === 'replace')).toHaveLength(1);
  });

  it('does not move while the record is larger than 1 MiB, says so once, and moves when it fits (red test 18)', async () => {
    const { mover, log, said, state } = setup();
    state.padding = 'x'.repeat(HANDOVER_RECORD_MAX_BYTES);
    await mover.learned('1.2.4');
    await mover.check();
    await mover.check();
    expect(log).toEqual(['snapshot', 'say', 'snapshot', 'snapshot']);
    expect(said).toEqual([recordTooLargeText({ toVersion: '1.2.4', fromVersion: '1.2.3' })]);
    state.padding = '';
    void mover.check();
    await settled();
    expect(log.slice(4)).toEqual(MOVE);
  });

  it('is told that the installed program is not the newer version, and does not try that generation', async () => {
    const { mover, log, said } = setup();
    mover.refuse('1.2.4', 'the installed program is still v1.2.3');
    await mover.learned('1.2.4');
    expect(log).toEqual(['say']);
    expect(said).toEqual([handoverFailedText({ toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'the installed program is still v1.2.3', session: 'session-1' })]);
  });
});
