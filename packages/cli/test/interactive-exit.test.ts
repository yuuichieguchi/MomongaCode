import { describe, expect, it } from 'vitest';
import { UpdateError } from '../src/update/errors.ts';
import { exitCodeOf } from '../src/tui/run-interactive.tsx';

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
