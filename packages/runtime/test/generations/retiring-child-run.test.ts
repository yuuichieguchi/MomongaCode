import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, generationLayout } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, REAL_PROCESS_WAIT_MS } from '@momonga/testkit';
import { launchRuntime, prepareStack, readDb, scriptedToolCall, startGateway, waitForCondition, waitForStatus } from '../process/run-helpers.ts';
import { mutableRole } from '../shared/mutable-role.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

const textReply = (text: string) => ({ kind: 'stream' as const, chunks: [{ delta: { role: 'assistant', content: text }, finishReason: 'stop' }] });

type RunRow = { id: string; status: string; lease_owner: string | null; lease_generation: number | null };

const runRow = (database: string, id: string): RunRow | undefined => readDb<RunRow>(database, 'SELECT id, status, lease_owner, lease_generation FROM runs WHERE id = ?', id)[0];

const childOf = (database: string, parentId: string): RunRow | undefined =>
  readDb<RunRow>(database, 'SELECT id, status, lease_owner, lease_generation FROM runs WHERE parent_run_id = ?', parentId)[0];

describe('T-I4-27 (17.1 table): the subagent a step asks for in a retiring runtime is a queued row that the serving generation claims', () => {
  it('starts no child in the retiring generation, leaves the parent queued with no lease, and the serving generation claims the parent and its child and runs both', async () => {
    const stack = await prepareStack({
      script: [scriptedToolCall('Agent', { description: 'work', prompt: 'Do it', subagent_type: 'worker' }), textReply('child done'), textReply('parent done')],
    });
    fs.mkdirSync(stack.temp.paths.agents, { recursive: true });
    fs.writeFileSync(path.join(stack.temp.paths.agents, 'worker.md'), '---\nname: worker\ndescription: worker agent\n---\nYou do the work.\n');
    await startGateway(stack.temp);
    const database = stack.temp.paths.databases.runtime;
    const first = mutableRole('serving');
    const older = await launchRuntime(stack.temp, { role: first.port });
    const parentHold = stack.hold();
    const session = await older.createSession({ permissionMode: 'bypassPermissions', bypassAllowed: true });
    const parent = await older.createRun(session.id, { input: 'delegate the work' });
    await parentHold.waitForRequest({ timeoutMs: REAL_PROCESS_WAIT_MS, description: 'the parent step to ask the model' });
    first.set('retiring');
    await waitForCondition(() => older.logger.entries.some((entry) => entry.msg === 'generation.retiring'), 'generation 1 to learn it is retiring');
    parentHold.release();

    await waitForCondition(() => older.logger.entries.some((entry) => entry.msg === 'generation.retired'), 'generation 1 to leave once its step ended');
    expect(childOf(database, parent.id)).toBeUndefined();
    expect(runRow(database, parent.id)).toMatchObject({ status: 'QUEUED', lease_owner: null, lease_generation: null });

    const childHold = stack.hold();
    const newer = await launchRuntime(stack.temp, { generation: 2, gatewaySocketPath: generationLayout(stack.temp.home, FIRST_GENERATION).sockets.gateway });
    await childHold.waitForRequest({ timeoutMs: REAL_PROCESS_WAIT_MS, description: 'the child run to ask the model in generation 2' });
    expect(childOf(database, parent.id)).toMatchObject({ status: 'RUNNING', lease_generation: 2 });
    childHold.release();

    const child = childOf(database, parent.id);
    if (child === undefined) throw new Error('the child run is gone');
    expect(await waitForStatus(stack.temp, child.id, FINAL)).toBe('COMPLETED');
    expect(await waitForStatus(stack.temp, parent.id, FINAL)).toBe('COMPLETED');
    await older.handle.close();
    await newer.handle.close();
  });
});
