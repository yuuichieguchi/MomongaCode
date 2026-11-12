import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, SocketPathUnsupportedError, beginGenerationStart, ensureMomongaDirs, generationLayout, momongaPaths } from '@momonga/foundation';
import { createTempDir, firstRefusedSocketPathBytes, testKernelLock } from '@momonga/testkit';

const UNIX_ENDPOINTS = { form: 'unix' } as const;

const SUPERVISOR_SOCKET_SUFFIX = Buffer.byteLength(path.join('.momonga', 'run', `g${FIRST_GENERATION}`, 'supervisor.sock')) + 1;

const homeWhoseFirstSupervisorSocketIs = async (fromFirstRefused: number): Promise<{ home: string; byteLength: number }> => {
  const parent = createTempDir({ asHome: true });
  const byteLength = (await firstRefusedSocketPathBytes(parent)) + fromFirstRefused;
  const nameLength = byteLength - SUPERVISOR_SOCKET_SUFFIX - Buffer.byteLength(parent) - 1;
  return { home: path.join(parent, 'h'.repeat(nameLength)), byteLength };
};

describe.skipIf(process.platform === 'win32')('the start of a generation measures its sockets by a bind in run/ (20.19)', () => {
  it('refuses the first generation of a home whose supervisor socket has the first length the host refuses to bind with SocketPathUnsupportedError, and consumes no number', async () => {
    const { home, byteLength } = await homeWhoseFirstSupervisorSocketIs(0);
    try {
      const supervisorSocket = generationLayout(home, FIRST_GENERATION).sockets.supervisor;
      expect(Buffer.byteLength(supervisorSocket)).toBe(byteLength);
      const paths = momongaPaths(home, process.platform, {});
      await ensureMomongaDirs(paths);
      const error = await beginGenerationStart(paths, { version: '1.2.3', foldVersion: 1, lock: testKernelLock() , scope: UNIX_ENDPOINTS}).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SocketPathUnsupportedError);
      expect((error as Error).message).toMatch(/^Unix socket path .* must be shorter than \d+ bytes/);
      expect((error as Error).message).toContain(supervisorSocket);
      expect((error as Error).message).toContain(`in ${paths.run} `);
      expect(fs.existsSync(paths.generationCounter)).toBe(false);
      expect(fs.existsSync(generationLayout(home, FIRST_GENERATION).dir)).toBe(false);
    } finally {
      fs.rmSync(path.dirname(home), { recursive: true, force: true });
    }
  });

  it('starts the first generation of a home whose supervisor socket is one byte shorter than the first length the host refuses to bind', async () => {
    const { home } = await homeWhoseFirstSupervisorSocketIs(-1);
    try {
      const paths = momongaPaths(home, process.platform, {});
      await ensureMomongaDirs(paths);
      const outcome = await beginGenerationStart(paths, { version: '1.2.3', foldVersion: 1, lock: testKernelLock() , scope: UNIX_ENDPOINTS});
      expect(outcome).toMatchObject({ kind: 'allocated', generation: FIRST_GENERATION });
      if (outcome.kind === 'allocated') outcome.starting.release();
    } finally {
      fs.rmSync(path.dirname(home), { recursive: true, force: true });
    }
  });
});
