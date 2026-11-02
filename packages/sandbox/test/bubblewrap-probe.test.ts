import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BWRAP_PROBE_ARGUMENTS, DEFAULT_BWRAP_PATH, probeBubblewrap } from '@momonga/sandbox';

const HAS_BWRAP = process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH);
const BLOCKED = process.env['MOMONGA_BWRAP_BLOCKED'] === '1';

describe('probeBubblewrap', () => {
  it('runs one command with the namespaces, the proc mount and the dev mount that every sandboxed command uses', () => {
    const seen: Array<{ file: string; args: readonly string[] }> = [];
    const result = probeBubblewrap('/opt/bwrap', (file, args) => {
      seen.push({ file, args });
      return { status: 0, stderr: '' };
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ file: '/opt/bwrap', args: BWRAP_PROBE_ARGUMENTS }]);
    for (const argument of ['--unshare-pid', '--unshare-ipc', '--unshare-net', '--proc', '--dev']) expect(BWRAP_PROBE_ARGUMENTS).toContain(argument);
  });

  it('returns the stderr of bwrap when it exits with a failure', () => {
    expect(probeBubblewrap('/opt/bwrap', () => ({ status: 1, stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted\n" }))).toEqual({
      ok: false,
      stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
    });
  });

  it('treats a death by signal as a failure and says so', () => {
    expect(probeBubblewrap('/opt/bwrap', () => ({ status: null, stderr: '' }))).toEqual({ ok: false, stderr: 'bwrap ended without an exit status' });
  });

  it.runIf(HAS_BWRAP && !BLOCKED)('succeeds with the real bwrap in a container that allows it', () => {
    expect(probeBubblewrap(DEFAULT_BWRAP_PATH)).toEqual({ ok: true });
  });

  it.runIf(HAS_BWRAP && BLOCKED)('fails with the real bwrap in a container started without systempaths=unconfined, and gives bwrap own message', () => {
    const result = probeBubblewrap(DEFAULT_BWRAP_PATH);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.stderr).toMatch(/proc|Operation not permitted|Permission denied/);
  });
});
