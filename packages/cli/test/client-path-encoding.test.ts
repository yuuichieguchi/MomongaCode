import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { createRuntimeClient } from '../src/client/runtime-client.ts';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import { UsageError } from '../src/usage-error.ts';

const FAKE_PERSON_CAPABILITY = 'f'.repeat(32);

const OUTSIDE_ID = 'a/../b?c=d#e f';

const PLAIN_ID = 'PLAINID';

type Call = (client: RuntimeClient, id: string) => Promise<unknown>;

const ID_ROUTES: Readonly<Record<string, Call>> = {
  getSession: (client, id) => client.getSession(id),
  listRuns: (client, id) => client.listRuns(id),
  skills: (client, id) => client.skills(id),
  agents: (client, id) => client.agents(id),
  jobs: (client, id) => client.jobs(id),
  childRuns: (client, id) => client.childRuns(id),
  setMcpServers: (client, id) => client.setMcpServers(id, {}),
  setPermissionMode: (client, id) => client.setPermissionMode(id, 'manual'),
  setModel: (client, id) => client.setModel(id, 'm'),
  createRun: (client, id) => client.createRun(id, 'hello'),
  compact: (client, id) => client.compact(id),
  getRun: (client, id) => client.getRun(id),
  inboxAdd: (client, id) => client.inboxAdd(id, 'queue', 'text'),
  inboxWithdraw: (client, id) => client.inboxWithdraw(id),
  inboxList: (client, id) => client.inboxList(id),
  runSuccessor: (client, id) => client.runSuccessor(id),
  cancel: (client, id) => client.cancel(id),
  trace: (client, id) => client.trace(id),
  approvals: (client, id) => client.approvals(id),
  getApproval: (client, id) => client.getApproval(id),
  resolveApproval: (client, id) => client.resolveApproval(id, 'allow_once'),
  elicitations: (client, id) => client.elicitations(id),
  getElicitation: (client, id) => client.getElicitation(id),
  resolveElicitation: (client, id) => client.resolveElicitation(id, {}),
  mcpServers: (client, id) => client.mcpServers(id),
  startMcpAuthorization: (client, id) => client.startMcpAuthorization(id, 'server'),
  mcpAuthorization: (client, id) => client.mcpAuthorization(id, 'server'),
  cancelMcpAuthorization: (client, id) => client.cancelMcpAuthorization(id, 'server'),
  traceContent: (client, id) => client.traceContent(id, { after: 0, limit: 1 }),
  streamEvents: (client, id) => client.streamEvents(id).next(),
  streamSessionEvents: (client, id) => client.streamSessionEvents(id).next(),
  userShell: (client, id) => client.userShell(id, 'true', false, { onUnprotected: () => undefined, onOutput: () => undefined }),
  stopUserShell: (client, id) => client.stopUserShell(id),
  pendingUserShell: (client, id) => client.pendingUserShell(id),
  runAnsweredBy: (client, id) => client.runAnsweredBy(id),
  memory: (client, id) => client.memory(id),
  memoryJudgement: (client, id) => (client as RuntimeClient & { memoryJudgement(memoryId: string): Promise<unknown> }).memoryJudgement(id),
  retireRule: (client, id) => client.retireRule(id),
};

const recordingRuntime = async (context: TestContext): Promise<{ client: RuntimeClient; urls: string[] }> => {
  const socketPath = path.join(withTempDir(context), 'runtime.sock');
  const urls: string[] = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      urls.push(request.url ?? '');
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'server_error', code: 'scripted', message: 'scripted' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = createRuntimeClient({ personCapability: async () => FAKE_PERSON_CAPABILITY, resolveSocket: async () => socketPath, clock: { now: () => 0, sleep: async () => undefined } });
  registerCleanup(context, () => client.close());
  return { client, urls };
};

describe('an id from outside is one encoded segment of every request path of the runtime client', () => {
  it.for(Object.keys(ID_ROUTES))('%s sends an id that holds a slash, a parent step, a question mark and a hash as one segment', async (name, context) => {
    const { client, urls } = await recordingRuntime(context);
    const call = ID_ROUTES[name] as Call;

    await call(client, PLAIN_ID).catch(() => undefined);
    await call(client, OUTSIDE_ID).catch(() => undefined);

    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe((urls[0] as string).replace(PLAIN_ID, encodeURIComponent(OUTSIDE_ID)));
    expect((urls[1] as string).split('?')[0]?.split('/')).toHaveLength((urls[0] as string).split('?')[0]?.split('/').length ?? 0);
  });

  it.for(['', '.', '..'])('an id that is %j names no segment: the call is refused as a usage error and nothing is sent', async (id, context) => {
    const { client, urls } = await recordingRuntime(context);

    for (const call of Object.values(ID_ROUTES)) await expect((async () => call(client, id))()).rejects.toBeInstanceOf(UsageError);

    expect(urls).toEqual([]);
  });
});
