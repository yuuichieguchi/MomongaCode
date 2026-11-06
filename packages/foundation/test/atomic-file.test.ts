import { describe, expect, it } from 'vitest';
import { writeFileAtomically, writeFileAtomicallySync } from '@momonga/foundation';
import type { AtomicWriteFileSystem, AtomicWriteFileSystemSync, Random } from '@momonga/foundation';

const DIRECTORY = '/state';
const TARGET = `${DIRECTORY}/record.json`;
const MODE = 0o600;

const errnoError = (code: string, message: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: ${message}`), { code });

const fixedRandom = (hexes: readonly string[]): Random => {
  let next = 0;
  return {
    float: () => 0.5,
    bytes: (length) => new Uint8Array(length),
    hex: () => {
      const value = hexes[next % hexes.length] as string;
      next += 1;
      return value;
    },
    uuid: () => '00000000-0000-4000-8000-000000000000',
  };
};

const temporaryOf = (hex: string): string => `${TARGET}.${process.pid}.${hex}.tmp`;

type Recording = AtomicWriteFileSystem &
  AtomicWriteFileSystemSync & {
    readonly ops: string[];
    readonly files: Map<string, Uint8Array>;
    failAt(index: number, error: Error): void;
  };

const recordingFileSystem = (initial: Readonly<Record<string, string>> = {}): Recording => {
  const files = new Map<string, Uint8Array>(Object.entries(initial).map(([file, text]) => [file, new TextEncoder().encode(text)]));
  const directories = new Set<string>([DIRECTORY]);
  const ops: string[] = [];
  let failure: { index: number; error: Error } | undefined;
  let fsOps = 0;
  const step = (op: string): void => {
    const index = fsOps;
    fsOps += 1;
    ops.push(op);
    if (failure !== undefined && failure.index === index) throw failure.error;
  };
  const bytesOf = (content: string | Uint8Array): Uint8Array => (typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content));
  const openFile = (file: string, flags: string, mode: number | undefined): string => {
    if (directories.has(file)) {
      step(`open-directory ${file}`);
      return file;
    }
    if (flags !== 'wx') throw new Error(`unexpected open of ${file} with ${flags}`);
    step(`open-exclusive ${file} ${(mode ?? 0).toString(8)}`);
    if (files.has(file)) throw errnoError('EEXIST', file);
    files.set(file, new Uint8Array());
    return file;
  };
  const writeTo = (file: string, content: string | Uint8Array): void => {
    step(`write ${file}`);
    files.set(file, bytesOf(content));
  };
  const renameFile = (from: string, to: string): void => {
    step(`rename ${from} ${to}`);
    const content = files.get(from);
    if (content === undefined) throw errnoError('ENOENT', from);
    files.set(to, content);
    files.delete(from);
  };
  const linkFile = (from: string, to: string): void => {
    step(`link ${from} ${to}`);
    if (files.has(to)) throw errnoError('EEXIST', to);
    const content = files.get(from);
    if (content === undefined) throw errnoError('ENOENT', from);
    files.set(to, content);
  };
  const removeFile = (file: string): void => {
    ops.push(`rm ${file}`);
    files.delete(file);
  };
  const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    ops,
    files,
    failAt: (index, error) => {
      failure = { index, error };
    },
    open: async (file, flags, mode) => {
      await tick();
      const opened = openFile(file, flags, mode);
      return {
        writeFile: async (content) => {
          await tick();
          writeTo(opened, content);
        },
        sync: async () => {
          await tick();
          step(`fsync ${opened}`);
        },
        close: async () => {
          await tick();
          step(`close ${opened}`);
        },
      };
    },
    rename: async (from, to) => {
      await tick();
      renameFile(from, to);
    },
    link: async (from, to) => {
      await tick();
      linkFile(from, to);
    },
    rm: async (file) => {
      await tick();
      removeFile(file);
    },
    openSync: (file, flags, mode) => openFile(file, flags, mode),
    writeFileSync: (handle, content) => writeTo(handle, content),
    fsyncSync: (handle) => step(`fsync ${handle}`),
    closeSync: (handle) => step(`close ${handle}`),
    renameSync: (from, to) => renameFile(from, to),
    linkSync: (from, to) => linkFile(from, to),
    rmSync: (file) => removeFile(file),
  };
};

type Combination = { publish: 'replace' | 'create'; before: boolean; after: boolean; content: string | Uint8Array; label: string };

const COMBINATIONS: Combination[] = (['replace', 'create'] as const).flatMap((publish) =>
  [false, true].flatMap((before) =>
    [false, true].flatMap((after) =>
      [
        { content: '{"a":1}', kind: 'string' },
        { content: new Uint8Array([1, 2, 3]), kind: 'bytes' },
      ].map(({ content, kind }) => ({ publish, before, after, content, label: `${publish}, beforePublish ${before}, afterPublish ${after}, ${kind}` })),
    ),
  ),
);

const HEX = 'a1b2c3d4e5f6';
const TEMPORARY = temporaryOf(HEX);

const expectedSequence = (combination: Combination): string[] => [
  `open-exclusive ${TEMPORARY} 600`,
  `write ${TEMPORARY}`,
  `fsync ${TEMPORARY}`,
  `close ${TEMPORARY}`,
  ...(combination.before ? ['beforePublish'] : []),
  combination.publish === 'replace' ? `rename ${TEMPORARY} ${TARGET}` : `link ${TEMPORARY} ${TARGET}`,
  ...(combination.after ? ['afterPublish'] : []),
  ...(combination.publish === 'create' ? [`rm ${TEMPORARY}`] : []),
  `open-directory ${DIRECTORY}`,
  `fsync ${DIRECTORY}`,
  `close ${DIRECTORY}`,
];

const asyncOptions = (combination: Combination, ops: string[], fail?: { at: 'beforePublish' | 'afterPublish'; error: Error }) => ({
  mode: MODE,
  publish: combination.publish,
  ...(combination.before
    ? {
        beforePublish: async (): Promise<void> => {
          ops.push('beforePublish');
          if (fail?.at === 'beforePublish') throw fail.error;
        },
      }
    : {}),
  ...(combination.after
    ? {
        afterPublish: async (): Promise<void> => {
          ops.push('afterPublish');
          if (fail?.at === 'afterPublish') throw fail.error;
        },
      }
    : {}),
});

const syncOptions = (combination: Combination, ops: string[]) => ({
  mode: MODE,
  publish: combination.publish,
  ...(combination.before ? { beforePublish: (): void => void ops.push('beforePublish') } : {}),
  ...(combination.after ? { afterPublish: (): void => void ops.push('afterPublish') } : {}),
});

const bytes = (content: string | Uint8Array): Uint8Array => (typeof content === 'string' ? new TextEncoder().encode(content) : content);

const temporaries = (files: Map<string, Uint8Array>): string[] => [...files.keys()].filter((file) => file.endsWith('.tmp'));

describe('writeFileAtomically: P-A1 operation order', () => {
  for (const combination of COMBINATIONS) {
    it(`records the one step list for ${combination.label}`, async () => {
      const fs = recordingFileSystem();
      const result = await writeFileAtomically(fs, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(combination, fs.ops));
      expect(fs.ops).toEqual(expectedSequence(combination));
      expect(fs.files.get(TARGET)).toEqual(bytes(combination.content));
      expect(temporaries(fs.files)).toEqual([]);
      if (combination.publish === 'create') expect(result).toEqual({ created: true });
    });
  }

  it('replaces an existing file when publish is replace', async () => {
    const fs = recordingFileSystem({ [TARGET]: 'old' });
    await writeFileAtomically(fs, fixedRandom([HEX]), TARGET, 'new', { mode: MODE });
    expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe('new');
    expect(fs.ops).toContain(`rename ${TEMPORARY} ${TARGET}`);
  });

  it('create against an existing file returns created false, keeps the winner, skips afterPublish and removes its temporary file', async () => {
    const fs = recordingFileSystem({ [TARGET]: 'winner' });
    const combination: Combination = { publish: 'create', before: true, after: true, content: 'loser', label: '' };
    const result = await writeFileAtomically(fs, fixedRandom([HEX]), TARGET, 'loser', asyncOptions(combination, fs.ops));
    expect(result).toEqual({ created: false });
    expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe('winner');
    expect(fs.ops).toEqual([
      `open-exclusive ${TEMPORARY} 600`,
      `write ${TEMPORARY}`,
      `fsync ${TEMPORARY}`,
      `close ${TEMPORARY}`,
      'beforePublish',
      `link ${TEMPORARY} ${TARGET}`,
      `rm ${TEMPORARY}`,
      `open-directory ${DIRECTORY}`,
      `fsync ${DIRECTORY}`,
      `close ${DIRECTORY}`,
    ]);
    expect(temporaries(fs.files)).toEqual([]);
  });
});

describe('writeFileAtomically: no temporary file remains after a failure at any step', () => {
  for (const combination of COMBINATIONS) {
    const fsSteps = expectedSequence(combination).filter((op) => op !== 'beforePublish' && op !== 'afterPublish' && !op.startsWith('rm '));
    const publishIndex = fsSteps.findIndex((op) => op.startsWith('rename ') || op.startsWith('link '));
    fsSteps.forEach((op, index) => {
      it(`${combination.label}: failure at ${op.split(' ')[0]} (step ${index})`, async () => {
        const fs = recordingFileSystem(combination.publish === 'replace' ? { [TARGET]: 'old' } : {});
        const failure = errnoError('EIO', `injected at step ${index}`);
        fs.failAt(index, failure);
        await expect(writeFileAtomically(fs, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(combination, fs.ops))).rejects.toBe(failure);
        expect(temporaries(fs.files)).toEqual([]);
        if (index <= publishIndex) {
          if (combination.publish === 'replace') expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe('old');
          else expect(fs.files.has(TARGET)).toBe(false);
        }
      });
    });
    for (const at of ['beforePublish', 'afterPublish'] as const) {
      if ((at === 'beforePublish' && !combination.before) || (at === 'afterPublish' && !combination.after)) continue;
      it(`${combination.label}: failure in ${at}`, async () => {
        const fs = recordingFileSystem();
        const failure = new Error(`${at} refused`);
        await expect(writeFileAtomically(fs, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(combination, fs.ops, { at, error: failure }))).rejects.toBe(failure);
        expect(temporaries(fs.files)).toEqual([]);
        if (at === 'beforePublish') {
          expect(fs.files.has(TARGET)).toBe(false);
          expect(fs.ops.some((recorded) => recorded.startsWith('rename ') || recorded.startsWith('link '))).toBe(false);
        }
      });
    }
  }
});

describe('writeFileAtomically: P-A2 create with two concurrent callers', () => {
  it('gives exactly one created true and the loser reads the winner bytes', async () => {
    const fs = recordingFileSystem();
    const random = fixedRandom(['000000000001', '000000000002']);
    const [first, second] = await Promise.all([
      writeFileAtomically(fs, random, TARGET, 'first', { mode: MODE, publish: 'create' }),
      writeFileAtomically(fs, random, TARGET, 'second', { mode: MODE, publish: 'create' }),
    ]);
    const outcomes = [first, second].map((result) => result.created);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winner = outcomes[0] === true ? 'first' : 'second';
    expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe(winner);
    expect(temporaries(fs.files)).toEqual([]);
  });
});

describe('writeFileAtomicallySync: the same step list as the async function', () => {
  for (const combination of COMBINATIONS) {
    it(`records the identical sequence for ${combination.label}`, async () => {
      const asyncFs = recordingFileSystem();
      await writeFileAtomically(asyncFs, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(combination, asyncFs.ops));
      const syncFs = recordingFileSystem();
      const result = writeFileAtomicallySync(syncFs, fixedRandom([HEX]), TARGET, combination.content, syncOptions(combination, syncFs.ops));
      expect(syncFs.ops).toEqual(asyncFs.ops);
      expect(syncFs.ops).toEqual(expectedSequence(combination));
      expect(syncFs.files.get(TARGET)).toEqual(bytes(combination.content));
      if (combination.publish === 'create') expect(result).toEqual({ created: true });
    });
  }

  it('create against an existing file returns created false and leaves no temporary file', () => {
    const fs = recordingFileSystem({ [TARGET]: 'winner' });
    const result = writeFileAtomicallySync(fs, fixedRandom([HEX]), TARGET, 'loser', { mode: MODE, publish: 'create' });
    expect(result).toEqual({ created: false });
    expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe('winner');
    expect(temporaries(fs.files)).toEqual([]);
  });

  it('removes its temporary file and rethrows when the publish fails', () => {
    const fs = recordingFileSystem({ [TARGET]: 'old' });
    const failure = errnoError('EIO', 'rename failed');
    fs.failAt(4, failure);
    expect(() => writeFileAtomicallySync(fs, fixedRandom([HEX]), TARGET, 'new', { mode: MODE })).toThrow(failure);
    expect(temporaries(fs.files)).toEqual([]);
    expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe('old');
  });
});
