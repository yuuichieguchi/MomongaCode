import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeFileSystem, personCapabilityOf, systemRandom } from '@momonga/foundation';
import { createStdioTransport } from '@momonga/mcp';
import type { StdioTransport } from '@momonga/mcp';
import { DEFAULT_BWRAP_PATH, childProtectionFor, protectionCommandOf } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createTempDir, pollUntil, removeTempDir, testKernelLock } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROTECTED_HOST = process.platform === 'darwin' || (process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH));
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const REPORT_BOUND_MS = 20_000;

const PROBE = `
const fs = require('node:fs');
const net = require('node:net');
const [file, socket] = process.argv.slice(1);
const outcome = {};
try { fs.readFileSync(file, 'utf8'); outcome.read = 'opened'; } catch (error) { outcome.read = error.code; }
const connection = net.connect(socket);
connection.on('connect', () => { outcome.connect = 'connected'; connection.destroy(); process.stderr.write('REPORT ' + JSON.stringify(outcome) + '\\n'); });
connection.on('error', (error) => { outcome.connect = error.code; process.stderr.write('REPORT ' + JSON.stringify(outcome) + '\\n'); });
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.runIf(PROTECTED_HOST)('a stdio MCP server under the protection of the home (real platform sandbox)', () => {
  it('cannot read the capability of the person or reach a socket of the runtime', async () => {
    const home = createTempDir({ asHome: true });
    cleanups.push(() => removeTempDir(home));
    const work = createTempDir();
    cleanups.push(() => removeTempDir(work));
    const capabilityFile = path.join(home, '.momonga', 'person-capability');
    await personCapabilityOf({ files: nodeFileSystem, random: systemRandom, lock: testKernelLock() }, home);
    const socketDirectory = path.join(home, '.momonga', 'run');
    fs.mkdirSync(socketDirectory, { recursive: true });
    const socket = path.join(socketDirectory, 'r.sock');
    const server = net.createServer((connection) => connection.end());
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const protection = childProtectionFor({ sandbox: 'none', home, platform: process.platform, env: {}, bubblewrap: process.platform === 'linux' });
    const transport: StdioTransport = createStdioTransport({
      name: 'probe',
      config: { command: process.execPath, args: ['-e', PROBE, capabilityFile, socket] },
      projectDir: work,
      baseEnv: { PATH: '/usr/bin:/bin' },
      files: nodeFileSystem,
      launch: {
        protection,
        commandOf: (argv) => protectionCommandOf(protection, { platform: process.platform, argv, scratch: [], sandboxExecPath: SANDBOX_EXEC, bwrapPath: DEFAULT_BWRAP_PATH }),
      },
    });
    cleanups.push(() => transport.close(0));
    await transport.start();
    await pollUntil(() => transport.diagnostics().stderrTail.includes('REPORT '), { description: 'the report of the probe', boundMs: REPORT_BOUND_MS });
    const report: unknown = JSON.parse(transport.diagnostics().stderrTail.split('REPORT ')[1]?.split('\n')[0] ?? '');
    expect(report).toEqual({ read: expect.stringMatching(/^(EPERM|EACCES|ENOENT)$/), connect: expect.stringMatching(/^(EPERM|EACCES|ENOENT|ECONNREFUSED)$/) });
    expect(report).not.toMatchObject({ read: 'opened' });
  });
});
