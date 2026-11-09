import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeBuiltins, onCleanup, resultOf, sha256 } from './fixtures.ts';
import type { Builtins } from './fixtures.ts';

const ACCEPT = { mode: 'acceptEdits' } as const;
const DIFFERENT_LOCATION = /resolves to a different location than when it was approved \(.+ → .+\); retry the call/;

type Event = { op: 'realpath' | 'open' | 'mkdir'; target: string };

const patch = <K extends 'open' | 'realpath' | 'mkdir' | 'stat' | 'rename'>(name: K, replacement: (typeof fs.promises)[K]): void => {
  const original = fs.promises[name];
  fs.promises[name] = replacement;
  onCleanup(() => {
    fs.promises[name] = original;
  });
};

const SIDECAR_SUFFIXES: readonly string[] = ['.sqlite', '.lock'];

const entryOf = (candidate: string): string => {
  const suffix = SIDECAR_SUFFIXES.find((ending) => candidate.endsWith(ending));
  return suffix === undefined ? candidate : candidate.slice(0, -suffix.length);
};

const isTemporaryFor = (candidate: string, target: string): boolean => {
  const entry = entryOf(candidate);
  return path.dirname(entry) === path.dirname(target) && path.basename(entry).startsWith(`.${path.basename(target)}.`) && entry.endsWith('.tmp');
};

const patchOpenSync = (replacement: typeof fs.openSync): void => {
  const original = fs.openSync;
  fs.openSync = replacement;
  onCleanup(() => {
    fs.openSync = original;
  });
};

const createsAt = (flags: unknown): boolean => typeof flags === 'number' ? (flags & fs.constants.O_CREAT) !== 0 : typeof flags === 'string' && /[wax]/.test(flags);

const recordEvents = (events: Event[]): void => {
  const realpath = fs.promises.realpath;
  const open = fs.promises.open;
  const mkdir = fs.promises.mkdir;
  patch('realpath', (async (target: fs.PathLike, ...rest: unknown[]) => {
    events.push({ op: 'realpath', target: String(target) });
    return (realpath as (...args: unknown[]) => Promise<string>)(target, ...rest);
  }) as typeof fs.promises.realpath);
  patch('open', (async (target: fs.PathLike, ...rest: unknown[]) => {
    events.push({ op: 'open', target: String(target) });
    return (open as (...args: unknown[]) => Promise<fs.promises.FileHandle>)(target, ...rest);
  }) as typeof fs.promises.open);
  patch('mkdir', (async (target: fs.PathLike, ...rest: unknown[]) => {
    events.push({ op: 'mkdir', target: String(target) });
    return (mkdir as (...args: unknown[]) => Promise<string | undefined>)(target, ...rest);
  }) as typeof fs.promises.mkdir);
  const openSync = fs.openSync;
  patchOpenSync(((target: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null) => {
    if (createsAt(flags)) events.push({ op: 'open', target: String(target) });
    return openSync(target, flags ?? 'r', mode);
  }) as typeof fs.openSync);
};

const swapToSymlink = (dir: string, redirect: string): void => {
  fs.renameSync(dir, `${dir}-original`);
  fs.mkdirSync(redirect, { recursive: true });
  fs.symlinkSync(redirect, dir);
};

const lastParentCheckBeforeEntryCreate = (events: readonly Event[], target: string): number => {
  const openIndex = events.findIndex((event) => event.op === 'open' && isTemporaryFor(event.target, target));
  expect(openIndex).toBeGreaterThanOrEqual(0);
  const before = events.slice(0, openIndex);
  const checkIndex = before.map((event) => event.op === 'realpath' && event.target === path.dirname(target)).lastIndexOf(true);
  expect(checkIndex).toBeGreaterThanOrEqual(0);
  return before.filter((event) => event.op === 'realpath' && event.target === path.dirname(target)).length;
};

const runWrite = async (tools: Builtins, file: string, content: string) => resultOf(await tools.run('Write', { file_path: file, content }, ACCEPT));

