import fs from 'node:fs';
import path from 'node:path';
import { createStdioTransport } from '@momonga/mcp';
import { nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS, TEST_STDIO_LAUNCH, testProcessInspector } from '@momonga/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Call = { method: string; file: string };

const recording = (calls: Call[]): FileSystem =>
  new Proxy(nodeFileSystem, {
    get: (target, property, receiver) => {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (...args: unknown[]) => {
        calls.push({ method: property, file: String(args[0]) });
        return Reflect.apply(value, target, args);
      };
    },
  });

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = createTempDir();
  dirs.push(dir);
  return dir;
};

describe('the command of a stdio MCP server is found on PATH through the file-system port', () => {
  it('probes each PATH entry, creates the marker and removes it only through the port', async () => {
    const empty = makeDir();
    const bin = makeDir();
    const markers = makeDir();
    fs.symlinkSync(process.execPath, path.join(bin, 'mm-port-node'));
    const calls: Call[] = [];
    const transport = createStdioTransport({ launch: TEST_STDIO_LAUNCH,
      name: 'port',
      config: { command: 'mm-port-node', args: ['-e', 'setTimeout(() => undefined, 60000)'] },
      projectDir: makeDir(),
      baseEnv: { PATH: [empty, bin].join(path.delimiter) },
      files: recording(calls),
      markers: { dir: markers, inspector: testProcessInspector(), onWarning: () => undefined },
    });
    await transport.start();
    await transport.close(0);
    const candidate = path.join(bin, 'mm-port-node');
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'stat', file: path.join(empty, 'mm-port-node') },
      { method: 'stat', file: candidate },
      { method: 'access', file: candidate },
    ]));
    expect(calls.some((call) => call.method === 'open' && path.dirname(call.file) === markers)).toBe(true);
  });

  it('names the command it did not find', async () => {
    const transport = createStdioTransport({ launch: TEST_STDIO_LAUNCH, name: 'missing', config: { command: 'mm-port-missing' }, projectDir: makeDir(), baseEnv: { PATH: makeDir() }, files: nodeFileSystem });
    await expect(transport.start()).rejects.toThrow(/mm-port-missing/);
  });
});
