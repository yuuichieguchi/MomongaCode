import { describe, expect, it } from 'vitest';
import { createMover } from '../../src/handover/mover.ts';
import type { MoveSurface, OwnGeneration } from '../../src/handover/mover.ts';
import { HANDOVER_FORMAT, HANDOVER_RECORD_MAX_BYTES, parseRecord } from '../../src/handover/record.ts';
import type { StreamRecord } from '../../src/handover/record.ts';
import type { ReplaceTarget } from '../../src/handover/replace-process.ts';
import { handoverFailedText, recordTooLargeText, restartingText, restoreRefusedText } from '../../src/handover/texts.ts';

const FILE = '/home/u/.momonga/run/handover/session-1.json';

const recordFor = (toVersion: string, text = ''): StreamRecord => ({ format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion, session: 'session-1', lastSeq: { 'run-1': 4 }, kind: 'attach', runId: `run-1${text}`, output: 'text', verbose: false });

const KEPT = { kind: 'run', runId: 'run-1' } as const;

type Faults = { write?: Error; replace?: Error; quietAfterSuspend?: boolean };

const setup = (faults: Faults & { announceRestart?: (text: string) => void } = {}) => {
  const log: string[] = [];
  const written: { file: string; text: string }[] = [];
  const targets: ReplaceTarget[] = [];
  const said: string[] = [];
  const state = { quiet: true, padding: '', file: FILE as string | undefined };
  const asked: OwnGeneration[] = [];
  const mover = createMover({
    version: '1.2.3',
    parties: async () => ({ writer: 4242, reader: 4242, namespace: 'single' }),
    write: (file, text) => {
      log.push('write');
      if (faults.write !== undefined) throw faults.write;
      written.push({ file, text });
    },
    remove: () => {
      log.push('remove');
    },
    handOver: () => {
      log.push('hand over');
    },
    target: (recordFile, terminal) => ({ file: '/opt/momonga', args: ['--handover', recordFile], env: terminal === undefined ? {} : { MOMONGA_HANDOVER_TERMINAL: JSON.stringify(terminal) } }),
    replace: (target, hooks) => {
      log.push('replace');
      targets.push(target);
      if (faults.replace !== undefined) return Promise.reject(faults.replace);
      hooks.release();
      hooks.relayed(5151);
      return new Promise(() => undefined);
    },
  });
  const surface: MoveSurface = {
    surface: 'cli',
    kept: () => KEPT,
    recordFile: () => state.file,
    quiet: (own) => {
      asked.push(own);
      return state.quiet;
    },
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
    ...(faults.announceRestart === undefined ? {} : { announceRestart: faults.announceRestart }),
  };
  mover.attach(surface);
  return { mover, log, written, targets, said, state, asked };
};

const MOVE = ['snapshot', 'suspend', 'snapshot', 'write', 'say', 'replace', 'release', 'write', 'hand over'];

const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

describe('the texts of section 7 and 16.4', () => {
  it('are the texts of the design', () => {
    expect(restartingText('1.2.4')).toBe('Restarting into momonga v1.2.4. Your session and unsent input are kept.');
    expect(handoverFailedText('tui', { toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'disk full', kept: { kind: 'sessions', sessionIds: ['session-1'] } })).toBe(
      'Could not restart into v1.2.4 (disk full). This session stays on v1.2.3 and keeps working until that version finishes its runs. Your runs keep going; open them with `momonga --resume session-1`. Your unsent input is still in the prompt.',
    );
    expect(recordTooLargeText({ toVersion: '1.2.4', fromVersion: '1.2.3' })).toBe(
      'Could not restart into v1.2.4: the unsent input and notes are larger than 1 MiB. This session stays on v1.2.3; send or clear the input and it will restart.',
    );
    expect(restoreRefusedText({ reason: 'the record is not JSON', kept: { kind: 'unnamed' } })).toBe('Could not restore the session (the record is not JSON). Your work is kept: run `momonga --resume`.');
  });
});