describe('atomic write through a swapped parent directory', () => {
  it('checks the parent location before the claim creates the temporary entry', async () => {
    const tools = await makeBuiltins();
    fs.mkdirSync(path.join(tools.layout.project, 'dir'));
    const file = path.join(tools.layout.project, 'dir', 'new.txt');
    const events: Event[] = [];
    recordEvents(events);
    expect((await runWrite(tools, file, 'payload')).status).toBe('completed');
    lastParentCheckBeforeEntryCreate(events, file);
  });

  it.each([
    ['a protected directory', (tools: Builtins) => path.join(tools.layout.project, '.git', 'hooks')],
    ['a readDenied directory', (tools: Builtins) => path.join(tools.layout.home, '.momonga')],
  ])('Write never creates a temporary entry or its sidecar in %s when the parent is swapped right before the claim creates it', async (_label, redirectOf) => {
    const probe = await makeBuiltins();
    fs.mkdirSync(path.join(probe.layout.project, 'dir'));
    const probeFile = path.join(probe.layout.project, 'dir', 'probe.txt');
    const probeEvents: Event[] = [];
    recordEvents(probeEvents);
    await runWrite(probe, probeFile, 'payload');
    const swapAtCheck = lastParentCheckBeforeEntryCreate(probeEvents, probeFile);

    const tools = await makeBuiltins();
    const dir = path.join(tools.layout.project, 'dir');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'new.txt');
    const redirect = redirectOf(tools);
    const createdThroughLink: string[][] = [];
    const realpath = fs.promises.realpath;
    const open = fs.promises.open;
    let parentChecks = 0;
    patch('realpath', (async (target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === dir) {
        parentChecks += 1;
        if (parentChecks === swapAtCheck) swapToSymlink(dir, redirect);
      }
      return (realpath as (...args: unknown[]) => Promise<string>)(target, ...rest);
    }) as typeof fs.promises.realpath);
    patch('open', (async (target: fs.PathLike, ...rest: unknown[]) => {
      const handle = await (open as (...args: unknown[]) => Promise<fs.promises.FileHandle>)(target, ...rest);
      if (isTemporaryFor(String(target), file) && fs.existsSync(redirect)) createdThroughLink.push(fs.readdirSync(redirect));
      return handle;
    }) as typeof fs.promises.open);
    const openSync = fs.openSync;
    patchOpenSync(((target: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null) => {
      const descriptor = openSync(target, flags ?? 'r', mode);
      if (createsAt(flags) && isTemporaryFor(String(target), file) && fs.existsSync(redirect)) createdThroughLink.push(fs.readdirSync(redirect));
      return descriptor;
    }) as typeof fs.openSync);

    const result = await runWrite(tools, file, 'payload');
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(DIFFERENT_LOCATION);
    expect(createdThroughLink.filter((entries) => entries.length > 0)).toEqual([]);
    expect(fs.readdirSync(redirect)).toEqual([]);
    expect(fs.readdirSync(`${dir}-original`)).toEqual([]);
  });

  it('Write fails without creating anything through an intermediate directory swapped during creation', async () => {
    const tools = await makeBuiltins();
    const first = path.join(tools.layout.project, 'a');
    const file = path.join(first, 'b', 'c', 'new.txt');
    const elsewhere = path.join(tools.layout.outside, 'elsewhere');
    const mkdir = fs.promises.mkdir;
    let swapped = false;
    patch('mkdir', (async (target: fs.PathLike, ...rest: unknown[]) => {
      const created = await (mkdir as (...args: unknown[]) => Promise<string | undefined>)(target, ...rest);
      if (!swapped && fs.existsSync(first)) {
        swapped = true;
        fs.rmSync(`${first}-original`, { recursive: true, force: true });
        swapToSymlink(first, elsewhere);
      }
      return created;
    }) as typeof fs.promises.mkdir);
    const result = await runWrite(tools, file, 'payload');
    expect(swapped).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(DIFFERENT_LOCATION);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('removes a level it created inside the redirect target when the next check fails', async () => {
    const tools = await makeBuiltins();
    const first = path.join(tools.layout.project, 'a');
    const second = path.join(first, 'b');
    const file = path.join(second, 'c', 'file');
    const hooks = path.join(tools.layout.project, '.git', 'hooks');
    const mkdir = fs.promises.mkdir;
    let swapped = false;
    patch('mkdir', (async (target: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && String(target) === second) {
        swapped = true;
        swapToSymlink(first, hooks);
      }
      return (mkdir as (...args: unknown[]) => Promise<string | undefined>)(target, ...rest);
    }) as typeof fs.promises.mkdir);
    const result = await runWrite(tools, file, 'payload');
    expect(swapped).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(DIFFERENT_LOCATION);
    expect(fs.readdirSync(hooks)).toEqual([]);
  });

  it('creates nested missing directories one level at a time and writes the file', async () => {
    const tools = await makeBuiltins();
    const file = path.join(tools.layout.project, 'x', 'y', 'z', 'new.txt');
    const events: Event[] = [];
    recordEvents(events);
    const result = await runWrite(tools, file, 'nested');
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('nested');
    expect(events.filter((event) => event.op === 'mkdir').map((event) => event.target)).toEqual([
      path.join(tools.layout.project, 'x'),
      path.join(tools.layout.project, 'x', 'y'),
      path.join(tools.layout.project, 'x', 'y', 'z'),
    ]);
  });
});

describe('ledger update failure after the rename', () => {
  const failStatOnceAfterRename = (target: string): void => {
    const stat = fs.promises.stat;
    const rename = fs.promises.rename;
    let renamed = false;
    let failed = false;
    patch('rename', (async (from: fs.PathLike, to: fs.PathLike) => {
      await rename(from, to);
      if (String(to) === target) renamed = true;
    }) as typeof fs.promises.rename);
    patch('stat', (async (candidate: fs.PathLike, ...rest: unknown[]) => {
      if (renamed && !failed && String(candidate) === target) {
        failed = true;
        throw Object.assign(new Error('EIO: i/o error, stat'), { code: 'EIO' });
      }
      return (stat as (...args: unknown[]) => Promise<fs.Stats>)(candidate, ...rest);
    }) as typeof fs.promises.stat);
  };

  const WARNING = /\nWarning: the change was written but the read ledger could not be updated \(.*EIO.*\); Read the file before editing it again\.$/;

  it('Write completes with a warning, drops the stale ledger entry, and a following Edit requires a Read', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('w.txt', 'old\n');
    tools.markRead(file);
    failStatOnceAfterRename(file);
    const result = await runWrite(tools, file, 'new\n');
    expect(result.status).toBe('completed');
    expect(result.output).toMatch(WARNING);
    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
    expect(tools.session.readLedger.has(file)).toBe(false);
    const edit = resultOf(await tools.run('Edit', { file_path: file, old_string: 'new', new_string: 'newer' }, ACCEPT));
    expect(edit.status).toBe('failed');
    expect(edit.output).toMatch(/Read/);
    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
  });

  it('Edit completes with a warning and drops the stale ledger entry', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('e.txt', 'one\n');
    tools.markRead(file);
    failStatOnceAfterRename(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'one', new_string: 'two' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(result.output).toMatch(WARNING);
    expect(fs.readFileSync(file, 'utf8')).toBe('two\n');
    expect(tools.session.readLedger.get(file)?.sha256).not.toBe(sha256('one\n'));
    expect(tools.session.readLedger.has(file)).toBe(false);
  });
});
