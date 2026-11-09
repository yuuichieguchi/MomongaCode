import { CONTROL_REQUEST_TIMEOUT_MS, LOCAL_REQUEST_HEADERS_TIMEOUT_MS, SUPERVISOR_RESPONSE_BOUND_MS, ensureMomongaDirs, momongaPaths, fixedSocket } from '@momonga/foundation';
import { registerCleanup, withTempDir, firstGeneration } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { createSupervisorClient } from '../src/client/supervisor-client.ts';
import { startFakeSupervisor } from './fake-supervisor.ts';

describe('supervisor client response bound', () => {
  it('is the time the supervisor needs to read a request plus the time it waits on the runtime', () => {
    expect(SUPERVISOR_RESPONSE_BOUND_MS).toBe(CONTROL_REQUEST_TIMEOUT_MS + LOCAL_REQUEST_HEADERS_TIMEOUT_MS);
  });

  it('fails a shutdown request the supervisor never answers once the bound passes', async (context) => {
    const paths = momongaPaths(withTempDir(context, { asHome: true }));
    await ensureMomongaDirs(paths);
    const supervisor = await startFakeSupervisor({ paths, version: '1.2.3', unresponsiveShutdown: { onRequest: () => undefined } });
    registerCleanup(context, () => supervisor.stop());
    const client = createSupervisorClient({ resolveSocket: fixedSocket(firstGeneration(paths).sockets.supervisor), responseBoundMs: 50 });
    registerCleanup(context, () => client.close());

    await expect(client.shutdown()).rejects.toMatchObject({ code: 'UND_ERR_HEADERS_TIMEOUT' });
  });
});
