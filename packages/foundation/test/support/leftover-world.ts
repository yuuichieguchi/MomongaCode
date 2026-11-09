import path from 'node:path';
import type { AtomicWriteFileHandle, AtomicWriteFileSystem, ClaimOutcome, HeldKernelLock, KernelLockMechanism } from '@momonga/foundation';

export type WorldLockForm = 'entry' | 'sidecar';

export const SIDECAR_SUFFIX = '.sqlite';

export class ProcessCrashed extends Error {
  readonly actor: string;
  constructor(actor: string) {
    super(`${actor} has crashed`);
    this.actor = actor;
    this.name = 'ProcessCrashed';
  }
}

const errno = (message: string, code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: ${message}`), { code });

export type StepControl = { crashAt?: number; pauseAt?: number };

export type Paused = { reached: Promise<void>; resume(): void };

export type WorldActor = {
  readonly name: string;
  readonly files: AtomicWriteFileSystem & { readdir(directory: string): Promise<string[]>; rm(file: string): Promise<void> };
  readonly lock: KernelLockMechanism;
  readonly steps: () => readonly string[];
  readonly paused: Paused;
  crash(): void;
  isDead(): boolean;
};

export type World = {
  readonly contents: Map<string, string>;
  readonly directories: Set<string>;
  names(directory: string): string[];
  actor(name: string, control?: StepControl): WorldActor;
};

const textOf = (content: string | Uint8Array): string => (typeof content === 'string' ? content : new TextDecoder().decode(content));

export const createWorld = (form: WorldLockForm, directories: readonly string[]): World => {
  const contents = new Map<string, string>();
  const dirs = new Set(directories);
  const holders = new Map<string, string>();
  const dead = new Set<string>();

  const lockPathOf = (lockPath: string): string => (form === 'entry' ? lockPath : `${lockPath}${SIDECAR_SUFFIX}`);

  const actor = (name: string, control: StepControl = {}): WorldActor => {
    const taken: string[] = [];
    let resumePause = (): void => undefined;
    let signalReached = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resumePause = resolve;
    });

    const crash = (): void => {
      dead.add(name);
      for (const [lockPath, holder] of [...holders]) if (holder === name) holders.delete(lockPath);
    };

    const stepSync = (label: string): void => {
      if (dead.has(name)) throw new ProcessCrashed(name);
      taken.push(label);
      if (control.crashAt === taken.length) {
        crash();
        throw new ProcessCrashed(name);
      }
    };

    const step = async (label: string): Promise<void> => {
      if (dead.has(name)) throw new ProcessCrashed(name);
      if (control.pauseAt === taken.length + 1) {
        signalReached();
        await resumed;
      }
      stepSync(label);
    };

    const requireDirectory = (file: string): void => {
      if (!dirs.has(path.dirname(file))) throw errno(`no directory for ${file}`, 'ENOENT');
    };

    const handleOf = (file: string): AtomicWriteFileHandle => ({
      writeFile: async (content) => {
        await step(`write ${path.basename(file)}`);
        if (!contents.has(file)) throw errno(`${file} was removed while open`, 'ENOENT');
        contents.set(file, textOf(content));
      },
      sync: async () => {
        await step(`sync ${path.basename(file)}`);
      },
      close: async () => {
        await step(`close ${path.basename(file)}`);
      },
    });

    const files: WorldActor['files'] = {
      open: async (file, flags) => {
        await step(`open ${flags} ${path.basename(file)}`);
        if (dirs.has(file)) return handleOf(file);
        requireDirectory(file);
        const exists = contents.has(file);
        if (flags.includes('x') && exists) throw errno(`${file} exists`, 'EEXIST');
        if (flags.startsWith('r') && !exists) throw errno(`${file} is missing`, 'ENOENT');
        if (!exists || flags.startsWith('w')) contents.set(file, '');
        return handleOf(file);
      },
      rename: async (from, to) => {
        await step(`rename ${path.basename(from)} ${path.basename(to)}`);
        const content = contents.get(from);
        if (content === undefined) throw errno(`${from} is missing`, 'ENOENT');
        contents.delete(from);
        contents.set(to, content);
      },
      link: async (from, to) => {
        await step(`link ${path.basename(from)} ${path.basename(to)}`);
        const content = contents.get(from);
        if (content === undefined) throw errno(`${from} is missing`, 'ENOENT');
        if (contents.has(to)) throw errno(`${to} exists`, 'EEXIST');
        contents.set(to, content);
      },
      rm: async (file) => {
        await step(`rm ${path.basename(file)}`);
        contents.delete(file);
      },
      readdir: async (directory) => {
        await step(`readdir ${directory}`);
        return [...contents.keys()].filter((key) => path.dirname(key) === directory).map((key) => path.basename(key));
      },
    };

    const heldLock = (held: string): HeldKernelLock => {
      let open = true;
      const release = (): void => {
        stepSync(`release ${path.basename(held)}`);
        if (!open) return;
        open = false;
        if (holders.get(held) === name) holders.delete(held);
      };
      return {
        descriptor: undefined,
        writeHolder: (text) => {
          stepSync(`writeHolder ${path.basename(held)}`);
          contents.set(held, text);
        },
        release,
        dispose: () => {
          stepSync(`unlink ${path.basename(held)}`);
          contents.delete(held);
          release();
        },
      };
    };

    const claim = async (lockPath: string): Promise<ClaimOutcome> => {
      const held = lockPathOf(lockPath);
      await step(`claim ${path.basename(held)}`);
      requireDirectory(held);
      const holder = holders.get(held);
      if (holder !== undefined) return { kind: 'held' };
      if (!contents.has(held)) contents.set(held, '');
      holders.set(held, name);
      return { kind: 'claimed', lock: heldLock(held) };
    };

    const lock: KernelLockMechanism = {
      name: form === 'entry' ? 'file-lock' : 'sqlite-lock',
      claim,
      isHeld: async (lockPath) => holders.has(lockPathOf(lockPath)),
      readHolder: async (lockPath) => contents.get(lockPathOf(lockPath)),
      readHolderSync: (lockPath) => contents.get(lockPathOf(lockPath)),
      claimInheritable: undefined,
      adoptInherited: undefined,
    };

    return {
      name,
      files,
      lock,
      steps: () => taken,
      paused: { reached, resume: resumePause },
      crash,
      isDead: () => dead.has(name),
    };
  };

  return {
    contents,
    directories: dirs,
    names: (directory) => [...contents.keys()].filter((key) => path.dirname(key) === directory).map((key) => path.basename(key)).sort(),
    actor,
  };
};
