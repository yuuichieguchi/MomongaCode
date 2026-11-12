import fs from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { createMarkerOwners } from '@momonga/tools';
import { ensureJobOutputDirectory, openJobOutputFile, readJobFileWindow, removeJobOutputFile, removeLeftoverJobOutputFile } from '../../src/process/job-output-file.ts';
import { mentionTargetOf, readMentionFile } from '../../src/process/user-input.ts';
import { registerMarkerRoutes } from '../../src/service/markers.ts';
import type { RouteRegistrar } from '../../src/service/app.ts';
import { createTempDir } from '@momonga/testkit';

type Call = { method: string; file: string };

const recording = (base: FileSystem, calls: Call[]): FileSystem =>
  new Proxy(base, {
    get: (target, property, receiver) => {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (...args: unknown[]) => {
        calls.push({ method: property, file: String(args[0]) });
        return Reflect.apply(value, target, args);
      };
    },
  });

const NEVER = new Promise<never>(() => undefined);

const silent = (base: FileSystem, methods: readonly string[]): FileSystem =>
  new Proxy(base, {
    get: (target, property, receiver) => (typeof property === 'string' && methods.includes(property) ? () => NEVER : Reflect.get(target, property, receiver)),
  });

const roots: string[] = [];

const tempRoot = (): string => {
  const root = createTempDir();
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const contextOf = (name: string, signal: AbortSignal): Context => ({ req: { param: () => name, raw: { signal } } }) as unknown as Context;

const ignoreHandlerOf = (deps: Parameters<typeof registerMarkerRoutes>[1]): ((context: Context) => Promise<Response>) => {
  const handlers: Record<string, (context: Context) => Promise<Response>> = {};
  const route: RouteRegistrar = (routePath, table) => {
    for (const [method, handler] of Object.entries(table)) handlers[`${method} ${routePath}`] = handler as (context: Context) => Promise<Response>;
  };
  registerMarkerRoutes(route, deps);
  const handler = handlers['POST /v1/markers/:name/ignore'];
  if (handler === undefined) throw new Error('the ignore route was not registered');
  return handler;
};

describe('an @ mention reaches the file system through the port, under the request signal', () => {
  it('answers the abort of the request when the port never answers', async () => {
    const controller = new AbortController();
    const reason = new Error('the client left');
    const asked = mentionTargetOf(silent(nodeFileSystem, ['realpath', 'stat']), { cwd: tempRoot() }, ['/'], 'a.txt', controller.signal);
    controller.abort(reason);
    await expect(asked).rejects.toBe(reason);
  });

  it('reads the mention, its kind and its bytes only through the port', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    const calls: Call[] = [];
    const files = recording(nodeFileSystem, calls);
    const target = await mentionTargetOf(files, { cwd: root }, [root], 'a.txt', new AbortController().signal);
    expect(target).toEqual({ absolute: path.join(root, 'a.txt'), shown: 'a.txt', kind: 'file', size: 5 });
    expect(Buffer.from(await readMentionFile(files, path.join(root, 'a.txt'), 3, new AbortController().signal)).toString()).toBe('hel');
    const methods = calls.filter((call) => call.file === path.join(root, 'a.txt')).map((call) => call.method);
    expect(methods).toEqual(expect.arrayContaining(['realpath', 'stat', 'openRead']));
  });
});

describe('the ignore route of a marker walks the marker folders through the port, under the request signal', () => {
  it('answers the abort of the request when the folder listing never answers', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const reason = new Error('the client left');
    const handler = ignoreHandlerOf({ markerDirectories: () => Promise.resolve([root]), owners: createMarkerOwners(), files: silent(nodeFileSystem, ['readdirEntries']) });
    const answered = handler(contextOf('m1', controller.signal));
    controller.abort(reason);
    await expect(answered).rejects.toBe(reason);
  });

  it('asks for the marker folders under the request signal and lists them through the port', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'm1'), 'r00110\n');
    const calls: Call[] = [];
    const signals: AbortSignal[] = [];
    const request = new AbortController().signal;
    const handler = ignoreHandlerOf({
      markerDirectories: (signal) => {
        signals.push(signal);
        return Promise.resolve([root]);
      },
      owners: createMarkerOwners(),
      files: recording(nodeFileSystem, calls),
    });
    expect((await handler(contextOf('m1', request))).status).toBe(204);
    expect(signals).toEqual([request]);
    expect(calls).toContainEqual({ method: 'readdirEntries', file: root });
    expect(fs.readFileSync(path.join(root, 'm1'), 'utf8')).toBe('r00111\n');
  });
});

describe('the output file of a background job goes through the file-system port', () => {
  it('creates the folder, writes, reads a window and removes the file only through the port', async () => {
    const root = tempRoot();
    const jobs = path.join(root, 'jobs');
    const file = path.join(jobs, 'bash_1.out');
    const calls: Call[] = [];
    const files = recording(nodeFileSystem, calls);
    await ensureJobOutputDirectory(files, jobs);
    expect(fs.statSync(jobs).mode & 0o777).toBe(0o700);
    await removeLeftoverJobOutputFile(files, file);
    const output = await openJobOutputFile(files, { path: file, maxBytes: 8, onFailure: () => undefined });
    output.append(Buffer.from('0123'));
    output.append(Buffer.from('456789'));
    await output.close();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await readJobFileWindow(files, file, 2, 4)).toEqual({ start: 4, total: 8, bytes: Buffer.from('4567') });
    await removeJobOutputFile(files, file);
    expect(fs.existsSync(file)).toBe(false);
    expect(calls.map((call) => `${call.method} ${path.basename(call.file)}`)).toEqual(['makeDirectory jobs', 'lstat bash_1.out', 'open bash_1.out', 'openRead bash_1.out', 'rm bash_1.out']);
  });

  it('refuses to create the output file over a symbolic link', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'elsewhere'), '');
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'bash_2.out'));
    await expect(openJobOutputFile(nodeFileSystem, { path: path.join(root, 'bash_2.out'), maxBytes: 8, onFailure: () => undefined })).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
