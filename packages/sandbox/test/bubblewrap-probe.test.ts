import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BWRAP_PROBE_TIMEOUT_MS, DEFAULT_BWRAP_PATH, SANDBOX_STOP_BOUND_MS, bwrapProbeArguments, probeBubblewrap } from '@momonga/sandbox';

const HAS_BWRAP = process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH);
const BLOCKED = process.env['MOMONGA_BWRAP_BLOCKED'] === '1';
const SHELL = '/bin/bash';
const HANG_TIMEOUT_MS = 300;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const scriptThatHangs = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-probe-'));
  directories.push(directory);
  const file = path.join(directory, 'hang');
  fs.writeFileSync(file, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  return file;
};

describe('probeBubblewrap', () => {
  it('runs one command with the namespaces, the proc mount and the dev mount that every sandboxed command uses, ending in the given shell', () => {
    const seen: Array<{ file: string; args: readonly string[] }> = [];
    const result = probeBubblewrap('/opt/bwrap', SHELL, {
      run: (file, args) => {
        seen.push({ file, args });
        return { status: 0, stderr: '', timedOut: false };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ file: '/opt/bwrap', args: bwrapProbeArguments(SHELL) }]);
    const args = bwrapProbeArguments(SHELL);
    for (const argument of ['--unshare-pid', '--unshare-ipc', '--unshare-net', '--proc', '--dev']) expect(args).toContain(argument);
    expect(args.slice(args.indexOf('--'))).toEqual(['--', SHELL, '-c', ':']);
    expect(args).not.toContain('/bin/true');
  });

  it('takes its time limit from the stop bound of a sandboxed process and hands it to the runner', () => {
    expect(BWRAP_PROBE_TIMEOUT_MS).toBe(SANDBOX_STOP_BOUND_MS);
    const limits: number[] = [];
    probeBubblewrap('/opt/bwrap', SHELL, {
      run: (_file, _args, timeoutMs) => {
        limits.push(timeoutMs);
        return { status: 0, stderr: '', timedOut: false };
      },
    });
    expect(limits).toEqual([BWRAP_PROBE_TIMEOUT_MS]);
  });

  it('returns the stderr of bwrap when it exits with a failure', () => {
    expect(probeBubblewrap('/opt/bwrap', SHELL, { run: () => ({ status: 1, stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted\n", timedOut: false }) })).toEqual({
      ok: false,
      stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
    });
  });

  it('returns the stderr of bwrap when the shell path does not exist', () => {
    const missing = '/nix/store/none/bin/bash';
    expect(probeBubblewrap('/opt/bwrap', missing, { run: () => ({ status: 1, stderr: `bwrap: execvp ${missing}: No such file or directory\n`, timedOut: false }) })).toEqual({
      ok: false,
      stderr: `bwrap: execvp ${missing}: No such file or directory`,
    });
  });

  it('treats a death by signal as a failure and says so', () => {
    expect(probeBubblewrap('/opt/bwrap', SHELL, { run: () => ({ status: null, stderr: '', timedOut: false }) })).toEqual({ ok: false, stderr: 'bwrap ended without an exit status' });
  });

  it('reports a probe that did not finish in time as its own failure', () => {
    expect(probeBubblewrap('/opt/bwrap', SHELL, { timeoutMs: 250, run: () => ({ status: null, stderr: '', timedOut: true }) })).toEqual({
      ok: false,
      stderr: 'bwrap did not finish within 250 ms',
    });
  });

  it.runIf(process.platform !== 'win32')('stops a bwrap that hangs and reports the time limit', () => {
    const started = Date.now();
    const result = probeBubblewrap(scriptThatHangs(), SHELL, { timeoutMs: HANG_TIMEOUT_MS });
    expect(result).toEqual({ ok: false, stderr: `bwrap did not finish within ${HANG_TIMEOUT_MS} ms` });
    expect(Date.now() - started).toBeLessThan(HANG_TIMEOUT_MS * 10);
  });

  it.runIf(HAS_BWRAP && !BLOCKED)('succeeds with the real bwrap in a container that allows it', () => {
    expect(probeBubblewrap(DEFAULT_BWRAP_PATH, SHELL)).toEqual({ ok: true });
  });

  it.runIf(HAS_BWRAP && !BLOCKED)('fails with the real bwrap when the shell path does not exist, and names the path', () => {
    const missing = '/nonexistent/bin/bash';
    const result = probeBubblewrap(DEFAULT_BWRAP_PATH, missing);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.stderr).toContain(missing);
  });

  it.runIf(HAS_BWRAP && !BLOCKED)('stops a real bwrap whose shell hangs and reports the time limit', () => {
    const started = Date.now();
    const result = probeBubblewrap(DEFAULT_BWRAP_PATH, scriptThatHangs(), { timeoutMs: HANG_TIMEOUT_MS });
    expect(result).toEqual({ ok: false, stderr: `bwrap did not finish within ${HANG_TIMEOUT_MS} ms` });
    expect(Date.now() - started).toBeLessThan(HANG_TIMEOUT_MS * 10);
  });

  it.runIf(HAS_BWRAP && BLOCKED)('fails with the real bwrap in a container started without systempaths=unconfined, and gives bwrap own message', () => {
    const result = probeBubblewrap(DEFAULT_BWRAP_PATH, SHELL);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.stderr).toMatch(/proc|Operation not permitted|Permission denied/);
  });
});
