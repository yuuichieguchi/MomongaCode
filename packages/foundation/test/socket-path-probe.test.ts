import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, SocketPathUnmeasuredError, assertUnixSocketPathFits, createSocketPathProbe, generationLayout, momongaPaths, refuseUnfitGenerationSocketsBeforeCreation, setSocketBind } from '@momonga/foundation';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`bind failed: ${code}`), { code });

const recordingBind = (failure: (attempt: number) => NodeJS.ErrnoException | undefined = () => undefined) => {
  const bound: string[] = [];
  const bind = async (socketPath: string): Promise<void> => {
    bound.push(socketPath);
    const error = failure(bound.length);
    if (error !== undefined) throw error;
  };
  return { bind, bound };
};

const DIRECTORY = '/var/run/momonga-probe-target';
const INTENDED = path.join(DIRECTORY, `${'s'.repeat(80)}.sock`);

describe('socket path limit by measurement (B12)', () => {
  it('binds a different test path of the intended byte length in the target directory', async () => {
    const { bind, bound } = recordingBind();
    const result = await createSocketPathProbe(bind)(INTENDED);
    expect(result.kind).toBe('supported');
    expect(bound).toHaveLength(1);
    const probePath = bound[0] as string;
    expect(path.dirname(probePath)).toBe(DIRECTORY);
    expect(Buffer.byteLength(probePath)).toBe(Buffer.byteLength(INTENDED));
    expect(probePath).not.toBe(INTENDED);
  });

  it('matches the intended length in bytes, not characters', async () => {
    const { bind, bound } = recordingBind();
    const intended = path.join(DIRECTORY, `${'é'.repeat(30)}.sock`);
    await createSocketPathProbe(bind)(intended);
    expect(Buffer.byteLength(bound[0] as string)).toBe(Buffer.byteLength(intended));
  });

  it.each(['ENAMETOOLONG', 'EINVAL'])('reports the kernel refusal %s as unsupported, naming the errno and the length', async (code) => {
    const { bind } = recordingBind(() => errno(code));
    const result = await createSocketPathProbe(bind)(INTENDED);
    expect(result.kind).toBe('unsupported');
    expect(result.evidence).toContain(code);
    expect(result.evidence).toContain(String(Buffer.byteLength(INTENDED)));
  });

  it('measures once per directory and length and answers again from the cache', async () => {
    const { bind, bound } = recordingBind((attempt) => (attempt === 1 ? errno('ENAMETOOLONG') : undefined));
    const probe = createSocketPathProbe(bind);
    expect((await probe(INTENDED)).kind).toBe('unsupported');
    expect((await probe(INTENDED)).kind).toBe('unsupported');
    expect(bound).toHaveLength(1);
  });

  it('measures again for a different directory', async () => {
    const { bind, bound } = recordingBind();
    const probe = createSocketPathProbe(bind);
    await probe(INTENDED);
    const other = path.join('/var/run/momonga-probe-other', path.basename(INTENDED));
    await probe(other);
    expect(bound).toHaveLength(2);
    expect(path.dirname(bound[1] as string)).toBe('/var/run/momonga-probe-other');
  });

  it.each(['EACCES', 'ENOENT'])('answers unmeasured when bind fails with %s for another reason, and does not cache it', async (code) => {
    const { bind, bound } = recordingBind(() => errno(code));
    const probe = createSocketPathProbe(bind);
    const first = await probe(INTENDED);
    expect(first.kind).toBe('unmeasured');
    expect(first.evidence).toContain(code);
    expect((await probe(INTENDED)).kind).toBe('unmeasured');
    expect(bound).toHaveLength(2);
  });
});

describe('a socket path is used only when its bind measurement succeeded (20.19, 20.58)', () => {
  const homeOf = (): string => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-socket-fit-')));

  it('refuses a path the bind could not measure with the designed text, before any generation exists', async () => {
    const home = homeOf();
    try {
      const paths = momongaPaths(home, 'darwin', {});
      setSocketBind(async () => {
        throw errno('EACCES');
      });
      const error = await refuseUnfitGenerationSocketsBeforeCreation(paths, FIRST_GENERATION).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SocketPathUnmeasuredError);
      const longest = generationLayout(home, FIRST_GENERATION).sockets.supervisor;
      expect((error as Error).message).toBe(`Unix socket path ${longest}: a socket path of ${Buffer.byteLength(longest)} bytes could not be tested in ${paths.run}: EACCES`);
    } finally {
      setSocketBind(undefined);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses an unmeasured path in assertUnixSocketPathFits and gives a measured one back', async () => {
    const socketPath = path.join(DIRECTORY, 'fits.sock');
    try {
      setSocketBind(async () => {
        throw errno('ENOENT');
      });
      await expect(assertUnixSocketPathFits(socketPath)).rejects.toBeInstanceOf(SocketPathUnmeasuredError);
      setSocketBind(async () => undefined);
      await expect(assertUnixSocketPathFits(socketPath)).resolves.toBeUndefined();
    } finally {
      setSocketBind(undefined);
    }
  });
});
