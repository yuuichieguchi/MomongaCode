import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, SocketPathUnsupportedError, beginGenerationStart, ensureMomongaDirs, generationLayout, hostKernelLock, momongaPaths, shortTempBase, socketPathLimit } from '@momonga/foundation';

const SUPERVISOR_SOCKET_SUFFIX = Buffer.byteLength(path.join('.momonga', 'run', `g${FIRST_GENERATION}`, 'supervisor.sock')) + 1;

const homeWhoseFirstSupervisorSocketIs = (byteLength: number): string => {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(shortTempBase(process.platform), 'mm-fit-')));
  const nameLength = byteLength - SUPERVISOR_SOCKET_SUFFIX - Buffer.byteLength(parent) - 1;
  return path.join(parent, 'h'.repeat(nameLength));
};

describe.skipIf(process.platform === 'win32')('the start of a generation measures its sockets by a bind in run/ (20.19)', () => {
  it('refuses the first generation of a home whose supervisor socket passes the limit with SocketPathUnsupportedError, and consumes no number', async () => {
    const limit = socketPathLimit(process.platform);
    const home = homeWhoseFirstSupervisorSocketIs(limit + 1);
    try {
      const supervisorSocket = generationLayout(home, FIRST_GENERATION).sockets.supervisor;
      expect(Buffer.byteLength(supervisorSocket)).toBe(limit + 1);
      const paths = momongaPaths(home, process.platform, {});
      await ensureMomongaDirs(paths);
      const error = await beginGenerationStart(paths, { version: '1.2.3', foldVersion: 1, lock: hostKernelLock() }).catch((caught: unknown) => caught);
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

  it('starts the first generation of a home whose supervisor socket is exactly at the limit minus one', async () => {
    const limit = socketPathLimit(process.platform);
    const home = homeWhoseFirstSupervisorSocketIs(limit - 1);
    try {
      const paths = momongaPaths(home, process.platform, {});
      await ensureMomongaDirs(paths);
      const outcome = await beginGenerationStart(paths, { version: '1.2.3', foldVersion: 1, lock: hostKernelLock() });
      expect(outcome).toMatchObject({ kind: 'allocated', generation: FIRST_GENERATION });
      if (outcome.kind === 'allocated') outcome.starting.release();
    } finally {
      fs.rmSync(path.dirname(home), { recursive: true, force: true });
    }
  });
});
