import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EXIT_RETIRED, FIRST_GENERATION, SWEEP_INTERVAL_MS, generationLayout } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, REAL_PROCESS_WAIT_MS } from '@momonga/testkit';
import { onCleanup } from '../process/helpers.ts';
import { PERSON_CAPABILITY_TEST_HEADER, personCapabilityFileOf } from '../service/helpers.ts';
import { launchRuntime, prepareStack, readDb, scriptedToolCall, startGateway, waitForCondition, waitForStatus } from '../process/run-helpers.ts';
import { mutableRole } from '../shared/mutable-role.ts';
import { systemTimers } from '../../src/service/timers.ts';
import type { ServiceTimers } from '../../src/service/timers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BYPASS = { permissionMode: 'bypassPermissions', bypassAllowed: true };
const FINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const HOST_SANDBOX = process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap';
const ROLE_TICKS_WAITED = 3;

const textReply = (text: string) => ({ kind: 'stream' as const, chunks: [{ delta: { role: 'assistant', content: text }, finishReason: 'stop' }] });

type Row = { step: boolean; job: boolean; request: boolean };

const ROWS: Row[] = [false, true].flatMap((step) => [false, true].flatMap((job) => [false, true].map((request) => ({ step, job, request }))));

const nameOf = ({ step, job, request }: Row): string => {
  const held = [step ? 'a step' : undefined, job ? 'an owned job' : undefined, request ? 'an open non-stream request' : undefined].filter((part) => part !== undefined);
  return held.length === 0 ? 'nothing but an open stream' : `${held.join(', ')} and an open stream`;
};

const openSocket = async (socketPath: string): Promise<net.Socket> => {
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.on('error', () => undefined);
  onCleanup(() => void socket.destroy());
  return socket;
};

const PARTIAL_BODY_BYTES = 64;

const CONTINUE_LINE = 'HTTP/1.1 100 Continue';

const openNonStreamRequest = async (socketPath: string, home: string): Promise<net.Socket> => {
  const socket = await openSocket(socketPath);
  const capability = fs.readFileSync(personCapabilityFileOf(home), 'utf8');
  let answered = '';
  socket.on('data', (chunk: Buffer) => {
    answered += chunk.toString('latin1');
  });
  socket.write(`POST /v1/sessions HTTP/1.1\r\nhost: runtime\r\n${PERSON_CAPABILITY_TEST_HEADER}: ${capability}\r\ncontent-type: application/json\r\nexpect: 100-continue\r\ncontent-length: ${PARTIAL_BODY_BYTES}\r\n\r\n`);
  await waitForCondition(() => answered.startsWith(CONTINUE_LINE), 'the service to take the request and ask for its body');
  socket.write('{"cwd":');
  return socket;
};

type RoleTickTimers = ServiceTimers & { roleTicks(): number };

const roleTickTimers = (role: { refreshes(): number }): RoleTickTimers => {
  let roleTicks = 0;
  return {
    setTimeout: (callback, ms) =>
      systemTimers.setTimeout(() => {
        const before = role.refreshes();
        callback();
        if (ms === SWEEP_INTERVAL_MS && role.refreshes() > before) roleTicks += 1;
      }, ms),
    clearTimeout: (handle) => systemTimers.clearTimeout(handle),
    monotonicMs: () => systemTimers.monotonicMs(),
    roleTicks: () => roleTicks,
  };
};

const roleTicksEnded = async (timers: RoleTickTimers, count: number): Promise<void> => {
  const started = timers.roleTicks();
  await waitForCondition(() => timers.roleTicks() > started + count, `${count} role ticks of the retiring runtime to end (the next one starts only after the last has settled)`);
};

const jobOf = (database: string): { status: string } | undefined => readDb<{ status: string }>(database, 'SELECT status FROM jobs')[0];

describe('T-I4-7 (17.1 "Exit", rules 3a and 3b): a retiring runtime exits exactly when it holds no step, no owned job and no open non-stream request', () => {
  it.each(ROWS.map((row) => ({ ...row, name: nameOf(row) })))('holding $name', async (row) => {
    const stack = await prepareStack((temp) => ({
      script: [
        scriptedToolCall('Bash', { command: `touch ${path.join(temp.project, 'job-started')}; while [ ! -e ${path.join(temp.root, 'go')} ]; do sleep 0.05; done`, run_in_background: true }),
        textReply('job started'),
        textReply('step done'),
      ],
    }));
    stack.settings({ sandbox: HOST_SANDBOX });
    await startGateway(stack.temp);
    const role = mutableRole('serving');
    let shutdowns = 0;
    const timers = roleTickTimers(role);
    const launched = await launchRuntime(stack.temp, { role: role.port, timers, requestShutdown: () => void (shutdowns += 1) });
    const socketPath = generationLayout(stack.temp.home, FIRST_GENERATION).sockets.runtime;
    const session = await launched.createSession(BYPASS);
    if (row.job) {
      const started = await launched.createRun(session.id, { input: 'start a job' });
      expect(await waitForStatus(stack.temp, started.id, FINAL)).toBe('COMPLETED');
      await waitForCondition(() => fs.existsSync(path.join(stack.temp.project, 'job-started')), 'the background job to start');
    }
    const stream = await launched.stream(`/v1/sessions/${session.id}/events`);
    onCleanup(() => stream.close());
    const hold = row.step ? stack.hold() : undefined;
    if (hold !== undefined) {
      await launched.createRun(session.id, { input: 'a step' });
      await hold.waitForRequest({ timeoutMs: REAL_PROCESS_WAIT_MS, description: 'the held model request' });
    }
    const request = row.request ? await openNonStreamRequest(socketPath, stack.temp.home) : undefined;

    role.set('retiring');
    await waitForCondition(() => launched.logger.entries.some((entry) => entry.msg === 'generation.retiring'), 'the runtime to learn it is retiring');
    const holdsSomething = row.step || row.job || row.request;
    if (!holdsSomething) {
      await waitForCondition(() => shutdowns === 1, 'the retiring runtime that holds nothing to ask for its shutdown');
    } else {
      await roleTicksEnded(timers, ROLE_TICKS_WAITED);
      expect(shutdowns).toBe(0);
      if (row.job) expect(jobOf(stack.temp.paths.databases.runtime)?.status).toBe('running');
      hold?.release();
      request?.destroy();
      if (row.job) fs.writeFileSync(path.join(stack.temp.root, 'go'), '');
      await waitForCondition(() => shutdowns === 1, 'the retiring runtime to ask for its shutdown once it holds nothing');
    }
    if (row.job) expect(jobOf(stack.temp.paths.databases.runtime)?.status).toBe('exited');
    expect(shutdowns).toBe(1);
    expect(await launched.handle.close()).toMatchObject({ clean: true, exitCode: EXIT_RETIRED });
  });
});
