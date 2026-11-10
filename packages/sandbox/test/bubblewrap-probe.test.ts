import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BWRAP_PATH, bwrapProbeArguments, probeBubblewrap } from '@momonga/sandbox';
import type { ProbeRunner } from '@momonga/sandbox';

const HAS_BWRAP = process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH);
const BLOCKED = process.env['MOMONGA_BWRAP_BLOCKED'] === '1';
const SHELL = '/bin/bash';
const HANG_ABORT_AFTER_MS = 300;

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

const neverAborted = (): AbortSignal => new AbortController().signal;

const answering = (status: number | null, stderr: string): ProbeRunner => async () => ({ status, stderr });

const abortedAfterStart = (): AbortSignal => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), HANG_ABORT_AFTER_MS);
  return controller.signal;
};

describe('probeBubblewrap', () => {
  it('runs one command with the namespaces, the proc mount and the dev mount that every sandboxed command uses, ending in the given shell', async () => {
    const seen: Array<{ file: string; args: readonly string[] }> = [];
    const result = await probeBubblewrap('/opt/bwrap', SHELL, {
      signal: neverAborted(),
      run: async (file, args) => {
        seen.push({ file, args });
        return { status: 0, stderr: '' };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ file: '/opt/bwrap', args: bwrapProbeArguments(SHELL) }]);
    const args = bwrapProbeArguments(SHELL);
    for (const argument of ['--unshare-pid', '--unshare-ipc', '--unshare-net', '--proc', '--dev']) expect(args).toContain(argument);
    expect(args.slice(args.indexOf('--'))).toEqual(['--', SHELL, '-c', ':']);
    expect(args).not.toContain('/bin/true');
  });

  it('runs under the signal of the caller that derives the sandbox, with no time limit of its own', async () => {
    const signal = neverAborted();
    const given: AbortSignal[] = [];
    await probeBubblewrap('/opt/bwrap', SHELL, {
      signal,
      run: async (_file, _args, runSignal) => {
        given.push(runSignal);
        return { status: 0, stderr: '' };
      },
    });
    expect(given[0]).toBe(signal);
  });

  it('returns the stderr of bwrap when it exits with a failure', async () => {
    expect(await probeBubblewrap('/opt/bwrap', SHELL, { signal: neverAborted(), run: answering(1, "bwrap: Can't mount proc on /newroot/proc: Operation not permitted\n") })).toEqual({
      ok: false,
      stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
    });
  });

  it('returns the stderr of bwrap when the shell path does not exist', async () => {
    const missing = '/nix/store/none/bin/bash';
    expect(await probeBubblewrap('/opt/bwrap', missing, { signal: neverAborted(), run: answering(1, `bwrap: execvp ${missing}: No such file or directory\n`) })).toEqual({
      ok: false,
      stderr: `bwrap: execvp ${missing}: No such file or directory`,
    });
  });

  it('treats a death by signal as a failure and says so', async () => {
    expect(await probeBubblewrap('/opt/bwrap', SHELL, { signal: neverAborted(), run: answering(null, '') })).toEqual({ ok: false, stderr: 'bwrap ended without an exit status' });
  });

  it.runIf(process.platform !== 'win32')('stops a bwrap that hangs when the caller aborts, and rejects with the abort', async () => {
    const started = Date.now();
    await expect(probeBubblewrap(scriptThatHangs(), SHELL, { signal: abortedAfterStart() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(HANG_ABORT_AFTER_MS * 10);
  });

  it.runIf(HAS_BWRAP && !BLOCKED)('succeeds with the real bwrap in a container that allows it', async () => {
    expect(await probeBubblewrap(DEFAULT_BWRAP_PATH, SHELL, { signal: neverAborted() })).toEqual({ ok: true });
  });

  it.runIf(HAS_BWRAP && !BLOCKED)('fails with the real bwrap when the shell path does not exist, and names the path', async () => {
    const missing = '/nonexistent/bin/bash';
    const result = await probeBubblewrap(DEFAULT_BWRAP_PATH, missing, { signal: neverAborted() });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.stderr).toContain(missing);
  });

  it.runIf(HAS_BWRAP && !BLOCKED)('stops a real bwrap whose shell hangs when the caller aborts', async () => {
    const started = Date.now();
    await expect(probeBubblewrap(DEFAULT_BWRAP_PATH, scriptThatHangs(), { signal: abortedAfterStart() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(HANG_ABORT_AFTER_MS * 10);
  });

  it.runIf(HAS_BWRAP && BLOCKED)('fails with the real bwrap in a container started without systempaths=unconfined, and gives bwrap own message', async () => {
    const result = await probeBubblewrap(DEFAULT_BWRAP_PATH, SHELL, { signal: neverAborted() });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.stderr).toMatch(/proc|Operation not permitted|Permission denied/);
  });
});
