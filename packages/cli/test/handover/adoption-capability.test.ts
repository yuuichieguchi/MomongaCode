import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { PERSON_CAPABILITY_HEADER } from '@momonga/protocol';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { createRuntimeClient } from '../../src/client/runtime-client.ts';
import { createHandoverHost } from '../../src/handover/host.ts';
import { HANDOVER_FORMAT, encodeRecord, recordFileOf } from '../../src/handover/record.ts';
import type { StreamRecord } from '../../src/handover/record.ts';
import { HANDOVER_FLAG, adoptionOf } from '../../src/handover/start.ts';
import { nodePorts } from '../../src/node-ports.ts';
import { runView } from '../fake-backend.ts';

const RECORD: StreamRecord = { format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4', session: 'session-1', lastSeq: { 'run-1': 4 }, kind: 'attach', runId: 'run-1', output: 'text', verbose: false };

const checkingRuntime = async (context: TestContext, capability: string): Promise<{ socket: string; presented: (string | undefined)[] }> => {
  const socket = path.join(withTempDir(context), 'runtime.sock');
  const presented: (string | undefined)[] = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const header = request.headers[PERSON_CAPABILITY_HEADER];
      presented.push(typeof header === 'string' ? header : undefined);
      if (header !== capability) response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'permission_error', code: 'not_the_person', message: 'refused' } }));
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ run: runView({ id: 'run-1', sessionId: 'session-1', status: 'RUNNING' }) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { socket, presented };
};

describe('the process that adopts a session reads the person capability from its own owner-only file (C14, runtime-service-W7)', () => {
  it('finds no capability in the record, and its runtime client presents the one of its home, so the runtime answers the adopted run', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const signal = new AbortController().signal;
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const runtimeHeld = await nodePorts('1.2.3', signal, home).personCapability(home);
    const file = recordFileOf(paths, 'attach', RECORD.session);
    const encoded = encodeRecord(RECORD, { writer: process.pid, reader: process.pid, namespace: 'single' });
    if (encoded.kind !== 'fits') throw new Error('the record did not fit');
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, encoded.text, { mode: 0o600 });
    expect(readFileSync(file, 'utf8')).not.toContain(runtimeHeld);

    const adopter = nodePorts('1.2.4', signal, home);
    const host = createHandoverHost({
      version: '1.2.4',
      parties: async () => ({ writer: process.pid, reader: process.pid, namespace: 'single' }),
      self: { kind: 'single-binary', execPath: '/unused/momonga' },
      argv: ['attach', HANDOVER_FLAG, file],
      env: {},
      execArgv: [],
      files: { read: (each) => readFileSync(each, 'utf8'), write: () => undefined, remove: () => undefined, handOver: () => undefined },
    });
    const adoption = adoptionOf(host.started, ['attach']);
    expect(adoption).toEqual({ kind: 'record', record: RECORD, file });

    const runtime = await checkingRuntime(context, runtimeHeld);
    const client = createRuntimeClient({ resolveSocket: async () => runtime.socket, clock: adopter.clock, personCapability: () => adopter.personCapability(home) });
    registerCleanup(context, () => client.close());
    const run = await client.getRun(RECORD.runId);

    expect(run.id).toBe('run-1');
    expect(runtime.presented).toEqual([runtimeHeld]);
  });
});
