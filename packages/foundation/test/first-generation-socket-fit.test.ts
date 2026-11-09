import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, SocketPathUnsupportedError, ensureMomongaDirs, generationLayout, momongaPaths, shortTempBase, socketPathLimit } from '@momonga/foundation';

const SUPERVISOR_SOCKET_SUFFIX = Buffer.byteLength(path.join('.momonga', 'run', `g${FIRST_GENERATION}`, 'supervisor.sock')) + 1;

const homeWhoseFirstSupervisorSocketIs = (byteLength: number): string => {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(shortTempBase(process.platform), 'mm-fit-')));
  const nameLength = byteLength - SUPERVISOR_SOCKET_SUFFIX - Buffer.byteLength(parent) - 1;
  return path.join(parent, 'h'.repeat(nameLength));
};

describe.skipIf(process.platform === 'win32')('resolving the paths of a home measures the first generation sockets', () => {
  it('refuses a home whose first generation supervisor socket passes the limit with SocketPathUnsupportedError, before any directory is created', async () => {
    const limit = socketPathLimit(process.platform);
    const home = homeWhoseFirstSupervisorSocketIs(limit + 1);
    try {
      const supervisorSocket = generationLayout(home, FIRST_GENERATION).sockets.supervisor;
      expect(Buffer.byteLength(supervisorSocket)).toBe(limit + 1);
      const error = await ensureMomongaDirs(momongaPaths(home, process.platform, {})).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SocketPathUnsupportedError);
      expect((error as Error).message).toMatch(/^Unix socket path .* must be shorter than \d+ bytes/);
      expect((error as Error).message).toContain(generationLayout(home, FIRST_GENERATION).dir);
      expect(fs.existsSync(home)).toBe(false);
    } finally {
      fs.rmSync(path.dirname(home), { recursive: true, force: true });
    }
  });

  it('refuses the home the old check refused, two hundred bytes long, in the same way', async () => {
    const home = `/${'h'.repeat(200)}`;
    const error = await ensureMomongaDirs(momongaPaths(home, process.platform, {})).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SocketPathUnsupportedError);
    expect((error as Error).message).toMatch(/^Unix socket path .* must be shorter than \d+ bytes/);
    expect((error as Error).message).toContain(generationLayout(home, FIRST_GENERATION).dir);
  });
});
