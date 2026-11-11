import { describe, expect, it } from 'vitest';
import { atomicWriteSteps, writeFileAtomically, writeFileAtomicallySync } from '@momonga/foundation';
import type { AtomicWriteFileSystem, AtomicWriteFileSystemSync, AtomicWriteStep, ClaimOutcome, KernelLockMechanism, LockForm, Random } from '@momonga/foundation';
import { afterMicrotasks } from '@momonga/testkit';

const DIRECTORY = '/state';
const TARGET = `${DIRECTORY}/record.json`;
const MODE = 0o600;
const SIDECAR_SUFFIX = '.sqlite';
const FORMS: readonly LockForm[] = ['entry', 'sidecar'];

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

const temporaryOf = (hex: string): string => `${DIRECTORY}/.record.json.${hex}.tmp`;

type Recording = AtomicWriteFileSystem &
  AtomicWriteFileSystemSync & {
    readonly ops: string[];
    readonly files: Map<string, Uint8Array>;
    readonly lock: KernelLockMechanism;
    failAt(index: number, error: Error): void;
  };

const recordingFileSystem = (form: LockForm, initial: Readonly<Record<string, string>> = {}): Recording => {
  const files = new Map<string, Uint8Array>(Object.entries(initial).map(([file, text]) => [file, new TextEncoder().encode(text)]));
  const directories = new Set<string>([DIRECTORY]);
  const held = new Set<string>();
  const ops: string[] = [];
  let failure: { index: number; error: Error } | undefined;
  let fsOps = 0;
  let nextDescriptor = 300;
  const descriptorFiles = new Map<number, string>();
  const fileOf = (descriptor: number): string => {
    const file = descriptorFiles.get(descriptor);
    if (file === undefined) throw errnoError('EBADF', `descriptor ${descriptor}`);
    return file;
  };
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
    step(`open ${file} ${(mode ?? 0).toString(8)}`);
    if (flags.includes('x') && files.has(file)) throw errnoError('EEXIST', file);
    if (!flags.includes('x') && !held.has(file)) throw new Error(`${file} was opened without exclusive create and without its lock`);
    if (!files.has(file) || flags.startsWith('w')) files.set(file, new Uint8Array());
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
  const lockFileOf = (lockPath: string): string => (form === 'entry' ? lockPath : `${lockPath}${SIDECAR_SUFFIX}`);
  const claimSync = (lockPath: string): ClaimOutcome => {
    const lockFile = lockFileOf(lockPath);
    step(`claim ${lockFile}`);
    if (held.has(lockFile)) return { kind: 'held' };
    held.add(lockFile);
    ops.push(`claimed ${lockFile}`);
    if (!files.has(lockFile)) files.set(lockFile, new Uint8Array());
    const descriptor = form === 'entry' ? nextDescriptor++ : undefined;
    if (descriptor !== undefined) descriptorFiles.set(descriptor, lockFile);
    const release = (): void => {
      if (!held.delete(lockFile)) return;
      ops.push(`release ${lockFile}`);
    };
    return {
      kind: 'claimed',
      lock: {
        descriptor,
        writeHolder: () => undefined,
        release,
        dispose: () => {
          removeFile(lockFile);
          release();
        },
      },
    };
  };
  const tick = afterMicrotasks;
  const lock: KernelLockMechanism = {
    name: form === 'entry' ? 'file-lock' : 'sqlite-lock',
    claim: async (lockPath) => {
      await tick();
      return claimSync(lockPath);
    },
    claimSync,
    isHeld: async (lockPath) => held.has(lockFileOf(lockPath)),
    readHolder: async () => undefined,
    readHolderSync: () => undefined,
    claimInheritable: undefined,
    adoptInherited: undefined,
  };
  return {
    ops,
    files,
    lock,
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
    descriptors: {
      write: async (descriptor, content) => {
        await tick();
        writeTo(fileOf(descriptor), content);
      },
      sync: async (descriptor) => {
        await tick();
        step(`fsync ${fileOf(descriptor)}`);
      },
      chmod: async (descriptor, mode) => {
        await tick();
        step(`fchmod ${fileOf(descriptor)} ${mode.toString(8)}`);
      },
    },
    descriptorsSync: {
      write: (descriptor, content) => writeTo(fileOf(descriptor), content),
      sync: (descriptor) => step(`fsync ${fileOf(descriptor)}`),
      chmod: (descriptor, mode) => step(`fchmod ${fileOf(descriptor)} ${mode.toString(8)}`),
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

const STEPS_BY_HAND: Record<LockForm, Record<'replace' | 'create', readonly AtomicWriteStep[]>> = {
  entry: {
    replace: ['createLocked', 'write', 'publish', 'release'],
    create: ['createLocked', 'write', 'publish', 'unlinkStaged', 'release'],
  },
  sidecar: {
    replace: ['lockSidecar', 'createTemporary', 'write', 'publish', 'unlinkSidecar', 'release'],
    create: ['lockSidecar', 'createTemporary', 'write', 'publish', 'unlinkStaged', 'unlinkSidecar', 'release'],
  },
};

const lockFileOf = (form: LockForm): string => (form === 'entry' ? TEMPORARY : `${TEMPORARY}${SIDECAR_SUFFIX}`);

const asyncOptions = (fs: Recording, combination: Combination, steps: AtomicWriteStep[] = [], fail?: { at: 'beforePublish' | 'afterPublish'; error: Error }) => ({
  mode: MODE,
  publish: combination.publish,
  lock: fs.lock,
  onStep: (name: AtomicWriteStep): void => void steps.push(name),
  ...(combination.before
    ? {
        beforePublish: async (): Promise<void> => {
          fs.ops.push('beforePublish');
          if (fail?.at === 'beforePublish') throw fail.error;
        },
      }
    : {}),
  ...(combination.after
    ? {
        afterPublish: async (): Promise<void> => {
          fs.ops.push('afterPublish');
          if (fail?.at === 'afterPublish') throw fail.error;
        },
      }
    : {}),
});

const syncOptions = (fs: Recording, combination: Combination, steps: AtomicWriteStep[] = []) => ({
  mode: MODE,
  publish: combination.publish,
  lock: fs.lock,
  onStep: (name: AtomicWriteStep): void => void steps.push(name),
  ...(combination.before ? { beforePublish: (): void => void fs.ops.push('beforePublish') } : {}),
  ...(combination.after ? { afterPublish: (): void => void fs.ops.push('afterPublish') } : {}),
});

const bytes = (content: string | Uint8Array): Uint8Array => (typeof content === 'string' ? new TextEncoder().encode(content) : content);

const leftovers = (files: Map<string, Uint8Array>): string[] => [...files.keys()].filter((file) => file !== TARGET);

for (const form of FORMS) {
  describe(`writeFileAtomically, ${form} form: the one step list (S3) and R1 to R3`, () => {
    for (const combination of COMBINATIONS) {
      it(`runs the step list of LeftoverCleanup.tla for ${combination.label}`, async () => {
        const fs = recordingFileSystem(form);
        const steps: AtomicWriteStep[] = [];
        const result = await writeFileAtomically(fs, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(fs, combination, steps));
        expect(steps).toEqual(STEPS_BY_HAND[form][combination.publish]);
        expect(atomicWriteSteps(form, combination.publish)).toEqual(STEPS_BY_HAND[form][combination.publish]);
        expect(fs.files.get(TARGET)).toEqual(bytes(combination.content));
        expect(leftovers(fs.files)).toEqual([]);
        if (combination.publish === 'create') expect(result).toEqual({ created: true });
      });

      it(`claims the lock before the temporary exists and releases it only after every name it made is unlinked, for ${combination.label}`, async () => {
        const fs = recordingFileSystem(form);
        await writeFileAtomically(fs, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(fs, combination));
        expect(fs.ops[0]).toBe(`claim ${lockFileOf(form)}`);
        const release = fs.ops.indexOf(`release ${lockFileOf(form)}`);
        expect(release).toBeGreaterThan(0);
        const publish = fs.ops.findIndex((op) => op === `rename ${TEMPORARY} ${TARGET}` || op === `link ${TEMPORARY} ${TARGET}`);
        expect(publish).toBeGreaterThan(0);
        expect(publish).toBeLessThan(release);
        if (combination.publish === 'create') expect(fs.ops.indexOf(`rm ${TEMPORARY}`)).toBeLessThan(release);
        if (form === 'sidecar') expect(fs.ops.indexOf(`rm ${lockFileOf(form)}`)).toBeLessThan(release);
      });
    }

    it('replaces an existing file when publish is replace', async () => {
      const fs = recordingFileSystem(form, { [TARGET]: 'old' });
      await writeFileAtomically(fs, fixedRandom([HEX]), TARGET, 'new', { mode: MODE, lock: fs.lock });
      expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe('new');
      expect(fs.ops).toContain(`rename ${TEMPORARY} ${TARGET}`);
      expect(leftovers(fs.files)).toEqual([]);
    });

    it('create against an existing file returns created false, keeps the winner, skips afterPublish and unlinks its temporary before the release', async () => {
      const fs = recordingFileSystem(form, { [TARGET]: 'winner' });
      const combination: Combination = { publish: 'create', before: true, after: true, content: 'loser', label: '' };
      const result = await writeFileAtomically(fs, fixedRandom([HEX]), TARGET, 'loser', asyncOptions(fs, combination));
      expect(result).toEqual({ created: false });
      expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe('winner');
      expect(fs.ops).not.toContain('afterPublish');
      expect(fs.ops.indexOf(`rm ${TEMPORARY}`)).toBeLessThan(fs.ops.indexOf(`release ${lockFileOf(form)}`));
      expect(leftovers(fs.files)).toEqual([]);
    });
  });

  describe(`writeFileAtomically, ${form} form: no temporary or sidecar remains after a failure at any step`, () => {
    for (const combination of COMBINATIONS) {
      it(`${combination.label}: a failure injected at each recorded step`, async () => {
        const probe = recordingFileSystem(form, combination.publish === 'replace' ? { [TARGET]: 'old' } : {});
        await writeFileAtomically(probe, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(probe, combination));
        const failable = probe.ops.filter((op) => op !== 'beforePublish' && op !== 'afterPublish' && !op.startsWith('rm ') && !op.startsWith('release ') && !op.startsWith('claimed '));
        const publishIndex = failable.findIndex((op) => op.startsWith('rename ') || op.startsWith('link '));
        expect(publishIndex).toBeGreaterThan(0);
        for (let index = 0; index < failable.length; index += 1) {
          const fs = recordingFileSystem(form, combination.publish === 'replace' ? { [TARGET]: 'old' } : {});
          const failure = errnoError('EIO', `injected at step ${index}`);
          fs.failAt(index, failure);
          await expect(writeFileAtomically(fs, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(fs, combination))).rejects.toBe(failure);
          expect(leftovers(fs.files), `failure at ${failable[index]}`).toEqual([]);
          expect(fs.ops.filter((op) => op.startsWith('claimed ')).length, `failure at ${failable[index]}`).toBe(fs.ops.filter((op) => op.startsWith('release ')).length);
          if (index <= publishIndex && combination.publish === 'create') expect(fs.files.has(TARGET)).toBe(false);
        }
      });

      for (const at of ['beforePublish', 'afterPublish'] as const) {
        if ((at === 'beforePublish' && !combination.before) || (at === 'afterPublish' && !combination.after)) continue;
        it(`${combination.label}: failure in ${at}`, async () => {
          const fs = recordingFileSystem(form);
          const failure = new Error(`${at} refused`);
          await expect(writeFileAtomically(fs, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(fs, combination, [], { at, error: failure }))).rejects.toBe(failure);
          if (at === 'beforePublish') {
            expect(leftovers(fs.files)).toEqual([]);
            expect(fs.ops.some((recorded) => recorded.startsWith('rename ') || recorded.startsWith('link '))).toBe(false);
          }
        });
      }
    }
  });

  describe(`writeFileAtomically, ${form} form: create with two concurrent callers`, () => {
    it('gives exactly one created true and the loser reads the winner bytes', async () => {
      const fs = recordingFileSystem(form);
      const random = fixedRandom(['000000000001', '000000000002']);
      const [first, second] = await Promise.all([
        writeFileAtomically(fs, random, TARGET, 'first', { mode: MODE, publish: 'create', lock: fs.lock }),
        writeFileAtomically(fs, random, TARGET, 'second', { mode: MODE, publish: 'create', lock: fs.lock }),
      ]);
      const outcomes = [first, second].map((result) => result.created);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const winner = outcomes[0] === true ? 'first' : 'second';
      expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe(winner);
      expect(leftovers(fs.files)).toEqual([]);
    });
  });

  describe(`writeFileAtomicallySync, ${form} form: the same step list in the same order as the async writer (S3)`, () => {
    for (const combination of COMBINATIONS) {
      it(`records the identical steps and operations for ${combination.label}`, async () => {
        const asyncFs = recordingFileSystem(form);
        const asyncSteps: AtomicWriteStep[] = [];
        await writeFileAtomically(asyncFs, fixedRandom([HEX]), TARGET, combination.content, asyncOptions(asyncFs, combination, asyncSteps));
        const syncFs = recordingFileSystem(form);
        const syncSteps: AtomicWriteStep[] = [];
        const result = writeFileAtomicallySync(syncFs, fixedRandom([HEX]), TARGET, combination.content, syncOptions(syncFs, combination, syncSteps));
        expect(syncSteps).toEqual(STEPS_BY_HAND[form][combination.publish]);
        expect(syncSteps).toEqual(asyncSteps);
        expect(syncFs.ops).toEqual(asyncFs.ops);
        expect(syncFs.files.get(TARGET)).toEqual(bytes(combination.content));
        expect(leftovers(syncFs.files)).toEqual([]);
        if (combination.publish === 'create') expect(result).toEqual({ created: true });
      });
    }

    it('create against an existing file returns created false and leaves no temporary or sidecar', () => {
      const fs = recordingFileSystem(form, { [TARGET]: 'winner' });
      const result = writeFileAtomicallySync(fs, fixedRandom([HEX]), TARGET, 'loser', { mode: MODE, publish: 'create', lock: fs.lock });
      expect(result).toEqual({ created: false });
      expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe('winner');
      expect(leftovers(fs.files)).toEqual([]);
    });

    it('unlinks its temporary and sidecar, releases, and rethrows when the publish fails', () => {
      const fs = recordingFileSystem(form, { [TARGET]: 'old' });
      const failure = errnoError('EIO', 'rename failed');
      const probe = recordingFileSystem(form, { [TARGET]: 'old' });
      writeFileAtomicallySync(probe, fixedRandom([HEX]), TARGET, 'new', { mode: MODE, lock: probe.lock });
      const failable = probe.ops.filter((op) => !op.startsWith('rm ') && !op.startsWith('release ') && !op.startsWith('claimed '));
      fs.failAt(failable.findIndex((op) => op.startsWith('rename ')), failure);
      expect(() => writeFileAtomicallySync(fs, fixedRandom([HEX]), TARGET, 'new', { mode: MODE, lock: fs.lock })).toThrow(failure);
      expect(leftovers(fs.files)).toEqual([]);
      expect(fs.ops).toContain(`release ${lockFileOf(form)}`);
      expect(new TextDecoder().decode(fs.files.get(TARGET))).toBe('old');
    });
  });
}
