import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeKernelLock, createTempDir, removeTempDir, testKernelLock } from '@momonga/testkit';
import {
  createUdsClient,
  currentSocketResolver,
  ensureGenerationDirs,
  ensureMomongaDirs,
  generationLayout,
  momongaPaths,
  publishCurrentGeneration,
  readCurrentGeneration,
} from '@momonga/foundation';
import type { AtomicWriteFileSystem, CurrentGeneration, MomongaPaths } from '@momonga/foundation';

const temporaryHome = (): string => createTempDir({ asHome: true });

const recordOf = (home: string, generation: number, version: string): CurrentGeneration => ({
  generation,
  version,
  sockets: generationLayout(home, generation).sockets,
});

const withHome = async (body: (home: string, paths: MomongaPaths) => Promise<void>): Promise<void> => {
  const home = temporaryHome();
  try {
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    await body(home, paths);
  } finally {
    await removeTempDir(home);
  }
};

describe('readCurrentGeneration', () => {
  it('answers undefined when run/current is missing, which means no daemon', async () => {
    await withHome(async (_home, paths) => {
      expect(await readCurrentGeneration(paths)).toBeUndefined();
    });
  });

  it('reads back exactly the generation that was published', async () => {
    await withHome(async (home, paths) => {
      await publishCurrentGeneration(paths, recordOf(home, 4, '2.0.1'), { lock: testKernelLock() });
      expect(await readCurrentGeneration(paths)).toEqual({
        generation: 4,
        version: '2.0.1',
        sockets: {
          gateway: path.join(home, '.momonga', 'run', 'g4', 'gateway.sock'),
          runtime: path.join(home, '.momonga', 'run', 'g4', 'runtime.sock'),
          supervisor: path.join(home, '.momonga', 'run', 'g4', 'supervisor.sock'),
        },
      });
    });
  });

  it('reads the newer generation once it replaces the older one', async () => {
    await withHome(async (home, paths) => {
      await publishCurrentGeneration(paths, recordOf(home, 1, '1.0.0'), { lock: testKernelLock() });
      await publishCurrentGeneration(paths, recordOf(home, 2, '1.1.0'), { lock: testKernelLock() });
      expect(await readCurrentGeneration(paths)).toMatchObject({ generation: 2, version: '1.1.0' });
    });
  });
});

describe('publishCurrentGeneration', () => {
  it('writes a temporary file and renames it over run/current, never writing run/current in place', async () => {
    const paths = momongaPaths('/Users/alice', 'darwin', {});
    const operations: { op: string; file: string; to?: string }[] = [];
    const contents = new Map<string, string>();
    const files: AtomicWriteFileSystem = {
      open: async (file, flags) => {
        operations.push({ op: `open:${flags}`, file });
        return {
          writeFile: async (content) => void contents.set(file, typeof content === 'string' ? content : Buffer.from(content).toString('utf8')),
          sync: async () => undefined,
          close: async () => undefined,
        };
      },
      rename: async (from, to) => {
        operations.push({ op: 'rename', file: from, to });
        const content = contents.get(from);
        if (content !== undefined) contents.set(to, content);
      },
      link: async (from, to) => void operations.push({ op: 'link', file: from, to }),
      rm: async (file) => void operations.push({ op: 'rm', file }),
    };
    expect(await publishCurrentGeneration(paths, recordOf('/Users/alice', 1, '1.0.0'), { fs: files, lock: createFakeKernelLock({ inheritable: false }) })).toBe('published');
    const writesToCurrent = operations.filter((operation) => operation.file === paths.current && operation.op.startsWith('open'));
    expect(writesToCurrent).toEqual([]);
    const renames = operations.filter((operation) => operation.op === 'rename');
    expect(renames).toHaveLength(1);
    expect(renames[0]?.to).toBe(paths.current);
    expect(path.dirname(renames[0]?.file ?? '')).toBe(paths.run);
    expect(JSON.parse(contents.get(paths.current) ?? 'null')).toEqual(recordOf('/Users/alice', 1, '1.0.0'));
  });
});

describe('currentSocketResolver', () => {
  it('answers the socket of the named role in the current generation, read again on each call', async () => {
    await withHome(async (home, paths) => {
      const runtime = currentSocketResolver(paths, 'runtime');
      const supervisor = currentSocketResolver(paths, 'supervisor');
      await publishCurrentGeneration(paths, recordOf(home, 1, '1.0.0'), { lock: testKernelLock() });
      expect(await runtime()).toBe(path.join(home, '.momonga', 'run', 'g1', 'runtime.sock'));
      await publishCurrentGeneration(paths, recordOf(home, 2, '1.0.0'), { lock: testKernelLock() });
      expect(await runtime()).toBe(path.join(home, '.momonga', 'run', 'g2', 'runtime.sock'));
      expect(await supervisor()).toBe(path.join(home, '.momonga', 'run', 'g2', 'supervisor.sock'));
    });
  });

  it('rejects with ENOENT when no generation is current, the code clients already read as no daemon', async () => {
    await withHome(async (_home, paths) => {
      await expect(currentSocketResolver(paths, 'gateway')()).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

const closingServer = (socket: string, onRequest: () => void): Promise<http.Server> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      onRequest();
      response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' }).end('ok');
    });
    server.once('error', reject);
    server.listen(socket, () => resolve(server));
  });

describe('createUdsClient with a resolver', () => {
  it('resolves the socket again for every connection it dials', async () => {
    await withHome(async (home, paths) => {
      await ensureGenerationDirs(paths, 1);
      const socket = generationLayout(home, 1).sockets.runtime;
      let served = 0;
      const server = await closingServer(socket, () => {
        served += 1;
      });
      let resolved = 0;
      const client = createUdsClient(async () => {
        resolved += 1;
        return socket;
      }, { connectTimeoutMs: 0 });
      try {
        expect(await (await client.request({ method: 'GET', path: '/a' })).text()).toBe('ok');
        expect(await (await client.request({ method: 'GET', path: '/b' })).text()).toBe('ok');
        expect(served).toBe(2);
        expect(resolved).toBe(2);
      } finally {
        await client.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it('fails a request with ENOENT when no generation is current', async () => {
    await withHome(async (_home, paths) => {
      const client = createUdsClient(currentSocketResolver(paths, 'runtime'), { connectTimeoutMs: 0 });
      try {
        await expect(client.request({ method: 'GET', path: '/v1/health' })).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await client.destroy();
      }
    });
  });
});