describe('a session client moves at a quiet point (16.5, 16.8)', () => {
  it('writes the record and replaces the process in one step, the mode set travelling in the environment', async () => {
    const { mover, log, written, targets, said } = setup();
    void mover.learned('1.2.4', 'live');
    await settled();
    expect(log).toEqual(MOVE);
    expect(said).toEqual([restartingText('1.2.4')]);
    expect(written.map((entry) => entry.file)).toEqual([FILE, FILE]);
    for (const entry of written) expect(parseRecord(entry.text)).toEqual({ kind: 'record', record: recordFor('1.2.4') });
    expect(targets).toEqual([{ file: '/opt/momonga', args: ['--handover', FILE], env: { MOMONGA_HANDOVER_TERMINAL: '{"screen":"fullscreen","modes":["alt-screen","kitty-keys"]}' } }]);
  });

  it('asks the surface whether it is quiet for a generation of its own that is live or gone, and a gone generation stays gone (P-308)', async () => {
    const { mover, asked, state } = setup();
    state.quiet = false;
    await mover.learned('1.2.4', 'live');
    await mover.check();
    await mover.learned('1.2.4', 'gone');
    await mover.learned('1.2.4', 'live');
    await mover.check();
    expect(asked).toEqual(['live', 'live', 'gone', 'gone', 'gone']);
  });

  it('does not move for its own version, an older one or one it cannot order', async () => {
    const { mover, log } = setup();
    await mover.learned('1.2.3', 'live');
    await mover.learned('1.2.2', 'live');
    await mover.learned('nightly', 'live');
    await mover.check();
    expect(log).toEqual([]);
  });

  it('does not move while something is pending, and moves at the event that ends it (red tests 12 and 28)', async () => {
    const { mover, log, state } = setup();
    state.quiet = false;
    await mover.learned('1.2.4', 'live');
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
    await mover.learned('1.2.4', 'live');
    expect(log).toEqual([]);
  });

  it('goes back to waiting when the quiet point ended while it prepared', async () => {
    const { mover, log, state } = setup({ quietAfterSuspend: false });
    await mover.learned('1.2.4', 'live');
    expect(log).toEqual(['snapshot', 'suspend', 'resume']);
    state.quiet = true;
    await mover.check();
    expect(log).toEqual(['snapshot', 'suspend', 'resume', 'snapshot', 'suspend', 'resume']);
  });

  it('makes one attempt at a time', async () => {
    const { mover, log } = setup();
    void mover.learned('1.2.4', 'live');
    void mover.check();
    void mover.check();
    await settled();
    expect(log.filter((step) => step === 'replace')).toHaveLength(1);
  });
});

