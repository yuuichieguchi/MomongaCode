import type { McpServerView } from '@momonga/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unusedMcpAdmin } from '../../runtime/test/service/helpers.ts';
import { listJobs } from '../src/commands/jobs.ts';
import { mcpList, mcpLogin } from '../src/commands/mcp.ts';
import { startRealRuntime } from './real-runtime.ts';
import type { RealRuntime } from './real-runtime.ts';

vi.mock('../src/daemon/ensure-daemon.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/ensure-daemon.ts')>()),
  ensureCurrentDaemon: async () => ({}),
  ensureSessionDaemon: async () => undefined,
}));

const opened: RealRuntime[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((runtime) => runtime.client.close()));
});

const SERVER: McpServerView = { name: 'remote', scope: 'user', transport: 'http', url: 'https://mcp.example.test/mcp', auth: 'authorized' };

const runtimeWithFolderServers = async () => {
  const asked: { cwd: string; env: Readonly<Record<string, string>> }[] = [];
  const runtime = await startRealRuntime({
    mcp: {
      ...unusedMcpAdmin,
      folderServers: (folder) => {
        asked.push(folder);
        return Promise.resolve([SERVER]);
      },
      startFolderAuthorization: (folder, name) => {
        asked.push(folder);
        return Promise.resolve({ server: name, status: 'completed', startedAt: 1, expiresAt: 2 });
      },
    },
  });
  opened.push(runtime);
  return { runtime, asked };
};

const storedSessions = (runtime: RealRuntime): number => runtime.service.store.listSessions({ limit: 10, cursor: null }).sessions.length;

describe('a command that only reads creates no session, and needs no model', () => {
  it('mcp list on an empty home prints the servers of the folder and stores no session', async () => {
    const { runtime, asked } = await runtimeWithFolderServers();

    expect(await mcpList(runtime.ports, runtime.paths, true)).toBe(0);

    expect(JSON.parse(runtime.stdout.join(''))).toEqual([SERVER]);
    expect(asked.map((folder) => folder.cwd)).toEqual([runtime.service.layout.projectReal]);
    expect(storedSessions(runtime)).toBe(0);
  });

  it('mcp login authorizes a server of the folder and stores no session', async () => {
    const { runtime, asked } = await runtimeWithFolderServers();

    expect(await mcpLogin(runtime.ports, runtime.paths, 'remote', { openBrowser: false, interrupt: new AbortController().signal })).toBe(0);

    expect(runtime.stdout.join('')).toBe('MCP server remote is authorized\n');
    expect(asked.map((folder) => folder.cwd)).toEqual([runtime.service.layout.projectReal]);
    expect(storedSessions(runtime)).toBe(0);
  });

  it('jobs in a folder with no run lists nothing, in both forms, and stores no session', async () => {
    const { runtime } = await runtimeWithFolderServers();

    expect(await listJobs(runtime.ports, runtime.paths, undefined, false)).toBe(0);
    expect(runtime.stdout.join('')).toBe(`no session of the folder ${runtime.service.layout.project} has a run, so there are no background jobs\n`);
    runtime.stdout.length = 0;
    expect(await listJobs(runtime.ports, runtime.paths, undefined, true)).toBe(0);
    expect(JSON.parse(runtime.stdout.join(''))).toEqual([]);
    expect(storedSessions(runtime)).toBe(0);
  });

  it('jobs does not take a session that never ran for the session to list', async () => {
    const { runtime } = await runtimeWithFolderServers();
    const worked = await runtime.service.createSession();
    await runtime.service.createRun(worked.id);
    runtime.service.clock.advance(1000);
    await runtime.service.createSession();

    expect(await listJobs(runtime.ports, runtime.paths, undefined, false)).toBe(0);

    expect(runtime.stdout.join('')).toBe(`session ${worked.id} has no background jobs\n`);
  });
});
