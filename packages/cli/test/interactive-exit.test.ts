import { describe, expect, it } from 'vitest';
import { UpdateError } from '../src/update/errors.ts';
import { exitCodeOf, writeReopenLine } from '../src/tui/run-interactive.tsx';

describe('exitCodeOf', () => {
  it('exits 0 and prints nothing when the session ended without an error', () => {
    const written: string[] = [];

    expect(exitCodeOf({ stderr: { write: (text) => void written.push(text) } }, {})).toBe(0);
    expect(written).toEqual([]);
  });

  it('prints the detail and the remedy of a failure the way every other command does', () => {
    const written: string[] = [];
    const error = new UpdateError('download_failed', 'downloading failed', { detail: 'https://example.test/x', remediation: 'try again later' });

    expect(exitCodeOf({ stderr: { write: (text) => void written.push(text) } }, { error })).toBe(1);
    expect(written.join('')).toBe('momonga: downloading failed\n  detail: https://example.test/x\n  remedy: try again later\n');
  });
});

describe('the exit line (9.3)', () => {
  it('writes exactly the reopen command and a newline for a session with a run', () => {
    const written: string[] = [];

    writeReopenLine({ stdout: { write: (text) => void written.push(text) } }, { reopen: '0123456789abcdef' });
    expect(written).toEqual(['momonga --resume 0123456789abcdef\n']);
  });

  it('writes nothing for a session with no run', () => {
    const written: string[] = [];

    writeReopenLine({ stdout: { write: (text) => void written.push(text) } }, {});
    expect(written).toEqual([]);
  });

  it('follows the error line on a failure exit', () => {
    const written: string[] = [];
    const outcome = { error: new Error('the daemon stopped'), reopen: '0123456789abcdef' };

    exitCodeOf({ stderr: { write: (text) => void written.push(`err:${text}`) } }, outcome);
    writeReopenLine({ stdout: { write: (text) => void written.push(`out:${text}`) } }, outcome);
    expect(written).toEqual(['err:momonga: the daemon stopped\n', 'out:momonga --resume 0123456789abcdef\n']);
  });
});