describe('a move that fails (16.4, M4)', () => {
  it('stays and says why when the record cannot be written, and the next check tries the same version again (red test 15)', async () => {
    const { mover, log, said } = setup({ write: new Error('ENOSPC: no space left on device') });
    await mover.learned('1.2.4', 'live');
    expect(log).toEqual(['snapshot', 'suspend', 'snapshot', 'write', 'resume', 'say']);
    expect(said.at(-1)).toBe(handoverFailedText('cli', { toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'ENOSPC: no space left on device', kept: KEPT }));
    await mover.check();
    expect(log.filter((step) => step === 'write')).toHaveLength(2);
  });

  it('says a write failure once per version and reason: again only for another reason or a newer version', async () => {
    const faults: Faults = { write: Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) };
    const { mover, log, said } = setup(faults);
    await mover.learned('1.2.4', 'live');
    await mover.check();
    expect(log.filter((step) => step === 'write')).toHaveLength(2);
    expect(said.filter((text) => text.startsWith('Could not restart'))).toHaveLength(1);
    faults.write = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    await mover.check();
    expect(said.filter((text) => text.startsWith('Could not restart'))).toHaveLength(2);
    faults.write = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    await mover.learned('1.2.5', 'live');
    expect(said.filter((text) => text.startsWith('Could not restart'))).toHaveLength(3);
  });

  it('a write failure is not a refusal: a later check after the fault cleared moves to that version', async () => {
    const faults: Faults = { write: new Error('the lock of the record is held by another process') };
    const { mover, log, targets } = setup(faults);
    await mover.learned('1.2.4', 'live');
    delete faults.write;
    void mover.check();
    await settled();
    expect(log.filter((step) => step === 'replace')).toHaveLength(1);
    expect(targets).toHaveLength(1);
  });

  it('names the relayed child as the reader of the record, under the hold, and only then hands the hold over', async () => {
    const { mover, log, written } = setup();
    void mover.learned('1.2.4', 'live');
    await settled();
    expect(log.slice(-4)).toEqual(['replace', 'release', 'write', 'hand over']);
    expect(written.map(({ text }): unknown => JSON.parse(text))).toEqual([
      expect.objectContaining({ pid: 4242, reader: 4242, namespace: 'single' }),
      expect.objectContaining({ pid: 4242, reader: 5151, namespace: 'single' }),
    ]);
  });

  it('stays, removes the record, says why and makes one attempt when the exec fails (red test 16)', async () => {
    const { mover, log, said } = setup({ replace: new Error('execve EACCES') });
    await mover.learned('1.2.4', 'live');
    expect(log).toEqual(['snapshot', 'suspend', 'snapshot', 'write', 'say', 'replace', 'remove', 'resume', 'say']);
    expect(said.at(-1)).toBe(handoverFailedText('cli', { toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'execve EACCES', kept: KEPT }));
    await mover.check();
    expect(log.filter((step) => step === 'replace')).toHaveLength(1);
  });

  it('uses announceRestart instead of say before replace when provided, keeping failure reporting on say', async () => {
    const announced: string[] = [];
    const { mover, said } = setup({ replace: new Error('execve EACCES'), announceRestart: (text) => announced.push(text) });
    await mover.learned('1.2.4', 'live');
    expect(announced).toEqual([restartingText('1.2.4')]);
    expect(said).toEqual([handoverFailedText('cli', { toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'execve EACCES', kept: KEPT })]);

    const silent = setup({ announceRestart: () => undefined });
    void silent.mover.learned('1.2.4', 'live');
    await settled();
    expect(silent.said).toEqual([]);
  });

  it('does not move while the record is larger than 1 MiB, says so once, and moves when it fits (red test 18)', async () => {
    const { mover, log, said, state } = setup();
    state.padding = 'x'.repeat(HANDOVER_RECORD_MAX_BYTES);
    await mover.learned('1.2.4', 'live');
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
    await mover.learned('1.2.4', 'live');
    expect(log).toEqual(['say']);
    expect(said).toEqual([handoverFailedText('cli', { toVersion: '1.2.4', fromVersion: '1.2.3', reason: 'the installed program is still v1.2.3', kept: KEPT })]);
  });
});

describe('whether a session that learned of a newer generation moves by itself (ruling 6)', () => {
  it('moves at its quiet point while something is pending on an open session', async () => {
    const { mover, state } = setup();
    state.quiet = false;
    await mover.learned('1.2.4', 'gone');
    expect(mover.standing('1.2.4')).toBe('moves-at-quiet-point');
  });

  it('cannot move before a session is open', async () => {
    const { mover, state } = setup();
    state.file = undefined;
    await mover.learned('1.2.4', 'gone');
    expect(mover.standing('1.2.4')).toBe('cannot-move');
  });

  it('cannot move with no surface attached', async () => {
    const mover = createMover({
      version: '1.2.3',
      parties: async () => ({ writer: 1, reader: 1, namespace: 'single' }),
      write: () => undefined,
      remove: () => undefined,
      handOver: () => undefined,
      target: () => ({ file: '/opt/momonga', args: [], env: {} }),
      replace: () => new Promise(() => undefined),
    });
    await mover.learned('1.2.4', 'gone');
    expect(mover.standing('1.2.4')).toBe('cannot-move');
  });

  it('cannot move once the exec for that version failed', async () => {
    const { mover } = setup({ replace: new Error('execve EACCES') });
    await mover.learned('1.2.4', 'gone');
    expect(mover.standing('1.2.4')).toBe('cannot-move');
  });

  it('cannot move to a version the installed program refused', async () => {
    const { mover } = setup();
    mover.refuse('1.2.4', 'the installed program is still v1.2.3');
    await mover.learned('1.2.4', 'gone');
    expect(mover.standing('1.2.4')).toBe('cannot-move');
  });

  it('still moves after a record write failure or a record too large, at the next quiet point', async () => {
    const failing = setup({ write: new Error('disk full') });
    await failing.mover.learned('1.2.4', 'gone');
    expect(failing.mover.standing('1.2.4')).toBe('moves-at-quiet-point');
    const large = setup();
    large.state.padding = 'x'.repeat(HANDOVER_RECORD_MAX_BYTES);
    await large.mover.learned('1.2.4', 'gone');
    expect(large.mover.standing('1.2.4')).toBe('moves-at-quiet-point');
  });
});
